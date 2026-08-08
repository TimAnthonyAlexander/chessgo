// Typed client for the chessgo BaseAPI backend (SPEC §7 / VS-Bot endpoints).
import type { Variant } from '../lib/variants'

const BASE = import.meta.env.VITE_API_URL ?? 'http://127.0.0.1:6464'

export type Color = 'w' | 'b'

export type { Variant }

export type GameStatus =
    | 'ongoing'
    | 'checkmate'
    | 'stalemate'
    | 'draw-fifty'
    | 'draw-seventyfive'
    | 'draw-threefold-claimable'
    | 'draw-fivefold'
    | 'draw-insufficient-material'
    | 'draw-dead-position'
    // Duck Chess terminals (win by capturing the king; no check/checkmate).
    | 'white_win'
    | 'black_win'
    | 'draw'
    // Bot games only: a server-authoritative clock ran out (see BotGame.time_control).
    | 'timeout'

export interface MoveEntry {
    ply: number
    uci: string
    san: string
    by: 'human' | 'bot'
    fen: string // position after this move (for history navigation)
    eval?: { type: 'cp' | 'mate'; value: number }
    duck?: string // Duck Chess: the duck's square after this move
    // Secret Queen: present on the move that unmasked a hidden queen (either
    // side's) — a non-pawn move from its square, reaching the last rank, or
    // being captured while still hidden. `square` is where the reveal happened
    // (the capturing move's `to` for a capture, otherwise `moved`'s own square).
    reveal?: {
        moved: Color // whose secret queen was revealed
        captured: boolean // it came off the board as it revealed (see rule 7)
        promoted: boolean // it reached the last rank rather than moving as a queen
        square: string
    }
}

export interface BotGame {
    id: string
    // The strength the game was SET UP at. For fading/glassjaw this is only a
    // full-strength sentinel — read `effective_rating` to know how strong the
    // opponent actually is right now.
    rating: number
    // The Elo the bot will play its next move at, recomputed server-side from the
    // move history each time the game is serialized. Equals `rating` on every
    // variant except fading (−100 per bot move) and glassjaw (−300 per check).
    effective_rating: number
    human_color: Color
    variant: Variant
    fen: string
    side_to_move: Color
    status: GameStatus
    result: string | null
    moves: MoveEntry[]
    legal_moves: string[]
    your_turn: boolean
    duck: string | null // Duck Chess: the duck's square, or null before the first placement
    // Secret Queen: the human's OWN secret-queen square, or null once it's been
    // revealed, captured, or promoted. The bot's secret is never sent — the
    // server redacts it out of both this field and the trailing FEN suffix
    // before the payload leaves BotGameService::present(). Absent (undefined)
    // on every other variant.
    secret_square?: string | null
    // Clock (server-authoritative; the client only ticks a local display between
    // requests and re-syncs from these fields after every move). All null/absent
    // for an untimed game — time_control is the field to gate the clock UI on.
    time_control: string | null // e.g. "5+0", or null = untimed
    white_ms: number | null
    black_ms: number | null
    // Epoch-ms string (NOT a formatted date) marking when the side-to-move's
    // clock started counting down from white_ms/black_ms — see BotGame.php.
    last_move_at: string | null
}

class ApiError extends Error {
    constructor(
        message: string,
        readonly status: number,
    ) {
        super(message)
    }
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
    let res: Response
    try {
        res = await fetch(BASE + path, {
            ...init,
            credentials: 'include', // session cookie for authenticated endpoints
            headers: { 'Content-Type': 'application/json', ...(init?.headers ?? {}) },
        })
    } catch {
        throw new ApiError('Cannot reach the server. Is the API running on :6464?', 0)
    }
    const body = await res.json().catch(() => null)
    if (!res.ok) {
        const msg = (body && (body.error || body.message)) || `Request failed (${res.status})`
        throw new ApiError(msg, res.status)
    }
    return body as T
}

/** Create a bot game. `opts.fen` starts from a custom position (e.g. one carried
 * over from the analysis board); `opts.variant` selects a chess variant (default
 * standard); `opts.timeControl` is one of BotGame's TIME_CONTROLS (e.g. "5+0") —
 * omitted = untimed, the default. `opts.secretSquare` (Secret Queen only) is the
 * human's chosen home-rank pawn ("e2"); omitted, the server picks one at random
 * — never a fixed default, which would be readable by the opponent. Omitting
 * all = a standard untimed game from the normal start. */
export function createBotGame(
    rating: number,
    humanColor: Color,
    opts?: { fen?: string; variant?: Variant; timeControl?: string; secretSquare?: string },
): Promise<BotGame> {
    return request<BotGame>('/bot-games', {
        method: 'POST',
        body: JSON.stringify({
            rating,
            human_color: humanColor,
            ...(opts?.variant ? { variant: opts.variant } : {}),
            ...(opts?.fen ? { fen: opts.fen } : {}),
            ...(opts?.timeControl ? { time_control: opts.timeControl } : {}),
            ...(opts?.secretSquare ? { secret_square: opts.secretSquare } : {}),
        }),
    })
}

// --- Admin: engine vs engine (gomachine @ rating vs Stockfish @ Elo) ---

export type EngineSide = 'gomachine' | 'zugzwang' | 'stockfish'

export interface EngineVsMove {
    bestmove: string | null
    san: string | null
    fen: string | null
    status: GameStatus
    result: string | null
    sideToMove: Color | null
    claimableDraws: string[]
    eval: { type: 'cp' | 'mate'; value: number } | null
    by: EngineSide
    reason?: string
    // Variant-specific board state carried per ply (null for standard/chess960).
    duck?: string | null // Duck Chess: the duck's square after this ply
    pocket?: string | null // Crazyhouse: the canonical pocket string after this ply
}

/** The variants the admin engine-vs-engine view can drive. Standard is playable
 * by all engines; every other variant is gomachine/zugzwang only. */
export type EngineVsVariant = 'standard' | 'chess960' | 'crazyhouse' | 'duck' | 'antichess'

/** Admin-only: play one ply of gomachine/zugzwang(rating) vs Stockfish(elo) —
 * or gomachine vs zugzwang — and apply it. Any engine may play either side.
 *
 * The search budget is pinned to EXACTLY ONE dimension per side — send only the
 * active one (leave the others undefined/0): gomachine/zugzwang take movetime |
 * nodes | depth, Stockfish takes movetime | depth. `book`/`aggr` (gomachine/
 * zugzwang only) consult the opening book / set aggression on the rating path —
 * zugzwang's `/bestmove` accepts them for forward-compat even though they're
 * currently stubbed server-side. */
export function engineVsMove(params: {
    fen: string
    /** 'zugzwang-local' is the in-browser wasm engine — it has no server-side
     *  counterpart, so it must be paired with a `move` the client already chose. */
    side: EngineSide | 'zugzwang-local'
    /** A UCI move the CALLER already picked. When set the server searches nothing
     *  and only validates + applies it, returning the usual fen/san/status shape.
     *  Required for side 'zugzwang-local'. */
    move?: string
    variant?: EngineVsVariant // default 'standard'; chess960 rides the standard path
    duck?: string // Duck Chess only: the duck's current square ("" if unplaced)
    rating?: number
    elo?: number
    movetime?: number
    nodes?: number // gomachine/zugzwang only: fixed-nodes budget
    depth?: number // fixed-depth budget (any engine)
    aggr?: number // gomachine/zugzwang aggression style 0..100 (50 = neutral)
    book?: boolean // gomachine/zugzwang only: consult the opening book
}): Promise<EngineVsMove> {
    return request<EngineVsMove>('/admin/engine-vs/move', {
        method: 'POST',
        body: JSON.stringify(params),
    })
}

export function getBotGame(id: string): Promise<BotGame> {
    return request<BotGame>(`/bot-games/${id}`)
}

export function playMove(id: string, move: string): Promise<BotGame> {
    return request<BotGame>(`/bot-games/${id}/move`, {
        method: 'POST',
        body: JSON.stringify({ move }),
    })
}

/** Take back the human's last move, including any bot reply since. Returns the
 * game reverted to the human's turn in the position before that move. */
export function undoMove(id: string): Promise<BotGame> {
    return request<BotGame>(`/bot-games/${id}/undo`, { method: 'POST' })
}

// --- Guess the Elo ---------------------------------------------------------

/** One ply of a Guess-the-Elo round. Deliberately carries NO strength info — the
 * rating is the answer and lives only on the server until you guess. */
