import {
    type Dispatch,
    Fragment,
    type SetStateAction,
    useCallback,
    useEffect,
    useMemo,
    useRef,
    useState,
} from 'react'
import { Box, Button, Tooltip, Typography } from '@mui/material'
import {
    ChevronFirst,
    ChevronLast,
    ChevronLeft,
    ChevronRight,
    Fish,
    FlipVertical2,
    Play,
    Square,
    Target,
    Volume2,
    VolumeX,
    Zap,
} from 'lucide-react'
import { useLocation, useNavigate, useParams } from 'react-router-dom'
import AnalysisAside from '../components/AnalysisAside'
import Board from '../components/Board'
import BlunderRewind, { BlunderRewindBanner } from '../components/BlunderRewind'
import ConfirmDialog from '../components/ConfirmDialog'
import DuckFreeBoard from '../components/DuckFreeBoard'
import BoardPage from '../components/BoardPage'
import EngineLines from '../components/EngineLines'
import EvalBar, { type WhiteEval } from '../components/EvalBar'
import LocalEngineControl from '../components/LocalEngineControl'
import MoveTree from '../components/MoveTree'
import OpeningPanel from '../components/OpeningPanel'
import {
    analyze,
    analyzeGameMoves,
    getGameAnalysis,
    sfAnalyze,
    type AnalysisLine,
    type GameAnalysis,
    type Opening,
} from '../api/client'
import type { Color } from '../api/client'
import { buildBlunderPuzzles, colorInGame } from '../lib/blunderRewind'
import { toPgn, type ParsedPgn } from '../lib/pgn'
import { useMoveNavKeys } from '../lib/useMoveNavKeys'
import { useShortcuts } from '../lib/shortcuts'
import { usePrefs } from '../lib/settings'
import { VARIANT_LABEL } from '../lib/variants'
import {
    type GameOver,
    type Tree,
    type TreeNode,
    annotateEval,
    buildFromAnalysis,
    buildFromMoves,
    createTree,
    gameOverAt,
    legalUci,
    pathToNode,
    playMove,
    START_FEN,
    turnAt,
} from '../lib/analysisTree'
import { playForSan, setSoundEnabled, soundEnabled, sounds } from '../lib/sounds'
import { useAuth } from '../lib/auth'
import { fromAnalysis } from '../lib/engine/evalAdapter'
import { type EvalCandidate, isFirstEvalBetter } from '../lib/engine/precedence'
import { useLocalEngineRace } from '../lib/engine/useLocalEngineRace'

// How long (ms) each auto-played move lingers before the next one.
const AUTO_DELAY = 700

// Color of the board arrow drawn when hovering a candidate (book) move — a clear
// blue, distinct from the gold engine best-move arrow.
const BOOK_ARROW_COLOR = '#4c8bf5'

// Color of the optional Stockfish best-move arrow — a translucent violet, clearly
// distinct from the gold gomachine arrow and the blue book arrow. When the two
// engines agree on the move we don't stack two arrows; the gomachine arrow is
// ringed in this color instead (see the arrow computation in the component).
const SF_ARROW_COLOR = '#b06bff'

// Depth schedule for the analysis board's progressive ("streaming") eval. Each
// entry is a separate /analyze call at that ply depth; we render the result as it
// lands, so the panel shows an instant shallow guess that refines as it deepens.
// Coarsening the steps as they get expensive keeps the round-trip count low (the
// deepest search dominates the cost anyway) while still feeling like it "ticks up".
// Progressive-deepening ladder for the analysis board. Each rung is a depth
// target plus the time ceiling granted to reach it. The early rungs keep tiny
// ceilings so the "instant shallow guess, then refine" feel is preserved; the
// deep tail hands out ever-larger budgets so that AS LONG AS the user stays on
// one position the search keeps climbing (the effect aborts the moment they
// navigate). The engine returns the instant it REACHES a target depth, so the
// big ceilings only ever bite on positions too complex to get there quickly.
//
// `multipv` is per-rung and deliberately DROPS TO 1 on the deep tail. Asking the
// engine for N lines makes it run N root searches per iteration — measured ~2.5x
// the wall clock of a single line at the same target (depth 22: 8.1s vs 3.2s), and
// that cost compounds down a ladder that reaches 30. The move list does not need
// depth 30 to be useful; the eval bar does. So the list is filled by the rungs up
// to 16 and then left alone (the ladder only ever REPLACES lines when a response
// carries them), while the eval bar keeps climbing cheaply. One search per rung
// either way — this is not a second search, just a narrower one.
const LINES_MAX_DEPTH = 16
const ANALYSIS_LADDER: { depth: number; ceilingMs: number; multipv: number }[] = [
    { depth: 6, ceilingMs: 1200, multipv: 5 },
    { depth: 9, ceilingMs: 1500, multipv: 5 },
    { depth: 12, ceilingMs: 2000, multipv: 5 },
    { depth: 14, ceilingMs: 2500, multipv: 5 },
    { depth: 16, ceilingMs: 3500, multipv: 5 },
    { depth: 18, ceilingMs: 5000, multipv: 1 },
    { depth: 20, ceilingMs: 7000, multipv: 1 },
    { depth: 22, ceilingMs: 10000, multipv: 1 },
    { depth: 25, ceilingMs: 16000, multipv: 1 },
    { depth: 28, ceilingMs: 24000, multipv: 1 },
    { depth: 30, ceilingMs: 35000, multipv: 1 },
]

type AutoMode = 'off' | 'play' | 'best'

// Duck Chess is REVIEW-ONLY on the analysis board — the client has no duck rules,
// so there's no "game over" to compute locally; the board is non-interactive and we
// short-circuit chess.js entirely for a loaded duck game.
const NO_GAME_OVER: GameOver = {
    over: false,
    checkmate: false,
    stalemate: false,
    draw: false,
    check: false,
}

// A useState<boolean> that persists to localStorage, so view preferences (engine
// on/off, which arrows are shown) survive a refresh. Behaves like useState — the
// setter accepts a value or an updater — and degrades to in-memory state if
// localStorage is unavailable (private mode, etc.).
function usePersistentBool(key: string, fallback: boolean): [boolean, Dispatch<SetStateAction<boolean>>] {
    const [value, setValue] = useState<boolean>(() => {
        try {
            const v = localStorage.getItem(key)
            return v === null ? fallback : v === '1'
        } catch {
            return fallback
        }
    })
    useEffect(() => {
        try {
            localStorage.setItem(key, value ? '1' : '0')
        } catch {
            /* ignore — preference just won't persist this session */
        }
    }, [key, value])
    return [value, setValue]
}

// Play the appropriate sound for the move that leads INTO a node.
function playMoveSound(node?: TreeNode) {
    if (!node?.move) return
    playForSan(node.move.san, false)
}

