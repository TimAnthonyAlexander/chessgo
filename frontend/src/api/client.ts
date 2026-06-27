// Typed client for the chessgo BaseAPI backend (SPEC §7 / VS-Bot endpoints).
const BASE = import.meta.env.VITE_API_URL ?? 'http://127.0.0.1:6464'

export type Color = 'w' | 'b'

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

export interface MoveEntry {
  ply: number
  uci: string
  san: string
  by: 'human' | 'bot'
  fen: string // position after this move (for history navigation)
  eval?: { type: 'cp' | 'mate'; value: number }
}

export interface BotGame {
  id: string
  rating: number
  human_color: Color
  fen: string
  side_to_move: Color
  status: GameStatus
  result: string | null
  moves: MoveEntry[]
  legal_moves: string[]
  your_turn: boolean
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

/** Create a bot game. An optional `fen` starts from a custom position (e.g. one
 * carried over from the analysis board); omitted = the standard start. */
export function createBotGame(rating: number, humanColor: Color, fen?: string): Promise<BotGame> {
  return request<BotGame>('/bot-games', {
    method: 'POST',
    body: JSON.stringify({ rating, human_color: humanColor, ...(fen ? { fen } : {}) }),
  })
}

// --- Admin: engine vs engine (gomachine @ rating vs Stockfish @ Elo) ---

export type EngineSide = 'gomachine' | 'stockfish'

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
}

/** Admin-only: play one ply of gomachine(rating) vs Stockfish(elo) and apply it. */
export function engineVsMove(params: {
  fen: string
  side: EngineSide
  rating?: number
  elo?: number
  movetime?: number
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

export interface Analysis {
  eval: { type: 'cp' | 'mate'; value: number } | null
  bestmove: string | null
  pv: string[] | null // principal variation (best line) as UCI moves from the position
  depth: number | null
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
  opts?: { movetime?: number; depth?: number; signal?: AbortSignal },
): Promise<Analysis> {
  const body: { fen: string; movetime?: number; depth?: number } = { fen }
  if (opts?.movetime) body.movetime = opts.movetime
  if (opts?.depth) body.depth = opts.depth
  // `signal` lets a caller abort an in-flight request when it's no longer wanted —
  // the analysis board cancels the previous position's deepening when you move, so
  // the trailing deep call doesn't hog a browser connection / engine worker.
  return request<Analysis>('/analyze', { method: 'POST', body: JSON.stringify(body), signal: opts?.signal })
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

/** Serve the next puzzle near the solver's rating; optional theme filter. */
export function nextPuzzle(theme?: string): Promise<PuzzleNext> {
  const q = theme ? `?theme=${encodeURIComponent(theme)}` : ''
  return request<PuzzleNext>(`/puzzles/next${q}`)
}

/** Submit one player move (UCI) for validation against the hidden solution. */
export function submitPuzzleMove(
  id: string,
  move: string,
  fen: string,
  ply: number,
): Promise<PuzzleMoveResult> {
  return request<PuzzleMoveResult>(`/puzzles/${id}/move`, {
    method: 'POST',
    body: JSON.stringify({ move, fen, ply }),
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

export interface User {
  id: string
  name: string
  email: string
  role: string
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
  // Per-category Glicko-2 provisional flag (RD > 110): the rating is still
  // settling and is shown with a "?". Keyed by category, incl. 'puzzle'.
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
  rated: boolean
  result: string // '1-0' | '0-1' | '1/2-1/2'
  reason: string
  white_name: string
  black_name: string
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

export interface Profile {
  id: string
  name: string
  role: string
  created_at: string
  ratings: Record<RatingCategory, RatingTile>
  puzzle: PuzzleProfile
  record: ProfileRecord
  games: ProfileGame[]
  hasMore: boolean
}

/** Public profile by display name (ratings + record + first page of games). */
export function getProfile(name: string): Promise<Profile> {
  return request<Profile>(`/users/${encodeURIComponent(name)}`)
}

export interface ProfileGamesPage {
  games: ProfileGame[]
  offset: number
  hasMore: boolean
}

/** A further page of a player's game history ("load more"). */
export function getProfileGames(name: string, offset: number): Promise<ProfileGamesPage> {
  return request<ProfileGamesPage>(`/users/${encodeURIComponent(name)}/games?offset=${offset}`)
}

// --- Leaderboard (per-category top players) ---

/** One leaderboard row (public-safe; no email). `provisional` = RD still high. */
export interface LeaderboardEntry {
  rank: number
  id: string
  name: string
  rating: number
  games: number
  provisional: boolean
}

export interface LeaderboardResult {
  category: RatingCategory | 'puzzle'
  entries: LeaderboardEntry[]
}

/** Top players for a single rating category (bullet/blitz/rapid/classical/puzzle). */
export function getLeaderboard(category: RatingCategory | 'puzzle'): Promise<LeaderboardResult> {
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

export { ApiError }