export interface GuessMove {
    ply: number
    uci: string
    san: string
    fen: string // position after this move
}

/** A generated Guess-the-Elo round: a full gomachine-vs-itself game at a secret
 * rating. The client only ever receives the moves — never the rating. */
export interface GuessRound {
    id: string
    startFen: string
    result: string | null
    status: GameStatus
    moves: GuessMove[]
}

/** The reveal, returned only after a guess is locked in. */
export interface GuessReveal {
    actual: number
    guess: number
    delta: number
    score: number
    result: string | null
}

/** Start a new round — the server plays out a full game at a hidden rating and
 * returns the moves to watch. Presented to the user as "loading a random game". */
export function guessEloNew(): Promise<GuessRound> {
    return request<GuessRound>('/guess-the-elo', { method: 'POST', body: '{}' })
}

/** Lock in a guess and reveal the true rating + score. Idempotent server-side:
 * a second call on the same round returns the first guess unchanged. */
export function guessEloGuess(id: string, guess: number): Promise<GuessReveal> {
    return request<GuessReveal>(`/guess-the-elo/${id}/guess`, {
        method: 'POST',
        body: JSON.stringify({ guess }),
    })
}

export interface Analysis {
    eval: { type: 'cp' | 'mate'; value: number } | null
    bestmove: string | null
    pv: string[] | null // principal variation (best line) as UCI moves from the position
    depth: number | null
    opening?: Opening | null // the CURRENT position's opening (pure book lookup, no search)
    lines?: AnalysisLine[] // multi-PV lines when multipv > 1, same depth as the main result
    // Where this response came from: 'cache' (eval_cache hit) or 'engine' (fresh
    // search). Optional so older/mocked responses without it still typecheck —
    // added for the in-browser engine feature, and read only to badge a displayed
    // cache result as Cloud. Purely informational: never used to gate
    // ladder/polling logic or to decide which engine owns a position.
    /** Where this came from: the server eval cache, a fresh engine search, or —
     *  only ever in reply to `cacheOnly` — nothing at all, meaning the server
     *  declined to search and `eval`/`depth` are null. */
    source?: 'cache' | 'engine' | 'miss'
}

export interface AnalysisLine {
    bestmove: string
    san: string
    eval: { type: 'cp' | 'mate'; value: number }
    pv: string[]
    depth: number
    opening?: Opening | null // the opening this move leads to (book lookup, null if unnamed)
}

/** Full-strength evaluation of a position (drives the eval bar, level-independent).
 *
 * Either bound trades depth for latency:
 *  - `movetime` (ms): search for a fixed budget — omit for the full-power default.
 *  - `depth`: search to a fixed ply depth (returns near-instantly at low depths,
 *    with a server-side time ceiling so a deep request can't hang). This is what
 *    drives the analysis board's progressive "streaming" deepening: call with
 *    1, 2, 3 … and render each result as it lands. The engine keeps its
 *    transposition table warm across these stateless calls, so each deeper step
 *    is cheap. When the returned `depth` is LESS than the requested depth, the
 *    time ceiling cut the search short — the opinion has settled; stop deepening.
 */
export function analyze(
    fen: string,
    opts?: {
        movetime?: number
        depth?: number
        multipv?: number
        history?: string[] // prior-position FENs (root→previous), for deepest-match opening naming
        /** Look the position up in the server's eval cache and NEVER start a
         *  search — `source: 'miss'` with a null eval when it isn't there. Sent
         *  once the user's local in-browser engine is doing the searching, so
         *  running one costs the server a row lookup instead of a depth ladder. */
        cacheOnly?: boolean
        signal?: AbortSignal
    },
): Promise<Analysis> {
    const body: {
        fen: string
        movetime?: number
        depth?: number
        multipv?: number
        history?: string[]
        cacheOnly?: boolean
    } = { fen }
    if (opts?.movetime) body.movetime = opts.movetime
    if (opts?.depth) body.depth = opts.depth
    if (opts?.multipv) body.multipv = opts.multipv
    if (opts?.history && opts.history.length > 0) body.history = opts.history
    if (opts?.cacheOnly) body.cacheOnly = true
    // `signal` lets a caller abort an in-flight request when it's no longer wanted —
    // the analysis board cancels the previous position's deepening when you move, so
    // the trailing deep call doesn't hog a browser connection / engine worker.
    return request<Analysis>('/analyze', {
        method: 'POST',
        body: JSON.stringify(body),
        signal: opts?.signal,
    })
}

export interface SfAnalysis {
    bestmove: string | null // UCI of Stockfish's full-strength best move
    san: string | null
    eval: { type: 'cp' | 'mate'; value: number } | null // side-to-move POV
}

/** Full-strength Stockfish best move for a position — the analysis board's
 * optional second-opinion arrow (to see where Stockfish and gomachine disagree).
 * Returns just the move; if Stockfish isn't available the request errors and the
 * caller simply omits the arrow. */
export function sfAnalyze(
    fen: string,
    opts?: { movetime?: number; signal?: AbortSignal },
): Promise<SfAnalysis> {
    const body: { fen: string; movetime?: number } = { fen }
    if (opts?.movetime) body.movetime = opts.movetime
    return request<SfAnalysis>('/sf-analyze', {
        method: 'POST',
        body: JSON.stringify(body),
        signal: opts?.signal,
    })
}

// --- Duck Chess (free-mode analysis board) ---
// The client has no duck rules — the engine owns them. These three public
// endpoints drive an interactive duck board: legal piece moves for a position,
// applying a composite "<pieceUci>:<duckSquare>" turn, and evaluating a position.

/** Legal PIECE moves (UCI) for a duck position. `duck` is the duck's current
 *  square, or "" before the first placement. */
export function duckLegalMoves(fen: string, duck: string): Promise<{ moves: string[] }> {
    return request<{ moves: string[] }>('/duck/legal-moves', {
        method: 'POST',
        body: JSON.stringify({ fen, duck }),
    })
}

/** Result of applying one duck turn (a composite "<pieceUci>:<duckSquare>"). On a
 *  legal move `moves` holds the NEXT position's piece moves when the game is still
 *  ongoing; on an illegal move `legal` is false and `error` explains why. */
export interface DuckPlayResult {
    legal: boolean
    error?: string
    newFen: string
    duck: string // the duck's square after this turn
    san: string // SAN of the completed turn (includes the duck glyph)
    sideToMove: Color
    status: GameStatus
    result: string | null
    moves: string[] // the next position's legal piece moves ([] if terminal)
}

/** Apply a composite duck turn to a position. The move is validated server-side. */
export function duckPlay(fen: string, duck: string, move: string): Promise<DuckPlayResult> {
    return request<DuckPlayResult>('/duck/move', {
        method: 'POST',
        body: JSON.stringify({ fen, duck, move }),
    })
}

/** Engine evaluation of a duck position (drives the free-mode eval bar + best-move
 *  arrow). `eval` is from the side-to-move's perspective; `bestmove` is a composite
 *  "<pieceUci>:<duckSquare>". Abortable via `signal` (like `analyze`). */
export interface DuckEval {
    eval: { type: 'cp' | 'mate'; value: number } | null
    bestmove: string | null
    bestSan: string | null
    sideToMove: Color
}

export function duckEval(
    fen: string,
    duck: string,
    opts?: {
        movetime?: number
        rating?: number
        depth?: number
        nodes?: number
        signal?: AbortSignal
    },
): Promise<DuckEval> {
    const body: {
        fen: string
        duck: string
        movetime?: number
        rating?: number
        depth?: number
        nodes?: number
    } = { fen, duck }
    if (opts?.movetime) body.movetime = opts.movetime
    if (opts?.rating) body.rating = opts.rating
    if (opts?.depth) body.depth = opts.depth
    if (opts?.nodes) body.nodes = opts.nodes
    return request<DuckEval>('/duck/analyze', {
        method: 'POST',
        body: JSON.stringify(body),
        signal: opts?.signal,
    })
}

// --- Antichess (best-move readout + free-mode analysis) ---
// The standard /analyze plays by standard rules, so for an antichess position it
// returns moves that ignore the compulsory-capture rule (frequently illegal) and
// scored the wrong way (antichess material is inverted). These go to the antichess
// engine instead, which returns a full-strength best LEGAL move + eval.

/** Engine evaluation of an antichess position. `eval` is from the side-to-move's
 *  perspective (positive = side to move is winning, i.e. on track to shed its
 *  pieces); `bestmove` is a plain UCI (with a `k` suffix for a king promotion). */