export default function Analysis() {
    const { id } = useParams<{ id?: string }>()
    const { user } = useAuth()
    const location = useLocation()
    const navigate = useNavigate()
    // Free mode can be seeded with an in-memory game (moves replayed from a start
    // position) passed via navigation state — e.g. from Engine vs Engine, which is
    // never persisted so it can't be loaded by id. A game-over "Review N blunders"
    // CTA (no persisted id, e.g. a bot game) can additionally carry the player's
    // color and an already-fetched analysis, so Blunder Rewind doesn't have to
    // re-run the ~2s engine burst it just ran to compute that count.
    const navState = location.state as {
        moves?: string[]
        startFen?: string
        humanColor?: Color
        analysis?: GameAnalysis
    } | null
    const importMoves = navState?.moves ?? null
    const importStartFen = navState?.startFen ?? START_FEN

    const prefs = usePrefs()

    const [tree, setTree] = useState<Tree>(() => createTree(START_FEN))
    const [currentId, setCurrentId] = useState(0)
    const [orientation, setOrientation] = useState<Color>('w')
    // Once the user flips the board by hand, that choice wins over the autoFlip
    // preference (which otherwise re-orients to the side to move every ply) until
    // the next game/position load resets it — see the effect below.
    const [manualFlip, setManualFlip] = useState(false)
    // View preferences persist across refreshes (localStorage).
    const [showArrow, setShowArrow] = usePersistentBool('chessgo.analysis.showArrow', true)
    // Optional second-opinion arrow: full-strength Stockfish's best move, drawn
    // translucent so you can see where it disagrees with gomachine. Off by default.
    const [showSfArrow, setShowSfArrow] = usePersistentBool('chessgo.analysis.showSfArrow', false)
    // Stockfish's best move + eval for a specific position (kept with its FEN so a
    // stale response from a previous position is ignored). `evalWhite` is already
    // flipped to White's POV, ready for the eval bar's second-opinion line.
    const [sfBest, setSfBest] = useState<{
        fen: string
        uci: string
        evalWhite: WhiteEval | null
    } | null>(null)
    const [sound, setSound] = useState(soundEnabled())
    // master: eval bar + arrow + engine line (persisted across refreshes)
    const [engineOn, setEngineOn] = usePersistentBool('chessgo.analysis.engineOn', true)
    const [game, setGame] = useState<GameAnalysis | null>(null)
    const [loadError, setLoadError] = useState<string | null>(null)
    const [loading, setLoading] = useState<boolean>(!!id)
    const [autoMode, setAutoMode] = useState<AutoMode>('off')
    // UCI of the candidate (book) move currently hovered in the OpeningPanel, drawn
    // as a blue arrow on the board. Cleared whenever the viewed node changes.
    const [hoverUci, setHoverUci] = useState<string | null>(null)
    const [analysisLines, setAnalysisLines] = useState<AnalysisLine[] | null>(null)
    // Opening of the currently viewed position, from the SAME /analyze call as
    // `analysisLines` (a pure book lookup server-side, no extra search). Feeds
    // OpeningPanel's header — see the ladder effect below.
    const [analysisOpening, setAnalysisOpening] = useState<Opening | null>(null)
    // True while the ladder's search for the CURRENTLY VIEWED position hasn't
    // produced anything yet — lets OpeningPanel show "Exploring…" vs "No moves"
    // instead of guessing from `analysisLines` alone (see the ladder effect below).
    const [linesLoading, setLinesLoading] = useState(false)
    // Free mode only: interactive Duck Chess. When true (and no game is loaded) the
    // standard board/tree layout is replaced by the self-contained duck board.
    const [duckFree, setDuckFree] = useState(false)
    // Review mode only: Blunder Rewind — replay the game's blunders as retry puzzles.
    // When true (and a game is loaded) the review layout is swapped for the
    // self-contained rewind board.
    const [rewind, setRewind] = useState(false)
    // Free mode only: hides the opening explorer without losing engine analysis
    // (bound to the 'e' shortcut below).
    const [showOpening, setShowOpening] = usePersistentBool('chessgo.analysis.showOpening', true)
    // A pasted PGN awaiting confirmation because it would discard moves already
    // on the board (free mode only — see onImportPgn below).
    const [pendingImport, setPendingImport] = useState<ParsedPgn | null>(null)

    // --- Load a finished game's analysis (review mode) ---
    useEffect(() => {
        setAutoMode('off')
        setRewind(false) // exit any Blunder Rewind when (re)loading a game
        if (!id) {
            if (importMoves && importMoves.length > 0) {
                // Seeded free mode: replay an imported game onto a fresh tree. The
                // board renders immediately from the move list; full analysis (needed
                // for Blunder Rewind's blunder detection) is fetched separately below
                // and never blocks it.
                const built = buildFromMoves(importStartFen, importMoves)
                setTree(built.tree)
                setCurrentId(built.lastId) // land on the final position
                setLoading(false)

                // Already analyzed by the caller (e.g. a "Review N blunders" CTA that
                // fetched this to show the count) — use it as-is, no second engine burst.
                if (navState?.analysis) {
                    setGame(navState.analysis)
                    return
                }

                setGame(null)
                let cancelled = false
                void (async () => {
                    try {
                        const a = await analyzeGameMoves(importMoves, importStartFen)
                        if (!cancelled) setGame(a)
                    } catch {
                        // Best-effort: the board + live per-position engine eval work fine
                        // without it — this only gates the blunder-rewind banner/deep link.
                    }
                })()
                return () => {
                    cancelled = true
                }
            }
            // Free mode: fresh board from the start position — or a custom one carried
            // over from the board editor ("Analyse this position").
            setTree(createTree(importStartFen))
            setCurrentId(0)
            setGame(null)
            setLoading(false)
            return
        }

        let cancelled = false
        setLoading(true)
        setLoadError(null)

        // The hub persists a finished game fire-and-forget, so just after a game ends
        // the record may not exist yet — retry a few times before giving up.
        const attempt = async (tries: number): Promise<void> => {
            try {
                const a = await getGameAnalysis(id)
                if (cancelled) return
                if (a.unsupported) {
                    // Chess960 / Duck Chess games can't be replayed by the standard
                    // full-game analyzer — show a clear notice instead of an error.
                    const label = a.variant ? VARIANT_LABEL[a.variant] : 'this variant'
                    setLoadError(`Engine analysis isn't available for ${label} games yet.`)
                    setLoading(false)
                    return
                }
                const built = buildFromAnalysis(a.startFen, a.plies)
                setTree(built.tree)
                setCurrentId(built.tree.rootId)
                setGame(a)
                setLoading(false)
            } catch (e) {
                const status = (e as { status?: number }).status
                if (status === 404 && tries > 0 && !cancelled) {
                    setTimeout(() => void attempt(tries - 1), 1200)
                    return
                }
                if (cancelled) return
                setLoadError((e as Error).message || 'Could not load this game')
                setLoading(false)
            }
        }
        void attempt(5)
        return () => {
            cancelled = true
        }
    }, [id, importMoves, importStartFen, navState])

    // A hovered candidate move only makes sense for the position it was listed for;
    // drop it when the viewed node changes (the row also unmounts on navigation).
    useEffect(() => setHoverUci(null), [currentId])

    // Duck Chess is free-mode only — loading a game (review mode) exits it.
    useEffect(() => {
        if (id) setDuckFree(false)
    }, [id])

    // Which side the viewer played (by name), or null if they weren't a participant.
    // Which side the viewer played. For a persisted game (id path) this is a name
    // match against the signed-in user; a stateless moves-only game (no id, e.g. a
    // bot game reviewed via "Review N blunders") has no meaningful whiteName/
    // blackName to match against, so the caller passes the human's color directly.
    const myColor = useMemo(() => {
        if (!game) return null
        if (!id && navState?.humanColor) return navState.humanColor
        return colorInGame(game, user?.name)
    }, [game, user, id, navState])

    // Coming from a game analysis, auto-orient so the viewer is always at the bottom
    // (falls back to White for spectators / non-participants). A fresh game/position
    // load also clears any manual flip from a previous game, so autoFlip (if on)
    // takes over again immediately rather than staying stuck on the old override.
    useEffect(() => {
        setManualFlip(false)
        if (game) setOrientation(myColor ?? 'w')
    }, [game, myColor])

    // Blunder Rewind puzzles: the viewer's own gradeable blunders (both sides' when
    // the viewer isn't a participant, so a spectator still gets a full rewind).
    const blunderPuzzles = useMemo(
        () => (game ? buildBlunderPuzzles(game, myColor ?? undefined) : []),
        [game, myColor],
    )

    // Deep link straight into Blunder Rewind: a game-over "Review N blunders" CTA
    // navigates here with `?rewind=1`. Enter it once the analysis has loaded and
    // actually has gradeable blunders — never on every render, and never more than
    // once per game (tracked by id, or 'free' for the moves-only path) so exiting
    // the rewind doesn't immediately bounce back in. The query param is stripped on
    // entry (same location.state, so it doesn't retrigger the load effect above).
    const consumedRewindRef = useRef<string | null>(null)
    useEffect(() => {
        if (new URLSearchParams(location.search).get('rewind') !== '1') return
        if (!game || blunderPuzzles.length === 0) return
        const key = id ?? 'free'
        if (consumedRewindRef.current === key) return
        consumedRewindRef.current = key
        setRewind(true)
        navigate(id ? `/analysis/${id}` : '/analysis', { replace: true, state: location.state })
    }, [id, location.search, location.state, game, blunderPuzzles.length, navigate])

    const current = tree.nodes[currentId] ?? tree.nodes[tree.rootId]
    // Reviewing a loaded Duck Chess game: playback only (no client-side duck rules,
    // so no move input / variations / live standard-engine analysis).
    const isDuck = game?.variant === 'duck'
    const sideToMove = turnAt(current)
    // Duck has no locally-computable game-over / legality — the engine owns duck
    // rules. Feed the board an empty legal-move set and a no-op terminal state.
    const over = useMemo(() => (isDuck ? NO_GAME_OVER : gameOverAt(current)), [current.fen, isDuck])
    const legalMoves = useMemo(
        () => (isDuck || over.over ? [] : legalUci(current)),
        [current.fen, over.over, isDuck],
    )

    // Prior-position FENs (root→previous) for the viewed node, same shape
    // OpeningPanel's own `/candidates` fetch builds — sent as `history` on the
    // ladder's `/analyze` calls below so the engine can name the deepest-match
    // opening for the position, not just guess from the FEN alone.
    const historyFens = useMemo(() => {
        const path = pathToNode(tree, currentId)
        return path.slice(0, -1).map((n) => n.fen)
    }, [tree, currentId])

    // The orientation actually shown: the autoFlip preference re-orients to the
    // side to move every ply, but only until the user flips by hand (manualFlip),
    // at which point their explicit choice (`orientation`) is authoritative — an
    // analysis board that kept auto-flipping under you while stepping through a
    // game would be disorienting once you've picked a fixed side to view from.
    const displayOrientation: Color = prefs.autoFlip && !manualFlip ? sideToMove : orientation

    // MultiPV lines live only in this component, not on the tree node (the tree
    // persists eval/bestmove/pv/depth, not the full N-line set). So walking BACK
    // to a node whose eval is already deeper than the ladder's last rung would
    // otherwise leave the move list permanently empty — every rung gets skipped,
    // no /analyze call fires, and OpeningPanel renders "No moves". It used to
    // dodge this by always re-fetching /candidates itself; now that the lines
    // come from the ladder, this cache is what makes a revisit instant.
    const linesCache = useRef(new Map<number, { lines: AnalysisLine[]; opening: Opening | null }>())

    // Swap the multi-PV move list/opening the instant the VIEWED position changes,
    // before the ladder effect below has a chance to fetch anything for it. Without
    // this, OpeningPanel would briefly keep rendering the PREVIOUS position's moves
    // (playable into the wrong position) while the new position's first rung is
    // still in flight. A cache hit renders immediately and skips the "Exploring…"
    // state entirely.
    useEffect(() => {
        const hit = linesCache.current.get(current.id)
        setAnalysisLines(hit?.lines ?? null)
        setAnalysisOpening(hit?.opening ?? null)
        setLinesLoading(!hit)
    }, [current.id])

    // --- Optional local (in-browser) engine ---
    // Races a local WASM search against the server ladder below, Lichess-style:
    // both run in parallel, and whichever result is deeper (precedence.ts's
    // isFirstEvalBetter) wins the display. OFF by default (engine.enabled in
    // localStorage) — see useLocalEngineRace.ts for the full no-op-when-disabled
    // contract this depends on. `active` mirrors the ladder effect's own gates
    // below (not duck, not game-over, not still loading).
    const localRace = useLocalEngineRace({
        active: engineOn && !isDuck && !over.over && !loading,
        fen: current.fen,
    })
    const localEngineOn = localRace.enabled

    // Toggling the local engine swaps which engine produced everything currently
    // on screen — the move list, the badge, the per-node source map, and the
    // cached lines behind a revisit. Keeping any of it across the switch shows
    // one engine's output labelled as the other's, which is exactly the "stale
    // state after toggling" people notice first. Drop it all and let the ladder
    // effect (which re-keys on localEngineOn) repopulate from scratch.
    const firstToggleRender = useRef(true)
    useEffect(() => {
        if (firstToggleRender.current) {
            firstToggleRender.current = false
            return // mount, not a toggle — nothing stale to clear
        }
        linesCache.current.clear()
        setDisplayCandidates({})
        setAnalysisLines(null)
        setAnalysisOpening(null)
        setLinesLoading(true)
    }, [localEngineOn])

    // What's currently displayed for a node, in precedence.ts's EvalCandidate
    // shape — written by BOTH the ladder effect (server/cache results) and the
    // local-race effect below (once local wins), so each can tell whether a
    // new result is actually an improvement over whichever source is currently
    // showing. Also what drives the Cloud badge, which is why it is populated
    // even with the local engine off: a plain server cache hit has a source
    // worth showing too.
    const [displayCandidates, setDisplayCandidates] = useState<Record<number, EvalCandidate>>({})

    // Local engine won the race for the CURRENTLY VIEWED node: fold its result
    // into the SAME tree fields (evalWhite/bestUci/bestPv/bestDepth) the ladder
    // writes, via the SAME annotateEval — so the eval bar, arrow, and PV line
    // all pick it up for free with no separate render path. Falls back to a
    // synthesized candidate (from the tree's own bestDepth/bestPv) when no
    // ladder response has been captured yet for this node — e.g. a persisted
    // review node whose deep eval came from buildFromAnalysis, never a ladder
    // rung.
    useEffect(() => {
        if (!localEngineOn || !localRace.candidate) return
        const nodeId = current.id
        const achieved: EvalCandidate = displayCandidates[nodeId] ?? {
            depth: current.bestPv != null ? (current.bestDepth ?? 0) : 0,
            nodes: 0,
            pvCount: current.bestPv ? 1 : 0,
            source: 'server',
        }
        if (!isFirstEvalBetter(localRace.candidate.candidate, achieved, 1)) return
        const { display } = localRace.candidate
        if (!display.eval) return
        const stm = current.fen.split(' ')[1] === 'b' ? 'b' : 'w'
        const white = stm === 'w' ? display.eval.value : -display.eval.value
        setTree((t) => annotateEval(t, nodeId, { type: display.eval!.type, white }, display.bestmove, display.pv, display.depth))
        setDisplayCandidates((m) => ({ ...m, [nodeId]: localRace.candidate!.candidate }))
    }, [localEngineOn, localRace.candidate, current.id, current.bestDepth, current.bestPv, current.fen, displayCandidates])

    // Local multi-PV move list. With the local engine on, the server is only
    // asked for a cache lookup, so on a cache miss nothing else would populate
    // the list — the board would show an eval and an arrow but no lines.
    useEffect(() => {
        if (!localEngineOn || !localRace.lines || localRace.lines.length === 0) return
        setAnalysisLines(localRace.lines)
        linesCache.current.set(current.id, { lines: localRace.lines, opening: null })
    }, [localEngineOn, localRace.lines, current.id])

    // --- Live engine eval + best line: progressive ("streaming") deepening ---
    // We can't stream over the wire (no SSE behind Cloudflare), so we emulate it by
    // POLLING /analyze with an increasing depth and rendering each result as it
    // lands: an instant shallow guess first, then a refining eval/PV until it
    // settles — the Stockfish/Lichess feel. The engine keeps its transposition
    // table warm across these stateless calls, so each deeper step is cheap.
    //
    // The whole schedule runs inside ONE effect (an async loop with a `cancelled`
    // guard) so re-renders from our own annotateEval don't restart it — the effect
    // re-keys only when the VIEWED position changes (current.id/fen).
    useEffect(() => {
        if (!engineOn) {
            setLinesLoading(false) // no fetching — nothing for OpeningPanel to wait on
            return
        }
        // Duck review: the cached per-ply evals from the payload are already on every
        // node — don't stream the STANDARD engine against a duck position (it has no
        // duck rules and would mis-evaluate it).
        if (isDuck) {
            setLinesLoading(false)
            return
        }
        // While a game is loading, the tree is still the transient empty root; don't
        // fire /analyze against it — that races buildFromAnalysis (whichever lands
        // last wins) and would overwrite the persisted, book-backed game analysis.
        if (loading) return

        // Terminal positions: derive the eval locally, no engine call (no line to show).
        if (over.over) {
            setLinesLoading(false) // terminal position — no move list to search for
            if (current.evalWhite !== null) return
            let ev: WhiteEval
            if (over.checkmate) ev = { type: 'mate', white: sideToMove === 'w' ? -1 : 1 }
            else ev = { type: 'cp', white: 0 }
            setTree((t) => annotateEval(t, current.id, ev, null, []))
            return
        }

        const nodeId = current.id
        const fen = current.fen
        const stm = sideToMove
        // Honor an existing deeper eval (e.g. a persisted review node that already has
        // a PV) — skip shallower steps so we never DOWNGRADE the displayed depth. A
        // node missing its PV is treated as depth 0 so we always fetch a line for it.
        let achieved = current.bestPv != null ? (current.bestDepth ?? 0) : 0

        // The depth the MOVE LIST has reached, tracked separately from `achieved`
        // (the eval's depth) because the two can diverge sharply.
        //
        // On a book position the engine answers from book.bin instantly and reports
        // a canned top-level depth (22 for the start position) while the multi-PV
        // lines it returns are searched only to the REQUESTED rung depth. So rung 1
        // (target 6) yields lines at depth 6 but sets `achieved` to 22, after which
        // every remaining multi-line rung (9/12/14/16) fails `target <= achieved`
        // and is skipped. The move list then sits at depth 6 forever, no matter how
        // long you wait — visible on 1.e4 and every other opening move.
        //
        // Gating multi-PV rungs on the LINES depth instead lets the list keep
        // deepening to LINES_MAX_DEPTH while `achieved` still protects the eval
        // from being downgraded by a shallower rung.
        let linesAchieved = linesCache.current.get(nodeId)?.lines[0]?.depth ?? 0

        // `achieved` guards the EVAL from being downgraded, but it must not be
        // allowed to starve the MOVE LIST. A revisited node can carry a depth-22
        // stored eval and no cached lines, in which case every rung is `<= achieved`
        // and the ladder makes no call at all. When we have no lines for this node,
        // run the deepest rung that is still within the stored depth first (it can't
        // downgrade anything — the `got <= achieved` guard below drops its eval) purely
        // to repopulate the list, then continue up the ladder as usual.
        // The backfill rung is capped at LINES_MAX_DEPTH: it exists only to refill the
        // move list, so it takes the deepest multi-line rung available rather than
        // matching a deep stored eval it can't beat anyway.
        const rungs = [...ANALYSIS_LADDER]
        if (!linesCache.current.has(nodeId) && achieved > 0) {
            const backfill = [...ANALYSIS_LADDER]
                .reverse()
                .find((r) => r.multipv > 1 && r.depth <= Math.min(achieved, LINES_MAX_DEPTH))
            if (backfill) rungs.unshift(backfill)
        }

        let cancelled = false
        // Abort the in-flight request when we leave this position, so the previous
        // position's trailing deep call (up to the server's time ceiling) doesn't hog
        // a browser connection / engine worker and delay the new position's first guess.
        const ac = new AbortController()
        const run = async () => {
            // `finally` covers every exit (loop exhausted, mate found, aborted, or
            // errored) so OpeningPanel's "still searching" flag always resolves —
            // it does NOT mean "lines landed", just that this position's ladder run
            // is done asking.
            try {
                // Local engine is doing the searching: ask the server for a cache
                // LOOKUP only, once, and stop. Running the full depth ladder here
                // would make a client with its own engine cost the server MORE CPU
                // than one without — the exact opposite of why the local engine
                // exists. Anything the cache already knows is free depth and still
                // worth having (it lands instantly, before local has warmed up);
                // anything it doesn't, local computes.
                if (localEngineOn) {
                    let r: Awaited<ReturnType<typeof analyze>>
                    try {
                        r = await analyze(fen, {
                            // multipv 1, not 5. The cache only serves an entry
                            // holding at least as many lines as asked for, so
                            // requesting 5 missed every single-line row — and
                            // with the local engine on, the move list comes from
                            // local anyway. A stored multi-line entry still
                            // returns its lines, so asking narrow costs nothing.
                            multipv: 1,
                            history: historyFens,
                            cacheOnly: true,
                            signal: ac.signal,
                        })
                    } catch {
                        return
                    }
                    if (cancelled || r.source === 'miss' || !r.eval) return

                    if (r.lines && r.lines.length > 0) {
                        setAnalysisLines(r.lines)
                        linesCache.current.set(nodeId, { lines: r.lines, opening: r.opening ?? null })
                    }
                    // Absent `opening` means "no opinion" (the lookup could not run),
                    // so leave whatever name is already displayed alone.
                    if (r.opening !== undefined) setAnalysisOpening(r.opening ?? null)

                    const got = r.depth ?? 0
                    if (got <= achieved) return
                    setDisplayCandidates((m) => ({ ...m, [nodeId]: fromAnalysis(r).candidate }))
                    const white = stm === 'w' ? r.eval.value : -r.eval.value
                    setTree((t) =>
                        annotateEval(t, nodeId, { type: r.eval!.type, white }, r.bestmove, r.pv ?? [], got),
                    )
                    return
                }

                for (const [i, { depth: target, ceilingMs, multipv }] of rungs.entries()) {
                    if (cancelled) return
                    // i === 0 may be the backfill rung above, which is deliberately
                    // at-or-below `achieved` — let that one through.
                    // Multi-PV rungs feed the move list, so they answer to the list's
                    // own depth; single-line rungs feed the eval and answer to
                    // `achieved`. See the linesAchieved comment above for why
                    // conflating the two froze the list at depth 6 on book positions.
                    const gate = multipv > 1 ? linesAchieved : achieved
                    if (target <= gate && !(i === 0 && rungs.length > ANALYSIS_LADDER.length)) continue

                    let r: Awaited<ReturnType<typeof analyze>>
                    try {
                        r = await analyze(fen, {
                            depth: target,
                            movetime: ceilingMs,
                            multipv,
                            history: historyFens,
                            signal: ac.signal,
                        })
                    } catch {
                        return
                    }
                    if (cancelled) return

                    if (r.lines && r.lines.length > 0) {
                        setAnalysisLines(r.lines)
                        // Cache under the node, not the FEN: transpositions are rare here
                        // and the node id is what the navigation effect above looks up.
                        linesCache.current.set(nodeId, { lines: r.lines, opening: r.opening ?? null })
                        // Per-line depth, not the top-level one — on a book position the
                        // latter is a canned value unrelated to how deep the lines were
                        // actually searched.
                        linesAchieved = Math.max(linesAchieved, r.lines[0]?.depth ?? target)
                    }
                    if (r.opening !== undefined) {
                        setAnalysisOpening(r.opening ?? null)
                    }

                    const got = r.depth ?? target
                    // This rung's budget wasn't enough to get deeper than what we already
                    // have — DON'T stop: skip to the next rung, which grants strictly more
                    // time and can break through. (Stopping here was the bug that pinned
                    // the readout at ~16.) The loop is bounded by the ladder, so a truly
                    // walled position simply exhausts it.
                    if (got <= achieved) continue

                    // Record this response's precedence shape (depth/pvCount/source) so
                    // the local-engine race effect can tell whether a local result is
                    // actually an improvement — see its comment above. Guarded by the
                    // REF (not a dep — see above) so this costs the default-off majority
                    // nothing: no extra setState, no extra re-render, unchanged rendering.
                    setDisplayCandidates((m) => ({ ...m, [nodeId]: fromAnalysis(r).candidate }))

                    // Coalesce a null PV to [] so the node reads as "resolved, no line".
                    if (!r.eval) {
                        setTree((t) =>
                            annotateEval(
                                t,
                                nodeId,
                                { type: 'cp', white: 0 },
                                r.bestmove,
                                r.pv ?? [],
                                got,
                            ),
                        )
                    } else {
                        const white = stm === 'w' ? r.eval.value : -r.eval.value
                        setTree((t) =>
                            annotateEval(
                                t,
                                nodeId,
                                { type: r.eval!.type, white },
                                r.bestmove,
                                r.pv ?? [],
                                got,
                            ),
                        )
                    }
                    achieved = got

                    if (r.eval?.type === 'mate') return // mate found — deeper won't change it
                    // NOTE: got < target (ceiling cut this rung short) is NOT terminal —
                    // the next rung hands out a larger budget and may reach deeper. We
                    // only stop once a bigger budget yields no deeper result (handled by
                    // the `got <= achieved` guard at the top of the next iteration).
                }
            } finally {
                if (!cancelled) setLinesLoading(false)
            }
        }
        void run()

        return () => {
            cancelled = true
            ac.abort()
        }
        // Keyed on the VIEWED position only — current.bestPv/bestDepth are read at
        // effect start (above) but deliberately NOT deps: our own setTree updates them
        // each step, and re-running would abort the in-flight call and re-fetch it.
        // `historyFens` is read via closure for the same reason `history` is excluded
        // from OpeningPanel's own fetch deps (OpeningPanel.tsx): it's a fresh array on
        // every tree annotation even though its content only changes with current.id,
        // which IS a dep — so this is redundant, not stale.
        // `localEngineOn` IS a dependency, unlike the ref used further down: flipping
        // the toggle has to switch between the search ladder and the cache-only
        // lookup right away, otherwise turning the local engine on leaves the
        // current position still hammering /analyze until you navigate away.
    }, [engineOn, localEngineOn, isDuck, loading, current.id, current.fen, over.over, over.checkmate, sideToMove])

    // --- Stockfish second-opinion best move (optional arrow) ---
    // One full-strength Stockfish call per viewed position, only while the toggle
    // is on. Independent of gomachine's progressive deepening; if Stockfish isn't
    // installed the request errors and we just don't draw the arrow. Keyed on the
    // VIEWED position — setting sfBest is deliberately NOT a dep (it would refetch).
    useEffect(() => {
        // Gated off for duck review — Stockfish has no duck rules (standard-only arrow).
        if (!engineOn || !showSfArrow || loading || over.over || isDuck) return
        const fen = current.fen
        let cancelled = false
        const ac = new AbortController()
        void (async () => {
            try {
                const r = await sfAnalyze(fen, { movetime: 300, signal: ac.signal })
                if (cancelled || !r.bestmove) return
                // Flip Stockfish's side-to-move eval to White's POV (from the FEN).
                const stm = fen.split(' ')[1] === 'b' ? 'b' : 'w'
                const evalWhite: WhiteEval | null = r.eval
                    ? { type: r.eval.type, white: stm === 'w' ? r.eval.value : -r.eval.value }
                    : null
                setSfBest({ fen, uci: r.bestmove, evalWhite })
            } catch {
                // Stockfish unavailable or request aborted — leave the arrow off.
            }
        })()
        return () => {
            cancelled = true
            ac.abort()
        }
    }, [engineOn, showSfArrow, loading, over.over, isDuck, current.fen])

    // --- Navigation (manual navigation always cancels any auto playback) ---
    const goPrev = useCallback(() => {
        setAutoMode('off')
        setCurrentId((cur) => tree.nodes[cur]?.parent ?? cur)
    }, [tree])
    const goNext = useCallback(() => {
        setAutoMode('off')
        setCurrentId((cur) => tree.nodes[cur]?.children[0] ?? cur)
    }, [tree])
    const goStart = useCallback(() => {
        setAutoMode('off')
        setCurrentId(tree.rootId)
    }, [tree.rootId])
    const goEnd = useCallback(() => {
        setAutoMode('off')
        setCurrentId((cur) => {
            let n = tree.nodes[cur]
            while (n && n.children.length > 0) n = tree.nodes[n.children[0]]
            return n ? n.id : cur
        })
    }, [tree])
    const selectNode = useCallback((nodeId: number) => {
        setAutoMode('off')
        setCurrentId(nodeId)
    }, [])
    // Load a fresh position into the board (new game / Chess960 / pasted FEN).
    const loadPosition = useCallback((fen: string) => {
        setAutoMode('off')
        const fresh = createTree(fen)
        setTree(fresh)
        setCurrentId(fresh.rootId)
    }, [])

    // Registered once through the shared registry (arrows/Home/End) — replaces a
    // private keydown listener that duplicated this and, unlike the shared hook,
    // had no guard against hijacking arrow keys while typing in a text field.
    useMoveNavKeys({ onPrev: goPrev, onNext: goNext, onFirst: goStart, onLast: goEnd })

    // Flip the board by hand. Toggles from whatever is CURRENTLY shown (which, if
    // autoFlip is on and hasn't been overridden yet, is the side to move) and — per
    // the autoFlip preference's contract on this page — marks the choice manual so
    // it sticks instead of being overridden again on the next ply.
    const flipBoard = useCallback(() => {
        setOrientation(displayOrientation === 'w' ? 'b' : 'w')
        setManualFlip(true)
    }, [displayOrientation])

    // --- Making a move (branch-aware) ---
    const onMove = useCallback(
        (uci: string) => {
            const node = tree.nodes[currentId]
            if (!node) return
            const res = playMove(tree, currentId, uci)
            if (res.nodeId === currentId) return // illegal / no-op
            setAutoMode('off') // a manual move ends auto playback
            playMoveSound(res.tree.nodes[res.nodeId])
            setTree(res.tree)
            setCurrentId(res.nodeId)
        },
        [tree, currentId],
    )

    // Play the FIRST move of an engine line (the Engine Lines panel's click-to-play)
    // onto the board, branch-aware like a normal move. Only one ply: clicking a line
    // steps into it, it doesn't fast-forward to the end of the PV. Click the panel
    // again on the new position to keep walking the line.
    const onPlayEngineLine = useCallback(
        (pvUci: string[]) => {
            if (pvUci.length === 0) return
            const res = playMove(tree, currentId, pvUci[0])
            if (res.nodeId === currentId) return
            setAutoMode('off')
            playMoveSound(res.tree.nodes[res.nodeId])
            setTree(res.tree)
            setCurrentId(res.nodeId)
        },
        [tree, currentId],
    )

    // --- PGN import/export (AnalysisAside's Game card) ---

    // The tree's mainline (children[0] at every step) as SAN, root to tip — what
    // "the current game" means for export, regardless of which node is being
    // viewed (branches aren't included; PGN has no first-class variation syntax
    // here and the mainline is what the user was actually replaying/playing).
    const mainlineSans = useCallback((): string[] => {
        const out: string[] = []
        let node = tree.nodes[tree.rootId]
        while (node && node.children.length > 0) {
            const next = tree.nodes[node.children[0]]
            if (!next?.move) break
            out.push(next.move.san)
            node = next
        }
        return out
    }, [tree])

    // Build a PGN of the current game on demand. Review mode fills in the real
    // player names + result; free mode leans on toPgn's own sensible defaults.
    const getPgn = useCallback((): string => {
        const sanMoves = mainlineSans()
        const startFen = tree.nodes[tree.rootId]?.fen ?? START_FEN
        if (game) {
            return toPgn(
                { sanMoves, startFen },
                { White: game.whiteName, Black: game.blackName, Result: game.result },
            )
        }
        return toPgn({ sanMoves, startFen })
    }, [tree, game, mainlineSans])

    // Replace the board with a parsed PGN's game (free mode only — the aside hides
    // Import entirely in review mode).
    const applyImport = useCallback((parsed: ParsedPgn) => {
        const built = buildFromMoves(parsed.startFen, parsed.uciMoves)
        setAutoMode('off')
        setTree(built.tree)
        setCurrentId(built.lastId)
    }, [])

    // An import replaces the whole board — confirm first if there's anything on
    // it that would be lost (more than just the empty root node).
    const onImportPgn = useCallback(
        (parsed: ParsedPgn) => {
            const hasMoves = Object.keys(tree.nodes).length > 1
            if (hasMoves) setPendingImport(parsed)
            else applyImport(parsed)
        },
        [tree, applyImport],
    )

    // --- Auto Play: step through the mainline (children[0]) on a timer ---
    useEffect(() => {
        if (autoMode !== 'play') return
        const nextId = tree.nodes[currentId]?.children[0]
        if (nextId === undefined) {
            setAutoMode('off') // reached the end of the line
            return
        }
        const t = setTimeout(() => {
            playMoveSound(tree.nodes[nextId])
            setCurrentId(nextId)
        }, AUTO_DELAY)
        return () => clearTimeout(t)
    }, [autoMode, currentId, tree])

    // --- Auto Best Move: keep playing the engine's best move from here, branching
    // off the existing line when the best move differs from what was played. We
    // lean on the eval effect to populate `bestUci`; when it's not yet known we
    // simply wait (this effect re-runs once it arrives). ---
    useEffect(() => {
        // Auto Best plays the engine's best move into the tree via chess.js — disabled
        // for duck review (composite moves + no client rules). Auto Play still works.
        if (autoMode !== 'best' || isDuck) return
        if (over.over) {
            setAutoMode('off') // game over — nothing left to play
            return
        }
        const best = current.bestUci
        if (!best) return // waiting for the engine's best move; re-runs when known
        const t = setTimeout(() => {
            const res = playMove(tree, currentId, best)
            if (res.nodeId === currentId) {
                setAutoMode('off') // defensive: engine returned an unplayable move
                return
            }
            playMoveSound(res.tree.nodes[res.nodeId])
            setTree(res.tree)
            setCurrentId(res.nodeId)
        }, AUTO_DELAY)
        return () => clearTimeout(t)
    }, [autoMode, isDuck, currentId, current.bestUci, over.over, tree])

    const toggleAuto = useCallback((mode: Exclude<AutoMode, 'off'>) => {
        if (mode === 'best') setEngineOn(true) // Auto Best Move needs the engine running
        setAutoMode((m) => (m === mode ? 'off' : mode))
    }, [])

    // Master engine toggle: turning it off also stops Auto Best Move (which depends
    // on the engine) — Auto Play, which just replays the move list, keeps going.
    const toggleEngine = useCallback(() => {
        setEngineOn((on) => {
            if (on) setAutoMode((m) => (m === 'best' ? 'off' : m))
            return !on
        })
    }, [])

    // Analysis-specific bindings, borrowing Lichess's vocabulary (users arrive with
    // it already learned). Move navigation itself is useMoveNavKeys above; these are
    // the extras this page actually has a mechanism for — no dead keys.
    useShortcuts('analysis', [
        { keys: 'f', label: 'Flip board', group: 'Analysis', run: flipBoard },
        { keys: 'l', label: 'Toggle engine', group: 'Analysis', run: toggleEngine },
        ...(isDuck
            ? []
            : [
                  {
                      keys: ' ',
                      label: 'Play engine best move',
                      group: 'Analysis',
                      run: () => {
                          if (engineOn && current.bestUci) onMove(current.bestUci)
                      },
                  },
                  {
                      keys: 'e',
                      label: 'Toggle opening explorer',
                      group: 'Analysis',
                      run: () => setShowOpening((v) => !v),
                  },
              ]),
    ])

    // Stockfish's best move for the CURRENT position (ignore a stale one held for a
    // previous FEN). Only surfaced while the engine + the SF-arrow toggle are on.
    const sfCurrent =
        !isDuck && engineOn && showSfArrow && sfBest?.fen === current.fen ? sfBest : null
    const sfUci = sfCurrent?.uci ?? null
    // The eval-bar line, unlike the arrow, persists the LAST known Stockfish eval
    // while the next one loads (mirrors the main eval's lastRef) — so making a move
    // smoothly animates the line to its new height instead of blinking out. The
    // arrow stays strictly current-position-gated (a stale arrow could point to a
    // move that's now illegal).
    const sfEvForBar = !isDuck && engineOn && showSfArrow ? (sfBest?.evalWhite ?? null) : null

    // Board arrows. A hovered candidate (book) move wins outright — a single blue
    // arrow, no engine overlays. Otherwise we draw gomachine's gold best-move arrow
    // (when its toggle is on) plus, optionally, a translucent Stockfish arrow. When
    // both engines pick the SAME move (comparing from+to, ignoring promo piece) we
    // draw ONE arrow — gomachine's, ringed in the Stockfish color to signal
    // agreement — rather than stacking two identical arrows.
    let arrow: { from: string; to: string; color?: string; outline?: string } | null = null
    let sfArrow: { from: string; to: string; color?: string } | null = null
    // Duck Chess review: the best move is a composite "<pieceUci>:<duckSquare>". The
    // arrow shows the piece move (its from/to are the first four chars, so the
    // ":duckSquare" suffix is harmless), and this ring marks the best DUCK placement
    // — which an arrow can't express and is often exactly where the piece move looked
    // "blocked" from the standard-engine POV.
    let circle: { square: string; color?: string } | null = null
    if (hoverUci) {
        arrow = { from: hoverUci.slice(0, 2), to: hoverUci.slice(2, 4), color: BOOK_ARROW_COLOR }
    } else {
        const goUci = engineOn && showArrow && current.bestUci ? current.bestUci : null
        const agree = !!goUci && !!sfUci && goUci.slice(0, 4) === sfUci.slice(0, 4)
        if (goUci) {
            arrow = {
                from: goUci.slice(0, 2),
                to: goUci.slice(2, 4),
                ...(agree ? { outline: SF_ARROW_COLOR } : {}),
            }
            if (isDuck) {
                const duckSq = goUci.split(':')[1]
                if (duckSq) circle = { square: duckSq }
            }
        }
        if (sfUci && !agree) {
            sfArrow = { from: sfUci.slice(0, 2), to: sfUci.slice(2, 4), color: SF_ARROW_COLOR }
        }
    }

    const lastMove = current.move ? { from: current.move.from, to: current.move.to } : null

    // Free-mode Duck Chess replaces the entire standard board/tree layout with the
    // self-contained interactive duck board (review mode is never duck-free).
    if (!id && duckFree) {
        return <DuckFreeBoard onExit={() => setDuckFree(false)} />
    }

    // Blunder Rewind replaces the review layout with the self-contained retry board
    // (only once a game — persisted or a stateless moves-only replay — is loaded
    // and actually has gradeable blunders).
    if (rewind && game && blunderPuzzles.length > 0) {
        return (
            <BlunderRewind
                game={game}
                onlyColor={myColor ?? undefined}
                onExit={() => setRewind(false)}
            />
        )
    }

    return (
        <BoardPage
            left={
                /* Left column: material + position cards (mirrors the sidebar width, so
            the board stays centered). Setup tools only in free mode — reviewing a
            loaded game shows material alone. */
                <AnalysisAside
                    fen={current.fen}
                    onLoadFen={loadPosition}
                    playBotDisabled={over.over}
                    showSetup={!id}
                    hideActions={isDuck}
                    onEnableDuck={!id ? () => setDuckFree(true) : undefined}
                    getPgn={getPgn}
                    onImportPgn={onImportPgn}
                />
            }
            evalBar={
                prefs.showEvalBar ? (
                    <EvalBar
                        ev={engineOn ? current.evalWhite : null}
                        orientation={displayOrientation}
                        sfEv={sfEvForBar}
                        sfColor={SF_ARROW_COLOR}
                    />
                ) : undefined
            }
            right={
                /* Sidebar */
                <Box
                    sx={{
                        width: { xs: '100%', md: '100%' },
                        justifySelf: { md: 'start' },
                        // Fill the SideColumn's fixed (BOARD_SIZE) height on desktop, so
                        // the flex:1 MoveTree inside gets a DEFINITE height to fill — its
                        // scroll area is position:absolute/inset:0 and collapses to 0 (the
                        // move list vanishes) if this box only sizes to its content.
                        flex: { md: 1 },
                        display: 'flex',
                        flexDirection: 'column',
                        minHeight: 0,
                        border: '1px solid var(--line-soft)',
                        borderRadius: 'var(--panel-radius)',
                        bgcolor: 'var(--surface)',
                        overflow: 'hidden',
                        boxShadow: '0 18px 50px -28px rgba(0,0,0,0.8)',
                        maxHeight: { xs: '72vh', md: 'none' },
                    }}
                >
                    <EngineLines
                        engineOn={engineOn}
                        onToggleEngine={toggleEngine}
                        onPlayLine={onPlayEngineLine}
                        onHoverMove={setHoverUci}
                        lines={analysisLines}
                        fen={current.fen}
                        isDuck={isDuck}
                        mainSan={isDuck ? (current.bestSan ?? null) : null}
                        // Local engine has no duck rules (same reason the Stockfish arrow
                        // is duck-gated above) — omit the control entirely for duck review.
                        headerExtra={
                            !isDuck ? (
                                <LocalEngineControl
                                    capability={localRace.capability}
                                    enabled={localEngineOn}
                                    onToggle={() => localRace.setEnabled(!localEngineOn)}
                                    download={localRace.download}
                                    onRetry={localRace.retry}
                                />
                            ) : undefined
                        }
                        // Shown whenever the DISPLAYED eval came from the server's
                        // eval cache rather than a search — with the local engine on
                        // or off. Disappears the instant a local (or fresher server)
                        // result supersedes it, since displayCandidates[node] is
                        // overwritten with that result's own source.
                        sourceBadge={
                            !isDuck && displayCandidates[current.id]?.source === 'cache' ? 'cache' : null
                        }
                    />

                    <MoveTree tree={tree} currentId={currentId} onSelect={selectNode} />

                    {id && <Header game={game} loading={loading} loadError={loadError} />}

                    {/* Blunder Rewind: replay the game's blunders as retry puzzles. */}
                    {game && blunderPuzzles.length > 0 && (
                        <BlunderRewindBanner
                            count={blunderPuzzles.length}
                            onStart={() => setRewind(true)}
                        />
                    )}

                    {/* Footer: auto playback + navigation */}
                    <Box
                        sx={{
                            borderTop: '1px solid var(--line-soft)',
                            bgcolor: 'var(--bg-2)',
                            p: 1.25,
                            display: 'flex',
                            flexDirection: 'column',
                            gap: 1.25,
                        }}
                    >
                        {/* Auto playback */}
                        <Box sx={{ display: 'flex', gap: 1 }}>
                            <AutoBtn
                                active={autoMode === 'play'}
                                disabled={autoMode !== 'play' && current.children.length === 0}
                                onClick={() => toggleAuto('play')}
                                icon={
                                    autoMode === 'play' ? <Square size={15} /> : <Play size={15} />
                                }
                                label={autoMode === 'play' ? 'Stop' : 'Auto Play'}
                                tip={
                                    autoMode === 'play'
                                        ? 'Stop auto play'
                                        : current.children.length === 0
                                            ? 'Already at the latest move'
                                            : 'Play through the moves in the list'
                                }
                            />
                            {/* Auto Best plays engine moves via chess.js — standard-only. */}
                            {!isDuck && (
                                <AutoBtn
                                    active={autoMode === 'best'}
                                    onClick={() => toggleAuto('best')}
                                    icon={
                                        autoMode === 'best' ? (
                                            <Square size={15} />
                                        ) : (
                                            <Zap size={15} />
                                        )
                                    }
                                    label={autoMode === 'best' ? 'Stop' : 'Auto Best'}
                                />
                            )}
                        </Box>

                        {/* Navigation + view toggles */}
                        <Box sx={{ display: 'flex', alignItems: 'center', gap: 0.5 }}>
                            <NavBtn onClick={goStart} label="Start" grow>
                                <ChevronFirst size={21} />
                            </NavBtn>
                            <NavBtn onClick={goPrev} label="Previous" grow>
                                <ChevronLeft size={21} />
                            </NavBtn>
                            <NavBtn onClick={goNext} label="Next" grow>
                                <ChevronRight size={21} />
                            </NavBtn>
                            <NavBtn onClick={goEnd} label="End" grow>
                                <ChevronLast size={21} />
                            </NavBtn>
                            <Box
                                sx={{ width: '1px', height: 26, bgcolor: 'var(--line)', mx: 0.5 }}
                            />
                            <NavBtn
                                onClick={() => setShowArrow((v) => !v)}
                                label="Best move arrow"
                                active={engineOn && showArrow}
                                accent="var(--accent)"
                            >
                                <Target size={19} />
                            </NavBtn>
                            {/* Stockfish second-opinion arrow is standard-only. */}
                            {!isDuck && (
                                <NavBtn
                                    onClick={() => setShowSfArrow((v) => !v)}
                                    label="Stockfish best move arrow"
                                    active={engineOn && showSfArrow}
                                    accent={SF_ARROW_COLOR}
                                >
                                    <Fish size={19} />
                                </NavBtn>
                            )}
                            <NavBtn onClick={flipBoard} label="Flip board">
                                <FlipVertical2 size={19} />
                            </NavBtn>
                            <NavBtn
                                onClick={() => {
                                    const next = !sound
                                    setSound(next)
                                    setSoundEnabled(next)
                                    if (next) sounds.move()
                                }}
                                label={sound ? 'Mute' : 'Unmute'}
                            >
                                {sound ? <Volume2 size={19} /> : <VolumeX size={19} />}
                            </NavBtn>
                        </Box>
                    </Box>

                    {/* Opening explorer / candidates are standard-only (chess.js +
                        standard engine) — hidden for duck review, and toggleable ('e'). */}
                    {!isDuck && showOpening && (
                        <OpeningPanel
                            tree={tree}
                            currentId={currentId}
                            engineOn={engineOn}
                            onMove={onMove}
                            onHoverMove={setHoverUci}
                            // The board already runs a MultiPV ladder against this exact
                            // position (above) — drive the panel off that instead of firing
                            // a second, disagreeing /candidates search.
                            external={{
                                lines: analysisLines,
                                opening: analysisOpening,
                                loading: linesLoading,
                            }}
                        />
                    )}
                </Box>
            }
        >
            <Board
                fen={current.fen}
                orientation={displayOrientation}
                sideToMove={sideToMove}
                legalMoves={legalMoves}
                lastMove={lastMove}
                inCheck={over.check}
                // Duck review is playback-only — no move input / variations (the client
                // has no duck rules). Navigation is via the move list + nav buttons.
                interactive={!isDuck}
                onMove={onMove}
                arrow={arrow}
                arrow2={sfArrow}
                circle={circle}
                duck={isDuck ? current.duck || null : null}
            />
            <ConfirmDialog
                open={pendingImport !== null}
                title="Replace the current game?"
                message="Importing this PGN discards the moves on the board. This can't be undone."
                confirmLabel="Import"
                danger
                onConfirm={() => {
                    if (pendingImport) applyImport(pendingImport)
                    setPendingImport(null)
                }}
                onClose={() => setPendingImport(null)}
            />
        </BoardPage>
    )
}

function AutoBtn({
    active,
    onClick,
    icon,
    label,
    tip,
    disabled,
}: {
    active?: boolean
    onClick: () => void
    icon: React.ReactNode
    label: string
    tip?: string
    disabled?: boolean
}) {
    const button = (
        <Box component="span" sx={{ flex: 1, display: 'flex' }}>
            <Button
                onClick={onClick}
                aria-label={label}
                startIcon={icon}
                disableRipple
                disabled={disabled}
                sx={{
                    flex: 1,
                    height: 46,
                    textTransform: 'none',
                    fontFamily: 'var(--font-display)',
                    fontSize: 14,
                    fontWeight: 600,
                    letterSpacing: 0.2,
                    borderRadius: '10px',
                    gap: 0.4,
                    color: active ? '#15171c' : 'var(--text)',
                    background: active
                        ? 'linear-gradient(180deg, #e3b56a, #d8a657)'
                        : 'var(--surface-2)',
                    border: active ? '1px solid var(--accent)' : '1px solid var(--line)',
                    boxShadow: active ? '0 0 16px -4px rgba(216,166,87,0.6)' : 'none',
                    transition:
                        'background-color .15s, color .15s, border-color .15s, box-shadow .2s',
                    '& .MuiButton-startIcon': { mr: 0.2 },
                    '&:hover': {
                        background: active
                            ? 'linear-gradient(180deg, #e7bd76, #dcab5d)'
                            : 'var(--line)',
                        color: active ? '#15171c' : 'var(--accent)',
                        borderColor: active ? 'var(--accent)' : 'var(--accent-line)',
                    },
                    '&:active': { transform: 'translateY(1px)' },
                    '&.Mui-disabled': {
                        color: 'var(--muted)',
                        background: 'var(--surface-2)',
                        border: '1px solid var(--line-soft)',
                        opacity: 0.5,
                    },
                }}
            >
                {label}
            </Button>
        </Box>
    )

    // span wrapper so the tooltip still works while the button is disabled
    return tip ? (
        <Tooltip title={tip} arrow>
            {button}
        </Tooltip>
    ) : (
        button
    )
}