export interface AntichessEval {
    eval: { type: 'cp' | 'mate'; value: number } | null
    bestmove: string | null
    bestSan: string | null
    sideToMove: Color
}

export function antichessEval(
    fen: string,
    opts?: { movetime?: number; rating?: number; depth?: number; nodes?: number; signal?: AbortSignal },
): Promise<AntichessEval> {
    const body: { fen: string; movetime?: number; rating?: number; depth?: number; nodes?: number } = { fen }
    if (opts?.movetime) body.movetime = opts.movetime
    if (opts?.rating) body.rating = opts.rating
    if (opts?.depth) body.depth = opts.depth
    if (opts?.nodes) body.nodes = opts.nodes
    return request<AntichessEval>('/antichess/analyze', {
        method: 'POST',
        body: JSON.stringify(body),
        signal: opts?.signal,
    })
}

/** The opening of a line: ECO code + full name (e.g. "B90", "Sicilian … Najdorf"). */
export interface Opening {
    eco: string
    name: string
}

/** One candidate move with the engine's full-strength eval, for a per-move eval bar.
 * `eval` is from the side-to-move's perspective (like the engine line). */
export interface CandidateMove {
    uci: string
    san: string
    eval: { type: 'cp' | 'mate'; value: number }
    pv: string[]
    depth: number
    opening: Opening | null // the opening this move leads to (null if unnamed)
}

/** Opening explorer payload: the line's opening name + ranked candidate moves. */
export interface Candidates {
    opening: Opening | null
    moves: CandidateMove[]
}

/** Opening explorer for the analysis board — the engine owns naming AND the
 * per-move MultiPV eval. `history` is the prior-position FENs (root→previous) so
 * the engine resolves the DEEPEST named opening along the line. */
export function candidates(
    fen: string,
    opts?: {
        history?: string[]
        multipv?: number
        movetime?: number
        depth?: number
        signal?: AbortSignal
    },
): Promise<Candidates> {
    const body: {
        fen: string
        history?: string[]
        multipv?: number
        movetime?: number
        depth?: number
    } = { fen }
    if (opts?.history && opts.history.length > 0) body.history = opts.history
    if (opts?.multipv) body.multipv = opts.multipv
    if (opts?.movetime) body.movetime = opts.movetime
    if (opts?.depth) body.depth = opts.depth
    return request<Candidates>('/candidates', {
        method: 'POST',
        body: JSON.stringify(body),
        signal: opts?.signal,
    })
}

// --- Finished live games + post-game analysis (analysis board) ---

/** A persisted finished live game (GET /games/{id} by hub id). */
export interface LiveGameRecord {
    id: string
    hub_game_id: string
    pool: string
    category: string
    rated: boolean
    result: string
    reason: string
    white_name: string
    black_name: string
    white_is_bot: boolean
    black_is_bot: boolean
    white_rating_before: number | null
    white_rating_after: number | null
    black_rating_before: number | null
    black_rating_after: number | null
    ply: number
    moves: string[]
    sans: string[]
}

export function getGame(id: string): Promise<LiveGameRecord> {
    return request<LiveGameRecord>(`/games/${id}`)
}

export interface AnalysisEval {
    type: 'cp' | 'mate'
    white: number
}

export type AnalysisJudgment = 'best' | 'good' | 'inaccuracy' | 'mistake' | 'blunder'

export interface AnalysisMove {
    uci: string
    san: string
    color: Color
    cpLoss: number
    isBest: boolean
    judgment: AnalysisJudgment
}

export interface AnalysisPly {
    ply: number
    fen: string
    sideToMove: Color
    evalWhite: AnalysisEval | null
    bestUci: string | null
    bestSan: string | null
    bestPv: string[] // engine's best line from this position (UCI, bestUci first); [] if none
    bestDepth: number | null
    move?: AnalysisMove
    duck?: string // Duck Chess: the duck's square at this position ("" if unplaced)
}

export interface AnalysisSide {
    best: number
    good: number
    inaccuracy: number
    mistake: number
    blunder: number
    acpl: number
    accuracy: number
}

export interface GameAnalysis {
    version: number
    /** True when the game's variant (Chess960, Duck Chess) isn't analyzable by the
     *  standard engine — `plies` is empty and the client shows a notice instead. */
    unsupported?: boolean
    variant?: Variant
    hubGameId: string
    result: string
    reason: string
    pool: string
    rated: boolean
    whiteName: string
    blackName: string
    whiteIsBot: boolean
    blackIsBot: boolean
    startFen: string
    plies: AnalysisPly[]
    summary: { w: AnalysisSide; b: AnalysisSide }
}

/** Full-game engine analysis (per-ply eval, best move, blunders). Cached server-side. */
export function getGameAnalysis(id: string): Promise<GameAnalysis> {
    return request<GameAnalysis>(`/games/${id}/analysis`)
}

/** Same payload shape as {@link getGameAnalysis}, but for a game with no persisted
 * id (bot games, imported PGNs) — replays `moves` from `startFen` (default the
 * standard start) and analyzes it fresh. Never cached: every call is a ~2s engine
 * burst, so callers should fetch once and hold the result rather than re-fetching. */
export function analyzeGameMoves(moves: string[], startFen?: string): Promise<GameAnalysis> {
    const body: { moves: string[]; startFen?: string } = { moves }
    if (startFen) body.startFen = startFen
    return request<GameAnalysis>('/games/analysis', {
        method: 'POST',
        body: JSON.stringify(body),
    })
}

// --- Puzzles (Lichess-style training, SPEC §Puzzles) ---

/** A served puzzle. The opponent's setup move is already applied into `fen`
 * (`opponent_move` is provided so the UI can animate it); the solution line is
 * never sent. The player answers from `fen`, starting at `ply`. */
export interface PuzzleNext {
    id: string
    rating: number
    start_fen: string
    opponent_move: string
    fen: string
    color: Color
    legal_moves: string[]
    ply: number
}

export interface PuzzleRating {
    value: number
    delta: number
    games: number
    /** True when this attempt earned no rating change (a hint was used, or the
     *  puzzle was already attempted before) — see `reason`. */
    unrated: boolean
    reason: 'hint' | 'replay' | null
}

/** Result of submitting one player move. On a correct non-final move the
 * scripted opponent reply + next position are returned; on completion or a
 * wrong move the outcome (and, for logged-in solvers, the rating change). */
export interface PuzzleMoveResult {
    correct: boolean
    complete: boolean
    solved?: boolean
    /** True when the move wasn't the scripted line but the engine judged it just as
     *  good (an alternative mate / equally-winning best move) and counted it solved. */
    alternative?: boolean
    opponent_move?: string
    fen?: string
    legal_moves?: string[]
    ply?: number
    status?: GameStatus
    solution?: string[]
    themes?: string[]
    rating?: PuzzleRating | null
}

/** Serve the next puzzle near the solver's rating; optional theme filter.
 *  `exclude` withholds one puzzle id — the setup screen previews a sample
 *  position, and that one must never be dealt during the session it opened. */
export function nextPuzzle(theme?: string, exclude?: string): Promise<PuzzleNext> {
    const p = new URLSearchParams()
    if (theme) p.set('theme', theme)
    if (exclude) p.set('exclude', exclude)
    const q = p.toString()
    return request<PuzzleNext>(`/puzzles/next${q ? `?${q}` : ''}`)
}

/** Submit one player move (UCI) for validation against the hidden solution.
 *  `hinted` marks that a hint was shown before this move — the server records
 *  the attempt but applies no rating change. */
export function submitPuzzleMove(
    id: string,
    move: string,
    fen: string,
    ply: number,
    hinted = false,
): Promise<PuzzleMoveResult> {
    return request<PuzzleMoveResult>(`/puzzles/${id}/move`, {
        method: 'POST',
        body: JSON.stringify({ move, fen, ply, hinted }),
    })
}

export interface WsTicket {
    ticket: string
    wsUrl: string
    identity: { name: string; anon: boolean; rating: number }
}

/** A stable per-browser anonymous id, so the hub can reconnect/resume games. */
export function anonId(): string {
    try {
        let id = localStorage.getItem('chessgo.anonId')
        if (!id) {
            id = crypto.randomUUID()
            localStorage.setItem('chessgo.anonId', id)
        }
        return id
    } catch {
        return crypto.randomUUID()
    }
}