function NavBtn({
    onClick,
    label,
    active,
    grow,
    accent,
    children,
}: {
    onClick: () => void
    label: string
    active?: boolean
    grow?: boolean
    // Optional per-button accent (e.g. the color of the arrow this toggle controls).
    // When set, the icon is ALWAYS tinted this color — so the button↔arrow mapping
    // reads at a glance, on or off — and the active glow/border use it too. Derived
    // soft/line tints come from color-mix so any hex or CSS var works.
    accent?: string
    children: React.ReactNode
}) {
    const tinted = accent != null
    const acc = accent ?? 'var(--accent)'
    const soft = tinted ? `color-mix(in srgb, ${acc} 16%, transparent)` : 'var(--accent-soft)'
    const line = tinted ? `color-mix(in srgb, ${acc} 42%, transparent)` : 'var(--accent-line)'
    return (
        <Tooltip title={label} arrow>
            <Button
                onClick={onClick}
                aria-label={label}
                disableRipple
                sx={{
                    minWidth: 0,
                    flex: grow ? 1 : 'none',
                    width: grow ? 'auto' : 44,
                    height: 42,
                    p: 0,
                    borderRadius: '9px',
                    color: active || tinted ? acc : 'var(--text-dim)',
                    bgcolor: active ? soft : 'transparent',
                    border: active ? `1px solid ${line}` : '1px solid transparent',
                    boxShadow: active && tinted ? `0 0 14px -5px ${acc}` : 'none',
                    transition: 'background-color .15s, color .15s, border-color .15s, box-shadow .2s',
                    '&:hover': {
                        color: acc,
                        bgcolor: active ? soft : tinted ? soft : 'var(--line)',
                    },
                    '&:active': { transform: 'translateY(1px)' },
                }}
            >
                {children}
            </Button>
        </Tooltip>
    )
}

// The game header (players / result / accuracy). Only rendered in review mode
// (loaded game); free mode has no header — the engine line sits at the top.
function Header({
    game,
    loading,
    loadError,
}: {
    game: GameAnalysis | null
    loading: boolean
    loadError: string | null
}) {
    const { user } = useAuth()

    if (loading) {
        return (
            <Box sx={{ p: 1.5, borderTop: '1px solid var(--line-soft)' }}>
                <Typography sx={{ fontSize: 13.5, color: 'var(--text-dim)' }}>
                    Analyzing game…
                </Typography>
            </Box>
        )
    }
    if (loadError || !game) {
        return (
            <Box sx={{ p: 1.5, borderTop: '1px solid var(--line-soft)' }}>
                <Typography sx={{ fontSize: 13.5, color: '#ca4a4a' }}>
                    {loadError ?? 'Game not found'}
                </Typography>
            </Box>
        )
    }

    const w = game.summary.w
    const b = game.summary.b

    // Result line: "{winner} won." (or "Draw"). Colored from the *viewer's* own
    // result: green when the signed-in user won, red when they lost, neutral on a
    // draw or when they're just analyzing someone else's game (name-matched
    // against the signed-in user).
    const me = user?.name
    const draw = game.result === '1/2-1/2'
    const winner = game.result === '1-0' ? game.whiteName : game.blackName
    const resultText = draw ? 'Draw' : `${winner} won.`
    const amPlayer = !!me && (me === game.whiteName || me === game.blackName)
    const iWon = !!me && !draw && me === winner
    const resultColor = !amPlayer || draw ? 'var(--text-dim)' : iWon ? '#5b9e5b' : '#ca4a4a'

    // One labeled row per metric, White vs Black side by side. Accuracy is a
    // percentage (higher = better); the rest are counts of move-quality slips,
    // colored by severity and dimmed at zero so a clean game stays calm.
    const rows: StatRowData[] = [
        { label: 'Accuracy', w: `${w.accuracy}%`, b: `${b.accuracy}%`, color: 'var(--text)' },
        { label: 'Inaccuracies', w: w.inaccuracy, b: b.inaccuracy, color: '#e0a33e', count: true },
        { label: 'Mistakes', w: w.mistake, b: b.mistake, color: '#e08a3e', count: true },
        { label: 'Blunders', w: w.blunder, b: b.blunder, color: '#ca4a4a', count: true },
    ]

    return (
        <Box sx={{ p: 1.5, borderTop: '1px solid var(--line-soft)' }}>
            <Box
                sx={{
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'space-between',
                    gap: 1,
                    mb: 1,
                }}
            >
                <Box sx={{ display: 'flex', alignItems: 'center', gap: 0.75, minWidth: 0 }}>
                    <Typography sx={{ fontWeight: 600, fontSize: 13.5, letterSpacing: 0.2 }}>
                        Game review
                    </Typography>
                    {game.variant === 'duck' && (
                        <Box
                            component="span"
                            sx={{
                                fontFamily: 'var(--font-mono)',
                                fontSize: 10.5,
                                fontWeight: 700,
                                letterSpacing: 0.4,
                                textTransform: 'uppercase',
                                color: 'var(--accent)',
                                bgcolor: 'var(--accent-soft)',
                                border: '1px solid var(--accent-line)',
                                borderRadius: '5px',
                                px: 0.6,
                                py: '1px',
                                flexShrink: 0,
                            }}
                        >
                            Duck Chess
                        </Box>
                    )}
                </Box>
                <Typography sx={{ fontSize: 13, fontWeight: 600, color: resultColor }}>
                    {resultText}
                </Typography>
            </Box>

            <Box
                sx={{
                    display: 'grid',
                    gridTemplateColumns: '1fr minmax(56px, auto) minmax(56px, auto)',
                    columnGap: 1.25,
                    rowGap: 0.65,
                    alignItems: 'center',
                }}
            >
                {/* Header row: the two players over their value columns. */}
                <Box />
                <PlayerHead name={game.whiteName} light />
                <PlayerHead name={game.blackName} />

                {rows.map((r) => (
                    <Fragment key={r.label}>
                        <Typography sx={{ fontSize: 12, color: 'var(--text-dim)' }}>
                            {r.label}
                        </Typography>
                        <StatVal value={r.w} color={r.color} dim={r.count === true && r.w === 0} />
                        <StatVal value={r.b} color={r.color} dim={r.count === true && r.b === 0} />
                    </Fragment>
                ))}
            </Box>
        </Box>
    )
}