/** Mint a short-lived ticket + ws URL for the realtime hub. */
export function getWsTicket(): Promise<WsTicket> {
    return request<WsTicket>(`/ws-ticket?anon=${encodeURIComponent(anonId())}`)
}

export interface LobbyStats {
    playersOnline: number
    activeGames: number
}

/** Live lobby counts (players online + games in play) from the realtime hub. */
export function getStats(): Promise<LobbyStats> {
    return request<LobbyStats>('/stats')
}

// --- Watch (live spectating) ---

export interface LiveSide {
    name: string
    rating: number
    anon: boolean
    // Absent/empty for bots, anon players, and titleless accounts — never a
    // placeholder. Optional so an older cached client that doesn't request it
    // still types.
    title?: Title | null
}

/** One row of the Watch lobby: a live game with enough to render a preview. */
export interface LiveGameSummary {
    id: string
    pool: string
    rated: boolean
    white: LiveSide
    black: LiveSide
    fen: string
    sideToMove: Color
    lastMove: string // UCI of the last move, or "" at the start
    ply: number
    clockW: number // ms remaining (snapshot at poll time)
    clockB: number
}

export interface LiveGamesResult {
    games: LiveGameSummary[]
    max: number
}

/** Top live games for the Watch page. Polling this also signals the hub that
 * someone is watching, which is what keeps the self-play filler games running. */
export function getLiveGames(): Promise<LiveGamesResult> {
    return request<LiveGamesResult>('/watch')
}

// --- Accounts (session-cookie auth) ---

export type RatingCategory = 'bullet' | 'blitz' | 'rapid' | 'classical'

/** Player title (Lichess-style FIDE titles + our own "AM" staff joke title —
 *  see {@link Profile.title}). */
export type Title = 'GM' | 'IM' | 'FM' | 'CM' | 'NM' | 'WGM' | 'WIM' | 'WFM' | 'WCM' | 'AM'

export interface User {
    id: string
    name: string
    email: string
    role: string
    // The derived title (a real title wins; otherwise every admin shows "AM").
    // Always present in every account payload the server serializes.
    title: Title | null
    rating_bullet: number
    rating_blitz: number
    rating_rapid: number
    rating_classical: number
    games_bullet: number
    games_blitz: number
    games_rapid: number
    games_classical: number
    rating_puzzle: number
    games_puzzle: number
    // Chess960 — its own isolated rating pool (no time-control split). Standard
    // rules, but playing a position you've never seen is a different skill.
    rating_chess960: number
    games_chess960: number
    // Duck Chess — its own isolated rating pool (no time-control split).
    rating_duck: number
    games_duck: number
    // Crazyhouse — its own isolated rating pool (no time-control split).
    rating_crazyhouse: number
    games_crazyhouse: number
    // Antichess — its own isolated rating pool (no time-control split).
    rating_antichess: number
    games_antichess: number
    // Secret Queen — its own isolated rating pool (no time-control split).
    rating_secretqueen: number
    games_secretqueen: number
    // Per-category Glicko-2 provisional flag (RD > 110): the rating is still
    // settling and is shown with a "?". Keyed by category, incl. 'puzzle' + 'duck'.
    provisional: Record<string, boolean>
}

export function signup(name: string, email: string, password: string): Promise<User> {
    return request<User>('/auth/signup', {
        method: 'POST',
        body: JSON.stringify({ name, email, password }),
    })
}

export function login(email: string, password: string): Promise<User> {
    return request<User>('/auth/login', {
        method: 'POST',
        body: JSON.stringify({ email, password }),
    })
}

export function logout(): Promise<unknown> {
    return request('/auth/logout', { method: 'POST' })
}

/** Current user, or null if not logged in (401). Rethrows other errors. */
export async function me(): Promise<User | null> {
    try {
        const r = await request<{ user: User }>('/me')
        return r.user
    } catch (e) {
        if (e instanceof ApiError && e.status === 401) return null
        throw e
    }
}

// --- Player profiles (public; keyed by display name) ---

/** One time-control rating tile. `rd` drives the provisional "?" flag. */
export interface RatingTile {
    rating: number
    rd: number
    games: number
    provisional: boolean
    rated_at: string | null
}

export interface PuzzleProfile {
    rating: number
    rd: number
    games: number
    solved: number
    provisional: boolean
}

/** Win/loss/draw across all persisted games, from the player's own perspective. */
export interface ProfileRecord {
    wins: number
    losses: number
    draws: number
    total: number
}

/** A light history row (no moves/analysis — the board fetches those on open). */
export interface ProfileGame {
    id: string // hub game id — the analysis route key
    created_at: string
    category: string
    pool: string
    variant: Variant // 'standard' | 'chess960' | 'duck' | 'crazyhouse' | 'antichess' | 'fading' | 'glassjaw' | 'doublemove'
    rated: boolean
    result: string // '1-0' | '0-1' | '1/2-1/2'
    reason: string
    white_name: string
    black_name: string
    white_title: Title | null
    black_title: Title | null
    white_user_id: string | null
    black_user_id: string | null
    white_is_bot: boolean
    black_is_bot: boolean
    white_rating_before: number | null
    white_rating_after: number | null
    black_rating_before: number | null
    black_rating_after: number | null
    ply: number
}

/** "Playing now" — surfaced on the profile when the realtime hub reports this
 * account in a live game (ProfileController::liveGame()). */
export interface ProfileLiveGame {
    gameId: string
    pool: string
    opponent: { name: string; title: Title | null; rating: number }
}

export interface Profile {
    id: string
    name: string
    role: string
    // Derived title (a real title wins; otherwise admins show "AM"). Never
    // player-editable — see updateMyProfile() for the fields that are.
    title: Title | null
    bio: string | null
    // ISO-3166-1 alpha-2 code, or null. Render as the country's name — see
    // COUNTRY_NAMES in components/profile/shared.ts (no flags, text only).
    country: string | null
    created_at: string
    ratings: Record<RatingCategory, RatingTile>
    puzzle: PuzzleProfile
    // Chess960 rating tile (isolated pool, surfaced separately from time controls).
    chess960: RatingTile
    // Duck Chess rating tile (isolated pool, surfaced separately from time controls).
    duck: RatingTile
    // Crazyhouse rating tile — likewise its own isolated pool.
    crazyhouse: RatingTile
    // Antichess rating tile — likewise its own isolated pool.
    antichess: RatingTile
    record: ProfileRecord
    // Present iff the hub reports this account in a live game right now (null
    // otherwise, including whenever the hub is unreachable — never an error).
    live_game: ProfileLiveGame | null
    // First page of game history + the total count, so the paginator can render
    // page numbers without a second request on load.
    games: ProfileGame[]
    gamesTotal: number
    gamesPerPage: number
    // Per-pool rating trend (oldest -> newest ratings-after), keyed by
    // RatingCategory plus 'puzzle' | 'chess960' | 'duck' | 'crazyhouse' |
    // 'antichess'. Feeds every sparkline in the ratings panel.
    ratingHistory: Record<string, number[]>
}

/** Public profile by display name (ratings + record + first page of games). */
export function getProfile(name: string): Promise<Profile> {
    return request<Profile>(`/users/${encodeURIComponent(name)}`)
}

export interface ProfileGamesPage {
    games: ProfileGame[]
    page: number
    perPage: number
    total: number
}

/** Extra server-side filters for {@link getProfileGames}: an opponent name
 * substring and an inclusive from/to date range ('YYYY-MM-DD'). Every field is
 * optional and composes with the `category`/`result` filters and each other. */
export interface ProfileGamesFilters {
    opponent?: string
    from?: string
    to?: string
}

/** A single (1-based) page of a player's game history, filtered server-side by
 * pool category and/or result (empty/`'all'` means no filter on that axis), plus
 * an optional opponent-name search and date range. */
export function getProfileGames(
    name: string,
    page: number,
    category = '',
    result = '',
    filters: ProfileGamesFilters = {},
): Promise<ProfileGamesPage> {
    const params = new URLSearchParams({ page: String(page) })
    if (category && category !== 'all') params.set('category', category)
    if (result && result !== 'all') params.set('result', result)
    if (filters.opponent) params.set('opponent', filters.opponent)
    if (filters.from) params.set('from', filters.from)
    if (filters.to) params.set('to', filters.to)
    return request<ProfileGamesPage>(
        `/users/${encodeURIComponent(name)}/games?${params.toString()}`,
    )
}