interface StatRowData {
    label: string
    w: number | string
    b: number | string
    color: string
    count?: boolean // counts dim to muted at zero; accuracy never does
}

// A player's name over its stat column, with a light/dark dot marking the side.
function PlayerHead({ name, light }: { name: string; light?: boolean }) {
    return (
        <Box
            sx={{
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'flex-end',
                gap: 0.5,
                minWidth: 0,
            }}
        >
            <Box
                sx={{
                    width: 9,
                    height: 9,
                    borderRadius: '50%',
                    flexShrink: 0,
                    bgcolor: light ? '#ece9e1' : '#15171c',
                    border: '1px solid var(--line)',
                }}
            />
            <Typography
                sx={{
                    fontSize: 12,
                    fontWeight: 600,
                    color: 'var(--text)',
                    whiteSpace: 'nowrap',
                    overflow: 'hidden',
                    textOverflow: 'ellipsis',
                    maxWidth: 92,
                }}
                title={name}
            >
                {name}
            </Typography>
        </Box>
    )
}

function StatVal({ value, color, dim }: { value: number | string; color: string; dim?: boolean }) {
    return (
        <Typography
            sx={{
                fontFamily: 'var(--font-mono)',
                fontSize: 12.5,
                fontWeight: 600,
                textAlign: 'right',
                color: dim ? 'var(--muted)' : color,
            }}
        >
            {value}
        </Typography>
    )
}