export interface ProfileUpdateResult {
    id: string
    name: string
    title: Title | null
    bio: string | null
    country: string | null
}

/** Self-service profile edit (the authenticated user only). Both fields are
 * nullable/clearable — pass `null` (or omit) to clear one. `title` is never
 * editable here; it's staff-assigned or derived for admins. */
export function updateMyProfile(fields: {
    bio?: string | null
    country?: string | null
}): Promise<ProfileUpdateResult> {
    return request<ProfileUpdateResult>('/me/profile', {
        method: 'POST',
        body: JSON.stringify(fields),
    })
}

// --- Leaderboard (per-category top players) ---

/** One leaderboard row (public-safe; no email). `provisional` = RD still high. */
export interface LeaderboardEntry {
    rank: number
    id: string
    name: string
    title: Title | null
    rating: number
    games: number
    provisional: boolean
}

export type LeaderboardCategory = RatingCategory | 'puzzle' | 'chess960' | 'duck' | 'antichess'

export interface LeaderboardResult {
    category: LeaderboardCategory
    entries: LeaderboardEntry[]
}

/** Top players for a single rating category (the four time controls, puzzle, or an
 * isolated variant pool). Must stay in sync with LeaderboardController::CATEGORIES —
 * anything else is rejected there, never interpolated into the column names. */
export function getLeaderboard(category: LeaderboardCategory): Promise<LeaderboardResult> {
    return request<LeaderboardResult>(`/leaderboard?category=${encodeURIComponent(category)}`)
}

// --- Daily puzzle (one stable puzzle per day, for the homepage widget) ---

/** The puzzle of the day. Same shape as a served `PuzzleNext` (the opponent's
 * setup move is already applied into `fen`; the solution line is never sent),
 * plus the puzzle's themes for display. Solve via `submitPuzzleMove`. */
export interface DailyPuzzle {
    id: string
    rating: number
    start_fen: string
    opponent_move: string
    fen: string
    color: Color
    legal_moves: string[]
    ply: number
    themes: string[]
}

/** The same puzzle for everyone for the whole UTC day (deterministic by date). */
export function getDailyPuzzle(): Promise<DailyPuzzle> {
    return request<DailyPuzzle>('/puzzles/daily')
}

// --- The Flame (daily-activity streak, homepage widget) ---

/** The current user's daily-activity streak. `current` is the live streak (0 once
 * a miss has broken it, before the next action resets it); `activeToday` is true
 * once today already qualifies. Anonymous callers get a neutral zeroed streak. */
export interface Streak {
    current: number
    longest: number
    lastActiveDate: string | null
    freezeTokens: number
    activeToday: boolean
}

/** Read the signed-in user's Flame streak (neutral/empty when not signed in). */
export function getStreak(): Promise<Streak> {
    return request<Streak>('/streak')
}

// --- Admin panel (admin-gated; SPEC §Admin). Payloads are UNWRAPPED (top-level
// keys, no `.data`). Every endpoint below is guarded server-side by AdminGuard. ---

/** One finished-game summary row (the shape `Game::summaryRow()` returns). It is
 * byte-identical to a {@link ProfileGame}, so the admin surfaces reuse that type
 * under a name that reads clearly at the anti-cheat call sites. */
export type GameSummaryRow = ProfileGame

/** Per-side accuracy breakdown of a scanned game — identical to the analysis
 * board's {@link AnalysisSide} (best/good/…/acpl/accuracy). */
export type AcSideSummary = AnalysisSide

export type SortDir = 'asc' | 'desc'

// --- Admin dashboard ---

export interface AdminDashboard {
    users: {
        total: number
        admins: number
        active: number
        banned: number
        new_7d: number
    }
    games: {
        total: number
        rated: number
        scanned: number
        unscanned: number
    }
    anticheat: {
        flagged_users_total: number
        by_status: {
            open: number
            reviewing: number
            cleared: number
            banned: number
        }
        flag_events_total: number
        events_by_category: {
            analysis_during_game: number
            rating_velocity: number
            move_time_anomaly: number
            engine_correlation: number
            accuracy_rating_mismatch: number
        }
    }
    live: {
        players_online: number
        active_games: number
    }
}

/** Aggregate counts for the admin dashboard (users, games, anti-cheat, live lobby). */
export function getAdminDashboard(): Promise<AdminDashboard> {
    return request<AdminDashboard>('/admin/dashboard')
}

// --- Admin users directory ---

export type AdminUserSort =
    'created_at' | 'name' | 'rating_bullet' | 'rating_blitz' | 'rating_rapid' | 'rating_classical'
export type AdminUserRole = 'user' | 'admin'
export type AdminUserStatus = 'active' | 'banned'

/** One row of the admin user directory. */
export interface AdminUserRow {
    id: string
    name: string
    title: Title | null
    email: string
    role: string
    active: boolean
    created_at: string
    rating_bullet: number
    rating_blitz: number
    rating_rapid: number
    rating_classical: number
    games_bullet: number
    games_blitz: number
    games_rapid: number
    games_classical: number
    flagged: boolean
    flag_status: string | null
    total_flags: number
}

export interface AdminUsersPage {
    users: AdminUserRow[]
    page: number
    perPage: number
    total: number
}

/** The full account record for the detail view (the User model serialized with
 * its password hash stripped): every {@link User} field plus admin-only columns. */
export interface AdminUserRecord extends User {
    active: boolean
    created_at: string
    updated_at?: string
}

export interface AdminUserDetail {
    user: AdminUserRecord
    flag_rollup: FlaggedUserRollup | null
    recent_games: GameSummaryRow[]
}

export interface AdminUsersParams {
    q?: string
    page?: number
    sort?: AdminUserSort
    dir?: SortDir
    role?: AdminUserRole
    status?: AdminUserStatus
}

/** Filtered, sorted, paginated admin user directory. */
export function getAdminUsers(params: AdminUsersParams = {}): Promise<AdminUsersPage> {
    const qs = new URLSearchParams()
    if (params.q) qs.set('q', params.q)
    if (params.page) qs.set('page', String(params.page))
    if (params.sort) qs.set('sort', params.sort)
    if (params.dir) qs.set('dir', params.dir)
    if (params.role) qs.set('role', params.role)
    if (params.status) qs.set('status', params.status)
    const suffix = qs.toString() ? `?${qs.toString()}` : ''
    return request<AdminUsersPage>(`/admin/users${suffix}`)
}

/** One account (full, password-stripped) + flag rollup + recent games. */
export function getAdminUser(id: string): Promise<AdminUserDetail> {
    return request<AdminUserDetail>(`/admin/users/${encodeURIComponent(id)}`)
}

// --- Admin games log ---

/** Bot/human axis of the persisted-game log. `bot` = either side is a fill-in
 * bot; `human` = both sides are real players; `all` = no constraint. */
export type AdminGameFilter = 'all' | 'bot' | 'human'

/** Optional category/pool axis (a stored `Game.category` value). */
export type AdminGameCategory = 'all' | 'bullet' | 'blitz' | 'rapid' | 'classical' | 'duck'

// A games-log row is `Game::summaryRow()` (the same shape the profile and
// anti-cheat surfaces consume — it carries `white_is_bot` / `black_is_bot`) plus
// a `seeded` flag the admin endpoint derives from the `seedgame-` hub_game_id
// prefix, so locally-seeded dev games can be badged when shown.
export type AdminGameRow = GameSummaryRow & { seeded: boolean }

export interface AdminGamesPage {
    games: AdminGameRow[]
    page: number
    perPage: number
    total: number
}

export interface AdminGamesParams {
    page?: number
    filter?: AdminGameFilter
    category?: AdminGameCategory
    /** Include locally-seeded dev games (hidden by default). */
    includeSeeded?: boolean
}

/** Newest-first, paginated persisted-game log, filterable by bot/human + category.
 * Locally-seeded dev games are hidden unless `includeSeeded` is set. */
export function getAdminGames(params: AdminGamesParams = {}): Promise<AdminGamesPage> {
    const qs = new URLSearchParams()
    if (params.page) qs.set('page', String(params.page))
    if (params.filter && params.filter !== 'all') qs.set('filter', params.filter)
    if (params.category && params.category !== 'all') qs.set('category', params.category)
    if (params.includeSeeded) qs.set('include_seeded', '1')
    const suffix = qs.toString() ? `?${qs.toString()}` : ''
    return request<AdminGamesPage>(`/admin/games${suffix}`)
}

// --- Admin anti-cheat: flagged users ---

export type FlagStatus = 'open' | 'reviewing' | 'cleared' | 'banned'
export type FlagSeverity = 'low' | 'medium' | 'high'
export type FlagSortKey = 'total_flags' | 'top_severity' | 'last_flagged_at'

/** A per-user rollup of flag events: how many, of what kind, and the human verdict. */
export interface FlaggedUserRollup {
    user_id: string
    user_name: string
    user_title: Title | null
    total_flags: number
    counts: Record<string, number>
    status: FlagStatus
    top_severity: FlagSeverity
    last_category: string
    first_flagged_at: string
    last_flagged_at: string
}

/** One anti-cheat flag event. `user_id` is present on the per-game endpoint and
 * omitted on the flagged-user detail events (which are already scoped to a user). */
export interface FlagEvent {
    id: string
    user_id?: string
    category: string
    severity: FlagSeverity
    detail: string
    meta: Record<string, unknown>
    reviewed: boolean
    created_at: string
}

export interface FlaggedUsersPage {
    flagged: FlaggedUserRollup[]
    page: number
    perPage: number
    total: number
}

/** A flagged user's rollup plus their recent flag events (the review detail view).
 * Note: unlike the rollup, this omits `last_category` and carries the `events`. */
export interface FlaggedUserDetail {
    user_id: string
    user_name: string
    user_title: Title | null
    total_flags: number
    counts: Record<string, number>
    status: FlagStatus
    top_severity: FlagSeverity
    first_flagged_at: string
    last_flagged_at: string
    events: FlagEvent[]
}

export interface FlaggedUsersParams {
    status?: FlagStatus
    sort?: FlagSortKey
    dir?: SortDir
    page?: number
}

/** The anti-cheat review queue: flagged users, filterable by verdict status. */
export function getFlaggedUsers(params: FlaggedUsersParams = {}): Promise<FlaggedUsersPage> {
    const qs = new URLSearchParams()
    if (params.status) qs.set('status', params.status)
    if (params.sort) qs.set('sort', params.sort)
    if (params.dir) qs.set('dir', params.dir)
    if (params.page) qs.set('page', String(params.page))
    const suffix = qs.toString() ? `?${qs.toString()}` : ''
    return request<FlaggedUsersPage>(`/admin/flags${suffix}`)
}

/** One flagged user's rollup + recent flag events. */
export function getFlaggedUser(userId: string): Promise<FlaggedUserDetail> {
    return request<FlaggedUserDetail>(`/admin/flags/${encodeURIComponent(userId)}`)
}

export interface FlagVerdictResult {
    user_id: string
    status: string
    banned: boolean
    reinstated: boolean
}

/** Set the account-level anti-cheat verdict. `status` is the admin's call
 * ('open'|'reviewing'|'cleared'|'banned'); `ban:true` (or status 'banned') also
 * deactivates the account, and an explicit `ban:false` reinstates it. */
export function setFlagVerdict(
    userId: string,
    body: { status?: string; ban?: boolean },
): Promise<FlagVerdictResult> {
    return request<FlagVerdictResult>(`/admin/flags/${encodeURIComponent(userId)}`, {
        method: 'POST',
        body: JSON.stringify(body),
    })
}

export interface FlagEventReviewResult {
    id: string
    user_id: string
    reviewed: boolean
}

/** Mark a single flag event reviewed/unreviewed (the event must belong to the user). */
export function setFlagEventReviewed(
    userId: string,
    eventId: string,
    reviewed: boolean,
): Promise<FlagEventReviewResult> {
    return request<FlagEventReviewResult>(
        `/admin/flags/${encodeURIComponent(userId)}/events/${encodeURIComponent(eventId)}`,
        { method: 'POST', body: JSON.stringify({ reviewed }) },
    )
}

// --- Admin per-game anti-cheat telemetry ---

export interface GameAnticheat {
    game: GameSummaryRow
    move_times: number[]
    ac_scanned: boolean
    analysis_summary: { w: AcSideSummary; b: AcSideSummary } | null
    flags_for_game: FlagEvent[]
}

/** Per-game anti-cheat telemetry: move times, cached accuracy summary, and any
 * flag events tied to this game. `{id}` is the hub game id. */
export function getGameAnticheat(id: string): Promise<GameAnticheat> {
    return request<GameAnticheat>(`/admin/games/${encodeURIComponent(id)}/anticheat`)
}

export { ApiError }

// --- Friends, notifications, directed challenges ---
// See routes/api.php's "Friends, notifications, directed challenges" block +
// the Friend/Notification/Challenge controllers for the exact server contract.

/** One row of the accepted-friends list (`GET /friends`). `ratingCategory` is
 * whichever time control the friend has played the most games in — the same
 * category `rating` is drawn from. `linkId` is the FriendLink row id — pass it
 * to {@link removeFriend} to unfriend. `userId` is the friend's own account id
 * (for the profile link), never the same id space as `linkId`. */
export interface FriendRow {
    linkId: string
    userId: string
    name: string
    title: Title | null
    rating: number
    ratingCategory: RatingCategory
    online: boolean
}

export function getFriends(): Promise<{ friends: FriendRow[] }> {
    return request<{ friends: FriendRow[] }>('/friends')
}

/** Send a friend request by username. The server auto-accepts a mutual pending
 * request instead of creating a duplicate — read `status` to tell which
 * happened ('pending' | 'accepted'). Throws ApiError on: not found (404),
 * self-friend (400), already friends (409). */
export function addFriend(name: string): Promise<{ status: 'pending' | 'accepted' }> {
    return request('/friends', { method: 'POST', body: JSON.stringify({ name }) })
}

/** Unfriend an accepted link, or cancel your own outgoing request — same
 * endpoint, keyed by the FriendLink id (not the other user's id). */
export function removeFriend(linkId: string): Promise<{ deleted: boolean }> {
    return request(`/friends/${encodeURIComponent(linkId)}`, { method: 'DELETE' })
}

/** One pending FriendLink, shaped for display (the OTHER side's identity). */
export interface FriendRequestRow {
    id: string
    userId: string
    name: string | null
    title: Title | null
    createdAt: string
}

export function getFriendRequests(): Promise<{
    incoming: FriendRequestRow[]
    outgoing: FriendRequestRow[]
}> {
    return request('/friends/requests')
}

/** Accept an incoming friend request — addressee only. */
export function acceptFriendRequest(linkId: string): Promise<{ status: 'accepted' }> {
    return request(`/friends/${encodeURIComponent(linkId)}/accept`, { method: 'POST' })
}

/** Decline an incoming friend request — addressee only. */
export function declineFriendRequest(linkId: string): Promise<{ status: 'declined' }> {
    return request(`/friends/${encodeURIComponent(linkId)}/decline`, { method: 'POST' })
}

/** In-app notification kinds — see Notification.php's docblock. */
export type NotificationType =
    | 'friend_request'
    | 'friend_accepted'
    | 'challenge'
    | 'challenge_accepted'
    | 'challenge_declined'

/** Notification payload shapes, keyed by `type`. Every payload carries at
 * least `userId` (who caused it); challenge-flavoured ones also carry
 * `challengeId`, and `challenge_accepted` carries the join `code`. */
export interface NotificationPayload {
    userId?: string
    challengeId?: string
    pool?: string
    variant?: Variant
    code?: string
}

export interface NotificationItem {
    id: string
    user_id: string
    type: NotificationType
    payload: NotificationPayload
    read_at: string | null
    created_at: string
}

/** Recent notifications, newest first (capped server-side at 50) + an
 * always-accurate unread count (not just of the capped page). */
export function getNotifications(): Promise<{ items: NotificationItem[]; unread: number }> {
    return request('/notifications')
}

/** Mark specific notifications read (ids the caller doesn't own are silently skipped). */
export function markNotificationsRead(ids: string[]): Promise<{ updated: number }> {
    return request('/notifications/read', { method: 'POST', body: JSON.stringify({ ids }) })
}

/** Mark every unread notification for the caller as read. */
export function markAllNotificationsRead(): Promise<{ updated: number }> {
    return request('/notifications/read-all', { method: 'POST' })
}

/** Directed-challenge variants (ChallengeController::VARIANTS). */
export type ChallengeVariant = 'standard' | 'chess960' | 'duck' | 'crazyhouse' | 'antichess'

/** One directed, persistent challenge, shaped for display (the OTHER side's
 * identity + the game terms). */
export interface ChallengeRow {
    id: string
    userId: string
    name: string | null
    rating: number | null
    pool: string
    color: 'w' | 'b' | 'random'
    rated: boolean
    variant: ChallengeVariant
    fen: string | null
    expiresAt: string
    createdAt: string
}

/** Send a directed challenge to a specific username. Throws ApiError on: not
 * found (404), self-challenge (400), invalid pool (400). */
export function createChallenge(opts: {
    name: string
    pool: string
    color?: 'w' | 'b' | 'random'
    rated?: boolean
    variant?: ChallengeVariant
    fen?: string
}): Promise<{ id: string }> {
    return request('/challenges', {
        method: 'POST',
        body: JSON.stringify({
            name: opts.name,
            pool: opts.pool,
            color: opts.color ?? 'random',
            rated: opts.rated ?? true,
            variant: opts.variant ?? 'standard',
            ...(opts.fen ? { fen: opts.fen } : {}),
        }),
    })
}

export function getChallenges(): Promise<{ incoming: ChallengeRow[]; outgoing: ChallengeRow[] }> {
    return request('/challenges')
}

/** Cancel a pending outgoing challenge — challenger only. */
export function cancelChallenge(id: string): Promise<{ status: 'cancelled' }> {
    return request(`/challenges/${encodeURIComponent(id)}`, { method: 'DELETE' })
}

/** Accept an incoming challenge — opponent only. Mints a hub join code; the
 * caller should navigate to `/challenge/{code}` with it. */
export function acceptChallenge(id: string): Promise<{ code: string }> {
    return request(`/challenges/${encodeURIComponent(id)}/accept`, { method: 'POST' })
}

/** Decline an incoming challenge — opponent only. */
export function declineChallenge(id: string): Promise<{ status: 'declined' }> {
    return request(`/challenges/${encodeURIComponent(id)}/decline`, { method: 'POST' })
}

// --- Arena tournaments (Lichess-style) ---

/** Variants a tournament can run (TournamentController::VARIANTS). */
export type TournamentVariant = 'standard' | 'chess960' | 'duck' | 'crazyhouse' | 'antichess'

export type TournamentStatus = 'scheduled' | 'running' | 'finished'

/** The automated rota a tournament was spawned from, or `null` for a
 * hand-created one-off (TournamentController::summaryRow's `series`). Used
 * purely for display weight (a named/rare event vs. hourly furniture) — never
 * as a per-series color. */
export type TournamentSeries =
    | 'hourly'
    | 'variant-hourly'
    | 'daily'
    | 'weekly'
    | 'titled-tuesday'
    | 'monthly'
    | null

/** One tournament's public summary — the shape both the list and the detail's
 * own `tournament` field share (TournamentController::summaryRow). `starts_at`
 * is a "Y-m-d H:i:s" string in UTC (see Tournament::$starts_at); `ends_at_ms`
 * is already a resolved epoch-ms integer, so prefer it over deriving an end
 * time from starts_at + duration. */
export interface TournamentSummary {
    id: string
    name: string
    variant: TournamentVariant
    pool: string
    starts_at: string
    duration_minutes: number
    rated: boolean
    status: TournamentStatus
    ends_at_ms: number
    player_count: number
    series: TournamentSeries
    min_rating: number | null
    max_rating: number | null
    titled_only: boolean
}

/** Upcoming + running + recently-finished tournaments, hub-sorted (running
 * first, then scheduled soonest-first, then finished most-recent-first). */
export function getTournaments(): Promise<{ tournaments: TournamentSummary[] }> {
    return request('/tournaments')
}

export interface TournamentStanding {
    user_id: string
    name: string | null
    title: Title | null
    score: number
    games: number
    withdrawn: boolean
}

export interface TournamentDetail {
    tournament: TournamentSummary
    standings: TournamentStanding[]
}

export function getTournament(id: string): Promise<TournamentDetail> {
    return request(`/tournaments/${encodeURIComponent(id)}`)
}

/** Admin-only: create a scheduled arena. `starts_at` should be a full ISO
 * datetime string (e.g. `new Date(...).toISOString()`) — the server parses it
 * with `strtotime` (any timezone-qualified format works) and stores it back
 * in its own UTC wall-clock form. */
export function createTournament(opts: {
    name: string
    variant: TournamentVariant
    pool: string
    starts_at: string
    duration_minutes: number
    rated: boolean
}): Promise<TournamentSummary> {
    return request('/tournaments', { method: 'POST', body: JSON.stringify(opts) })
}

/** Join a scheduled or running tournament (idempotent; also clears a prior
 * withdrawal). Requires auth. */
export function joinTournament(id: string): Promise<{ joined: boolean }> {
    return request(`/tournaments/${encodeURIComponent(id)}/join`, { method: 'POST' })
}

/** Withdraw from a tournament — a no-op (not an error) if never joined. */
export function withdrawTournament(id: string): Promise<{ withdrawn: boolean }> {
    return request(`/tournaments/${encodeURIComponent(id)}/withdraw`, { method: 'POST' })
}

/** One side of a live in-tournament game (TournamentGamesController — no
 * `bot` flag, that's server-side only). */
export interface ArenaGameSide {
    name: string | null
    rating: number | null
    title: Title | null
}

/** One live game currently being played inside a tournament, most-interesting
 * first, capped at 20 by the hub. */
export interface ArenaGame {
    gameId: string
    pool: string
    variant: TournamentVariant
    ply: number
    white: ArenaGameSide
    black: ArenaGameSide
}

/** Games in progress inside one tournament right now — proxies the realtime
 * hub, empty (never an error) if it's unreachable or nothing is live. */
export function getTournamentGames(id: string): Promise<{ games: ArenaGame[] }> {
    return request(`/tournaments/${encodeURIComponent(id)}/games`)
}

// --- Tutor: the player report card (docs/tasks/open/tutor.md) ---

/** How a measured value compares to players in the same rating band. Every
 *  Tutor number is relative — an absolute accuracy figure says nothing, and
 *  "below other 1500s" is the only form that's actionable. */
export interface TutorComparison {
    metric: string
    /** '' for a plain metric, else a qualifier: 'phase:endgame', 'piece:R',
     *  'opening:Sicilian Defense'. */
    dimension: string
    label: string
    /** Present on entries inside `phases`/`pieces`/`openings`: the dimension
     *  with its family prefix stripped, ready to render. */
    name?: string
    mine: number
    peer: number
    /** Games behind YOUR number. Always shown next to it — a figure without
     *  its sample size is an argument, not a fact. */
    sample: number
    /** Games behind the PEER number. */
    peerSample: number
    /** [-1, 1]. Positive is always good, whichever direction the raw metric runs. */
    grade: number
    /** The same ratio BEFORE the ±1 clamp. `grade` is the verdict and saturates
     *  by design; `spread` is what lets the meter keep separating rows that are
     *  all "much better". Absent on reports built before it existed. */
    spread?: number
    /** 'much better' | 'better' | 'slightly better' | 'similar' | … */
    wording: string
    /** grade x sqrt(evidence x level weight). Drives ranking, not display. */
    importance: number
    /**
     * Where the player's average falls in the peer cell's stored quantiles.
     *
     * NOT RENDERED, deliberately. The baseline reservoir samples one value per
     * GAME, so this ranks a player's average against a distribution of
     * individual games — a different population. For the boundary-heavy
     * metrics (conversion, resourcefulness, flagging_loss, win_rate,
     * time_pressure) the knots are point-masses at 0/100 and the result is an
     * arbitrary interpolation between two identical endpoints, which is what
     * produced real rows reading "much better · 45th percentile". For the rest
     * it is directionally right but compressed hard toward 50. The backend
     * nulls the degenerate cases; the number that survives still is not a rank
     * among players, so the report does not print it.
     */
    percentile: number | null
    higherIsBetter: boolean
    unit: 'percent' | 'cp' | 'rating'
}

/** A measured value on its own, before comparison. */
export interface TutorMetricValue {
    value: number
    sample: number
    label: string
    unit: 'percent' | 'cp' | 'rating'
    higherIsBetter: boolean
}

/** A position from one of the player's OWN games, to be replayed. */
export interface TutorDrillPosition {
    fen: string
    gameId: string
    ply: number
    color: 'w' | 'b'
    san: string | null
    /** Centipawns lost at this moment — drills are ordered by it. */
    swing: number
    playedAt: string | null
}

/**
 * What to DO about a weakness. Exactly one per weakness card, by design: a
 * card with four links is a card with no recommendation.
 *
 * - `puzzles` — a themed set, filtered to this player's weak themes
 * - `replay`  — positions from their own games, played out against the bot
 * - `opening` — drill one opening from their side of it
 * - `games`   — no honest drill exists (time trouble); show the evidence
 */
export interface TutorDrill {
    kind: 'puzzles' | 'replay' | 'opening' | 'games'
    metric: string
    dimension: string
    label: string
    title: string
    blurb: string
    themes?: string[]
    positions?: TutorDrillPosition[]
    opening?: string
    /** Which side to drill the opening from. */
    color?: 'w' | 'b'
    games?: TutorDrillGameRow[]
}

/** One game behind a `games`-kind drill (time trouble: no honest exercise
 *  exists, so the drill shows the evidence instead). Every field past
 *  `gameId`/`playedAt` is a later enrichment and optional on the wire — an
 *  older stored report only has the first two, so render the rest
 *  defensively. */
export interface TutorDrillGameRow {
    gameId: string
    playedAt: string | null
    color?: 'w' | 'b'
    result?: string
    reason?: string
    oppRating?: number | null
    accuracy?: number | null
    moves?: number
    /** Percent of the player's own clock left at their last move. */
    clockLeftPct?: number | null
}

/** Which peer band produced the comparisons, so the UI can say how sure it is
 *  rather than implying certainty it doesn't have. */
export interface TutorPeerInfo {
    /** 'band' = your own rating band; 'widened' = neighbouring bands merged
     *  because yours was too thin; 'none' = no comparison was possible. */
    tier: 'band' | 'widened' | 'none'
    bandFrom: number
    bandTo: number
    source: string
}

/** One rating category's sub-report. Categories are never merged — mixing
 *  bullet and classical accuracy into one number is meaningless. */
export interface TutorCategoryReport {
    category: string
    rating: number
    /** Games actually measured. */
    games: number
    /** Games available in the window before sampling. */
    gamesAvailable: number
    capHit: boolean
    peer: TutorPeerInfo
    metrics: Record<string, TutorMetricValue>
    comparisons: TutorComparison[]
    strengths: TutorComparison[]
    weaknesses: TutorComparison[]
    phases: TutorComparison[]
    pieces: TutorComparison[]
    /** Split by the colour they were played with. The same opening is a
     *  different problem from each side — you choose it as White and you are
     *  answering it as Black — so merging them hides what a repertoire fix
     *  depends on. */
    openings: { w: TutorComparison[]; b: TutorComparison[] }
    /** One row per measured game — the report showing its working, and what
     *  the opening drilldown is served from. */
    gameRows: TutorGameRow[]
    drills: TutorDrill[]
    /** The player's rating TODAY, as opposed to `rating`, which is the mean
     *  rating they actually played the sampled games at. */
    currentRating: number
}

/** One measured game. */
export interface TutorGameRow {
    gameId: string
    playedAt: string | null
    color: 'w' | 'b'
    opening: string
    result: string
    reason: string
    myRating: number | null
    oppRating: number | null
    accuracy: number | null
    acpl: number | null
    moves: number
}

/**
 * Solve rate per tactical theme, from the player's puzzle history — the second,
 * independent source of tactical evidence. `awareness` says whether you punish
 * mistakes; this says which patterns you miss, by name.
 *
 * `comparable` is always false and the UI must respect it: the imported puzzle
 * set carries puzzle ratings but not other players' per-theme results, so a
 * peer number here would be invented rather than measured. Show `note`.
 */
export interface TutorThemeProfile {
    themes: {
        theme: string
        attempts: number
        solved: number
        rate: number
        avgPuzzleRating: number
    }[]
    attempts: number
    comparable: boolean
    note: string
}

/** The one sentence at the top of the report. */
export interface TutorHeadline {
    category: string
    metric: string
    text: string
    mine: number
    peer: number
    sample: number
}

export interface TutorPayload {
    version: number
    baselineSource?: string
    generatedAt?: string
    rangeFrom?: string
    rangeTo?: string
    headline: TutorHeadline | null
    /** Player-level, not per-category — the puzzle pool has no time control. */
    themeProfile?: TutorThemeProfile
    categories: Record<string, TutorCategoryReport>
    /** Categories that had games but not enough of them, so the page can say
     *  "Blitz: 12 of 20 games. Play 8 more" instead of silently omitting it. */
    insufficient: Record<string, { games: number; need: number }>
    minGames: number
    /** Eligible games in the window, before sampling. */
    gamesConsidered?: number
    /** Games actually folded into the metrics. */
    gamesUsed?: number
    /** Games that were sampled but could not be read at all (engine failure or
     *  too short), so a report can account for the gap between considered and
     *  used instead of leaving it to be guessed at. */
    gamesSkipped?: number
}

export interface TutorReportSummary {
    id: string
    status: 'queued' | 'building' | 'ready' | 'insufficient' | 'failed'
    rangeFrom: string
    rangeTo: string
    rangeLabel: string
    gamesConsidered: number
    gamesUsed: number
    /** Sampled but unreadable — see TutorPayload.gamesSkipped. */
    gamesSkipped: number
    capHit: boolean
    builtAt: string | null
    createdAt: string | null
    error: string | null
    headline: TutorHeadline | null
    categories: string[]
}

/** Whether a new report is worth building — and if not, a reason the user can
 *  act on. Never a bare cooldown: "no new games, play a few more" beats a
 *  dead button with a timer, which is a recurring complaint about Lichess's. */
export interface TutorEligibility {
    canRequest: boolean
    reason: string | null
    newGames: number
    usedToday: number
    dailyLimit: number
}

/** Your shelf of reports, newest first. Requires auth. */
export function getTutorReports(): Promise<{
    reports: TutorReportSummary[]
    eligibility: TutorEligibility
    ranges: string[]
    minGames: number
}> {
    return request('/tutor/reports')
}

/** Queue a build. Returns immediately with the queued row; a notification
 *  arrives when it's ready. */
export function requestTutorReport(range = '6m'): Promise<{ report: TutorReportSummary }> {
    return request('/tutor/reports', { method: 'POST', body: JSON.stringify({ range }) })
}

/** One report in full. 404s (not 403s) for someone else's — a stranger
 *  shouldn't learn that a given report id exists. */
export function getTutorReport(id: string): Promise<{
    report: TutorReportSummary
    payload: TutorPayload
}> {
    return request(`/tutor/reports/${encodeURIComponent(id)}`)
}

export function deleteTutorReport(id: string): Promise<{ deleted: boolean }> {
    return request(`/tutor/reports/${encodeURIComponent(id)}`, { method: 'DELETE' })
}

/** One metric across every report you've built. Series with fewer than two
 *  points are omitted — a single point is not a trend. */
export interface TutorTrendSeries {
    label: string
    unit: 'percent' | 'cp' | 'rating'
    higherIsBetter: boolean
    points: {
        reportId: string
        at: string | null
        /** YOUR measured value, never a grade — that is what makes the line
         *  legitimate across reports compared against different peer tiers. */
        value: number | null
        sample: number
        peerTier: 'band' | 'widened' | 'none'
        rating: number | null
    }[]
    delta: number
    improved: boolean
    /** The reports behind this line used different peer tiers. The line is
     *  still valid (raw values), but the UI should say so. */
    mixedTiers: boolean
}

/** One opening family from one side, with the games behind it. */
export interface TutorOpeningDetail {
    category: string
    color: 'w' | 'b'
    family: string
    comparison: TutorComparison | null
    peer: TutorPeerInfo | null
    games: TutorGameRow[]
    summary: { games: number; score: number | null; accuracy: number | null }
    drill: { kind: 'opening'; opening: string; color: 'w' | 'b' }
}

/** Drill into one opening from one side. The family is a query parameter, not
 *  a path segment, because opening names contain spaces and commas. */
export function getTutorOpening(
    reportId: string,
    category: string,
    color: 'w' | 'b',
    family: string,
): Promise<TutorOpeningDetail> {
    const p = new URLSearchParams({ category, color, family })
    return request(`/tutor/reports/${encodeURIComponent(reportId)}/opening?${p.toString()}`)
}

export function getTutorTrend(category?: string): Promise<{
    categories: string[]
    series: Record<string, Record<string, TutorTrendSeries>>
    reports: number
}> {
    const q = category ? `?category=${encodeURIComponent(category)}` : ''
    return request(`/tutor/trend${q}`)
}
