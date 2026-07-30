import { useEffect, useMemo, useRef, useState } from 'react'
import {
    Box,
    Button,
    MenuItem,
    Select,
    Slider,
    TextField,
    ToggleButton,
    ToggleButtonGroup,
    Typography,
} from '@mui/material'
import {
    Bot,
    Cpu,
    FlipVertical2,
    Laptop,
    Pause,
    Play,
    RotateCcw,
    SquarePen,
    Telescope,
    Volume2,
    VolumeX,
    Zap,
} from 'lucide-react'
import { useLocation, useNavigate } from 'react-router-dom'
import Board from '../components/Board'
import BoardPage from '../components/BoardPage'
import EvalBar, { type WhiteEval } from '../components/EvalBar'
import MoveList from '../components/MoveList'
import OpeningPanel from '../components/OpeningPanel'
import { buildFromMoves } from '../lib/analysisTree'
import { ErrorBanner, NavBtn } from '../components/PanelUI'
import {
    analyze,
    type Color,
    engineVsMove,
    type EngineSide,
    type EngineVsVariant,
    type GameStatus,
    type MoveEntry,
} from '../api/client'
import { useAuth } from '../lib/auth'
import { statusLabel } from '../lib/chess'
import { playForSan, setSoundEnabled, soundEnabled, sounds } from '../lib/sounds'
import { useMoveNavKeys } from '../lib/useMoveNavKeys'
import {
    parsePocket,
    pocketFromFen,
    random960,
    stripCrazyhouseFen,
    VARIANT_LABEL,
} from '../lib/variants'
import Pocket from '../components/Pocket'
import {
    coordToRating,
    ratingLabel,
    ratingToCoord,
    UNLOSABLE_RATING,
    UNLOSABLE_SLOT,
} from '../lib/botSettings'
import { useLocalEngineOpponent } from '../lib/engine/useLocalEngineOpponent'

const START_FEN = 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1'
// Crazyhouse's canonical start carries an empty pocket "[]".
const CRAZYHOUSE_START_FEN = 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR[] w KQkq - 0 1'

// The variants this admin view can drive, in display order.
const EVE_VARIANTS: EngineVsVariant[] = ['standard', 'chess960', 'crazyhouse', 'duck', 'antichess']
// "Self-search" variants have their own engine (own rules + eval), do NOT use the
// opening book or aggression, and are gomachine/zugzwang-only. chess960 is NOT one
// of these — it rides the standard engine path (the FEN's castling carries the shuffle).
const SELF_VARIANTS: EngineVsVariant[] = ['crazyhouse', 'duck', 'antichess']
const isSelfVariant = (v: EngineVsVariant) => SELF_VARIANTS.includes(v)

// Engine↔variant compatibility. Standard is playable by everything; chess960 adds
// zugzwang-local (the wasm build ships the same generalized castling movegen, and
// the position is FEN-driven); the fairy variants are gomachine/zugzwang only —
// Stockfish is a bare UCI proxy and the wasm build has no variant rules compiled
// in. Mirrors the server-side guard in EngineMatchController so the UI never
// offers a pairing the backend rejects.
const enginesForVariant = (v: EngineVsVariant): EngineKind[] =>
    v === 'standard'
        ? ['gomachine', 'zugzwang', 'zugzwang-local', 'stockfish']
        : v === 'chess960'
          ? ['gomachine', 'zugzwang', 'zugzwang-local']
          : ['gomachine', 'zugzwang']

// The starting FEN for a fresh game of each variant (chess960 reshuffles each time).
const startFenForVariant = (v: EngineVsVariant): string =>
    v === 'chess960' ? random960() : v === 'crazyhouse' ? CRAZYHOUSE_START_FEN : START_FEN

const MAX_PLIES = 400 // hard stop so two shuffling engines can't loop forever
const MOVE_DELAY = 550 // ms between plies, so it's watchable
// Blue board arrow drawn when hovering a candidate (book) move (matches Analysis).
const BOOK_ARROW_COLOR = '#4c8bf5'

const sideToMoveOf = (fen: string): Color => (fen.split(' ')[1] === 'b' ? 'b' : 'w')

// ---- Strength scales -----------------------------------------------------------
// gomachine / zugzwang: the engine owns the rating→strength relationship end-to-end.
// zugzwang's `limits.rating` ladder runs on the engine's own scale — RatingMin..RatingMax
// = 700..3500, where 3500 is the engine's TRUE full strength (~3500 CCRL) and plays with
// NO weakening at all; below ~2850 play is human-like-weakened, and [2850,3500) is a
// clean-search strength gradient. This admin page sends the raw slider value straight
// through as the engine rating, no client-side conversion. Bounds mirror the engine constants.
const GOMA_RATING_MIN = 700
const GOMA_RATING_MAX = 3500

// Stockfish: UCI_Elo runs FAR below CCRL and SATURATES at ~3100 on our prod build
// (UCI_Elo 3100 == 3190 == full strength). We display a truthful CCRL-ish number instead
// of SF's own (misleading) figure, anchored at the one hard data point we have: UCI 3000
// ≈ 3400 CCRL. At the top notch we UNCAP Stockfish entirely (send elo=0 → no
// UCI_LimitStrength) and label it "Unleashed" — ~3700–4000, clearly above gomachine/zugzwang.
const SF_UCI_MIN = 1320
const SF_UNLEASHED_UCI = 3100 // slider top notch; at/above here SF plays at full force
// affine on the UCI scale: UCI 1320→~1500, UCI 3000→3400 (slope ≈1.13, gap widens up top).
function sfDisplayElo(uci: number): number {
    return Math.round(1500 + (uci - SF_UCI_MIN) * ((3400 - 1500) / (3000 - SF_UCI_MIN)))
}
function sfIsUnleashed(uci: number): boolean {
    return uci >= SF_UNLEASHED_UCI
}
function sfLabel(uci: number): string {
    return sfIsUnleashed(uci) ? 'Unleashed' : `~${sfDisplayElo(uci)} Elo`
}

// ---- Search-budget bounds ------------------------------------------------------
const MOVETIME_MIN = 20
const MOVETIME_MAX = 5000
const MOVETIME_STEP = 20
const DEPTH_MIN = 1
const DEPTH_MAX = 30
const NODES_MIN = 1_000
const NODES_MAX = 50_000_000

// 'zugzwang-local' is the in-browser wasm build. It is NOT a server-side engine:
// it searches in this tab and its move is sent to the same admin endpoint purely
// to be applied, so both sides of a match are adjudicated by identical rules code.
// That makes zugzwang vs zugzwang-local a direct check that the wasm build plays
// like the native one.
type EngineKind = EngineSide | 'zugzwang-local'
const isLocalEngine = (k: EngineKind): boolean => k === 'zugzwang-local'
type LimitKind = 'movetime' | 'nodes' | 'depth' // stockfish uses movetime | depth only

// One side's full configuration. gomachine/zugzwang fields (rating/aggr/book) and
// the stockfish field (sfElo) coexist so switching engine keeps each side's last
// settings; only the fields for the ACTIVE engine are ever sent. gomachine and
// zugzwang share the exact same field shape — zugzwang's `/bestmove` honors
// rating/movetime/nodes/depth; aggr/book are stubbed server-side but sent the
// same way for forward-compat.
interface SideConfig {
    engine: EngineKind
    rating: number // gomachine/zugzwang target Elo (700..3500, display == engine rating)
    aggr: number // gomachine/zugzwang aggression 0..100 (50 = neutral)
    book: boolean // gomachine/zugzwang: consult the opening book on the rating path
    sfElo: number // Stockfish UCI_Elo (1320..3100; 3100 = Unleashed/uncapped)
    limitKind: LimitKind // which budget dimension is active
    movetime: number // ms/move
    nodes: number // fixed node budget (gomachine/zugzwang only)
    depth: number // fixed search depth
}

const DEFAULT_WHITE: SideConfig = {
    engine: 'gomachine',
    rating: GOMA_RATING_MAX,
    aggr: 50,
    book: false,
    sfElo: 3000,
    limitKind: 'movetime',
    movetime: 300,
    nodes: 100_000,
    depth: 12,
}
const DEFAULT_BLACK: SideConfig = { ...DEFAULT_WHITE, engine: 'stockfish' }

// The left-card settings persist to localStorage, so whatever you last set becomes
// your new defaults on the next visit. Key is versioned (v2) — the old single-engine
// shape is intentionally not migrated.
const SETTINGS_KEY = 'eve.settings.v3'
interface EveSettings {
    white: SideConfig
    black: SideConfig
    variant?: EngineVsVariant // which variant the board is set to
}
const DEFAULT_SETTINGS: EveSettings = {
    white: DEFAULT_WHITE,
    black: DEFAULT_BLACK,
    variant: 'standard',
}

const clamp = (n: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, n))

function coerceSide(p: Partial<SideConfig> | undefined, def: SideConfig): SideConfig {
    if (!p || typeof p !== 'object') return def
    return {
        engine:
            p.engine === 'stockfish'
                ? 'stockfish'
                : p.engine === 'zugzwang-local'
                  ? 'zugzwang-local'
                  : p.engine === 'zugzwang'
                    ? 'zugzwang'
                    : 'gomachine',
        rating:
            typeof p.rating === 'number'
                ? p.rating <= UNLOSABLE_RATING
                    ? UNLOSABLE_RATING // preserve the "Unlosable" sentinel (rating 0)
                    : clamp(p.rating, GOMA_RATING_MIN, GOMA_RATING_MAX)
                : def.rating,
        aggr: typeof p.aggr === 'number' ? clamp(p.aggr, 0, 100) : def.aggr,
        book: typeof p.book === 'boolean' ? p.book : def.book,
        sfElo:
            typeof p.sfElo === 'number' ? clamp(p.sfElo, SF_UCI_MIN, SF_UNLEASHED_UCI) : def.sfElo,
        limitKind:
            p.limitKind === 'nodes' || p.limitKind === 'depth' || p.limitKind === 'movetime'
                ? p.limitKind
                : def.limitKind,
        movetime:
            typeof p.movetime === 'number'
                ? clamp(p.movetime, MOVETIME_MIN, MOVETIME_MAX)
                : def.movetime,
        nodes: typeof p.nodes === 'number' ? clamp(p.nodes, NODES_MIN, NODES_MAX) : def.nodes,
        depth: typeof p.depth === 'number' ? clamp(p.depth, DEPTH_MIN, DEPTH_MAX) : def.depth,
    }
}

function loadSettings(): EveSettings {
    try {
        const raw = localStorage.getItem(SETTINGS_KEY)
        if (!raw) return DEFAULT_SETTINGS
        const p = JSON.parse(raw) as Partial<EveSettings>
        return {
            white: coerceSide(p.white, DEFAULT_WHITE),
            black: coerceSide(p.black, DEFAULT_BLACK),
            variant:
                typeof p.variant === 'string' && EVE_VARIANTS.includes(p.variant as EngineVsVariant)
                    ? (p.variant as EngineVsVariant)
                    : 'standard',
        }
    } catch {
        return DEFAULT_SETTINGS // unparseable / storage unavailable → fall back to defaults
    }
}

// Build the engineVsMove params for the side to move, sending ONLY the active
// budget dimension (the backend pins to exactly one; the others must be omitted).
type MoveParams = Parameters<typeof engineVsMove>[0]
function paramsForSide(
    cfg: SideConfig,
    fen: string,
    variant: EngineVsVariant,
    duck: string,
    localMove?: string,
): MoveParams {
    if (isLocalEngine(cfg.engine)) {
        // The move was already chosen in this tab. The server searches nothing —
        // it validates and applies, so the resulting FEN/SAN/status come out of the
        // same rules code that adjudicates every other engine's ply.
        return { fen, side: 'zugzwang-local', variant, move: localMove ?? '' }
    }
    if (cfg.engine === 'stockfish') {
        // Stockfish is standard-only here (the engine picker enforces it), so no
        // variant/duck is ever sent on this branch.
        const elo = sfIsUnleashed(cfg.sfElo) ? 0 : cfg.sfElo
        // Stockfish supports movetime | depth only.
        return cfg.limitKind === 'depth'
            ? { fen, side: 'stockfish', elo, depth: cfg.depth }
            : { fen, side: 'stockfish', elo, movetime: cfg.movetime }
    }
    // gomachine and zugzwang share the exact same param shape — only `side` differs.
    // `variant` routes to the right engine endpoint server-side; chess960 rides the
    // standard path (FEN-driven). Duck also forwards the current duck square.
    const side: 'gomachine' | 'zugzwang' = cfg.engine === 'zugzwang' ? 'zugzwang' : 'gomachine'
    const base: MoveParams = { fen, side, variant, rating: cfg.rating, aggr: cfg.aggr, book: cfg.book }
    if (variant === 'duck') base.duck = duck
    if (cfg.limitKind === 'depth') return { ...base, depth: cfg.depth }
    if (cfg.limitKind === 'nodes') return { ...base, nodes: cfg.nodes }
    return { ...base, movetime: cfg.movetime }
}

// EvE is the one page that keeps the raw engine identifiers as labels (not the
// site-wide "Zugzwang" rebrand) — this is an admin tool for comparing the actual
// engines, so it names them literally.
const engineName = (k: EngineKind) =>
    k === 'stockfish' ? 'Stockfish' : k === 'zugzwang-local' ? 'zugzwang LOCAL' : k
function sideDetail(cfg: SideConfig): string {
    if (cfg.engine === 'stockfish') return sfLabel(cfg.sfElo)
    // The wasm build has no rating ladder wired up — it always plays full strength,
    // so reporting a rating here would be a lie. Show the budget instead, which is
    // the only knob that actually changes how it plays.
    if (isLocalEngine(cfg.engine)) {
        return cfg.limitKind === 'depth' ? `depth ${cfg.depth}` : `${cfg.movetime} ms`
    }
    return ratingLabel(cfg.rating)
}
function engineIcon(k: EngineKind) {
    if (k === 'gomachine') return <Cpu size={16} />
    if (k === 'zugzwang') return <Zap size={16} />
    if (k === 'zugzwang-local') return <Laptop size={16} />
    return <Bot size={16} />
}

/** Admin-only: watch any pairing of our two engines (gomachine, zugzwang) and
 * Stockfish play each other — any engine on either side, including an engine
 * playing itself. Each side is configured independently — engine, strength,
 * search budget (movetime / nodes / depth), plus gomachine/zugzwang's
 * aggression + opening book. The browser drives the game ply-by-ply through the
 * admin proxy; the engines themselves stay stateless. */
export default function EngineVsEngine() {
    const { user, status: authStatus } = useAuth()
    const navigate = useNavigate()
    // A starting position carried over from the board editor ("Engine vs Engine
    // from this position"). Falls back to the standard start.
    const navFen = (useLocation().state as { fen?: string } | null)?.fen ?? null

    // Per-side settings — initialised from (and persisted back to) localStorage.
    // White is the bottom player; Black is the top player (board is White-at-bottom).
    const [white, setWhite] = useState<SideConfig>(() => loadSettings().white)
    const [black, setBlack] = useState<SideConfig>(() => loadSettings().black)
    // The variant the board is set to (standard / chess960 / crazyhouse / duck /
    // antichess). Persisted alongside the side configs. Engine choice is gated per
    // variant (see enginesForVariant) — no engine is ever silently substituted.
    const [variant, setVariant] = useState<EngineVsVariant>(
        () => loadSettings().variant ?? 'standard',
    )
    // The start FEN for the current game. A nav-carried editor position wins;
    // otherwise it's the variant's start (chess960 reshuffles). It changes when the
    // variant changes and on reset (chess960 reshuffles then too).
    const [startFen, setStartFen] = useState<string>(
        () => navFen ?? startFenForVariant(loadSettings().variant ?? 'standard'),
    )

    useEffect(() => {
        try {
            localStorage.setItem(SETTINGS_KEY, JSON.stringify({ white, black, variant }))
        } catch {
            // storage unavailable / quota — settings just won't persist this session
        }
    }, [white, black, variant])

    // Game
    const [fen, setFen] = useState(startFen)
    const [duck, setDuck] = useState('') // Duck Chess: the duck's square ("" = unplaced)
    const [moves, setMoves] = useState<MoveEntry[]>([])
    const [status, setStatus] = useState<GameStatus>('ongoing')
    const [result, setResult] = useState<string | null>(null)
    const [lastMove, setLastMove] = useState<{ from: string; to: string } | null>(null)
    const [whiteEval, setWhiteEval] = useState<WhiteEval | null>(null)
    const [running, setRunning] = useState(false)
    const [error, setError] = useState<string | null>(null)
    const [sound, setSound] = useState(soundEnabled())
    const [orientation, setOrientation] = useState<Color>('w')
    // Client-side history browsing (null = follow the live position). The engines
    // keep playing while you scrub back — this only changes what's DISPLAYED; the
    // live `fen` below stays authoritative for the engine loop, and new-move sounds
    // still fire (they're played in the loop, not gated on the viewed ply).
    const [viewIndex, setViewIndex] = useState<number | null>(null)
    const thinkingRef = useRef(false)
    // The in-browser engine, when either side is set to zugzwang-local. Loading is
    // deferred until a local side is actually selected — nobody watching two server
    // engines should pay a 36 MB download.
    const local = useLocalEngineOpponent()
    const wantsLocal = isLocalEngine(white.engine) || isLocalEngine(black.engine)
    useEffect(() => {
        if (wantsLocal) local.load()
    }, [wantsLocal, local])

    const ply = moves.length
    const over = status !== 'ongoing'
    const sideToMove = sideToMoveOf(fen)
    const moverCfg = sideToMove === 'w' ? white : black

    // The viewed ply: clamped to the live move count so a shrinking list (reset)
    // snaps back to live. Each move entry carries its own resulting FEN + duck, so
    // reviewing a past position is a direct lookup — no replay.
    const shownPly = viewIndex === null ? ply : Math.min(viewIndex, ply)
    const atLive = shownPly === ply
    const boardFen = atLive ? fen : shownPly === 0 ? startFen : moves[shownPly - 1].fen
    const shownLast = atLive
        ? lastMove
        : shownPly > 0
          ? {
                from: moves[shownPly - 1].uci.slice(0, 2),
                to: moves[shownPly - 1].uci.slice(2, 4),
            }
          : null
    const shownDuck: string | null =
        variant === 'duck'
            ? atLive
                ? duck || null
                : (moves[shownPly - 1]?.duck ?? null)
            : null
    // Crazyhouse pockets for the shown position (parsed from the shown FEN, which
    // carries the "[pocket]" field). Empty for every other variant.
    const shownPockets = variant === 'crazyhouse' ? parsePocket(pocketFromFen(boardFen)) : null
    // The board renderer wants a plain FEN — strip Crazyhouse's "[pocket]"/"~" markup.
    const renderFen = variant === 'crazyhouse' ? stripCrazyhouseFen(boardFen) : boardFen

    // History navigation (client-side review only).
    const goFirst = () => setViewIndex(0)
    const goPrev = () => setViewIndex(Math.max(0, shownPly - 1))
    const goNext = () => {
        const n = Math.min(ply, shownPly + 1)
        setViewIndex(n >= ply ? null : n)
    }
    const goLast = () => setViewIndex(null)
    const selectPly = (p: number) => setViewIndex(p >= ply ? null : p)
    useMoveNavKeys({ onPrev: goPrev, onNext: goNext, onFirst: goFirst, onLast: goLast })

    // Book panel: a tree of the game line so far, so the engine-owned OpeningPanel
    // can name the opening + show candidate-move eval bars for the live position.
    const { tree: bookTree, lastId: bookNodeId } = useMemo(
        () =>
            buildFromMoves(
                startFen,
                moves.map((m) => m.uci),
            ),
        [startFen, moves],
    )
    // UCI of the hovered book move → a blue arrow on the board (cleared each ply).
    const [hoverUci, setHoverUci] = useState<string | null>(null)
    useEffect(() => setHoverUci(null), [ply])
    const arrow = hoverUci
        ? { from: hoverUci.slice(0, 2), to: hoverUci.slice(2, 4), color: BOOK_ARROW_COLOR }
        : null

    // The engine loop: when running, fetch the side-to-move's move after a delay,
    // apply it (server returns the new FEN), and let the ply change re-trigger us.
    useEffect(() => {
        if (!running || over) return
        if (ply >= MAX_PLIES) {
            setRunning(false)
            setResult('1/2-1/2')
            return
        }
        // A local side can't move until its net is downloaded and the module booted.
        // Hold the loop rather than starting the ply and failing — `local.download`
        // is a dependency, so the loop resumes by itself the moment it's ready.
        if (isLocalEngine(moverCfg.engine) && local.download.status !== 'ready') {
            local.load() // no-op once started
            return
        }
        let cancelled = false
        const id = setTimeout(async () => {
            thinkingRef.current = true
            try {
                // Every variant goes through the SAME admin endpoint, which dispatches
                // to the mover's chosen engine with NO fallback — so the selected
                // engine truly plays (a "gomachine" pick never quietly becomes
                // zugzwang). The variant bestmove endpoints return the move already
                // applied, so one call per ply drives standard AND every variant.
                // A local side searches HERE, in this tab, and then hands the move to
                // the same endpoint purely to be applied — so the two engines are
                // adjudicated identically and the comparison stays honest.
                let localMove: string | undefined
                if (isLocalEngine(moverCfg.engine)) {
                    const chosen = await local.bestMove(
                        fen,
                        moverCfg.limitKind === 'depth'
                            ? { depth: moverCfg.depth }
                            : { movetime: moverCfg.movetime },
                    )
                    if (cancelled) return
                    if (!chosen) {
                        setRunning(false)
                        setError('local engine returned no move')
                        return
                    }
                    localMove = chosen
                }
                const res = await engineVsMove(paramsForSide(moverCfg, fen, variant, duck, localMove))
                if (cancelled) return
                if (!res.bestmove || !res.fen) {
                    setRunning(false)
                    setError(res.reason ?? 'engine returned no move')
                    return
                }
                // Duck's bestmove is the composite "<pieceUci>:<duckSquare>" — its
                // first four chars are still the piece move for the last-move arrow.
                setLastMove({ from: res.bestmove.slice(0, 2), to: res.bestmove.slice(2, 4) })
                setMoves((m) => [
                    ...m,
                    {
                        ply: m.length + 1,
                        uci: res.bestmove!,
                        san: res.san ?? res.bestmove!,
                        by: 'bot',
                        fen: res.fen!,
                        ...(res.duck ? { duck: res.duck } : {}),
                    },
                ])
                setFen(res.fen)
                if (variant === 'duck') setDuck(res.duck ?? '')
                // Self-search variants (duck/crazyhouse/antichess) have no independent
                // full-strength analyze on the no-fallback admin path, so drive the
                // eval bar from the mover's returned eval (mover = current side to move,
                // converted to White-relative).
                if (isSelfVariant(variant) && res.eval) {
                    setWhiteEval({
                        type: res.eval.type,
                        white: sideToMove === 'w' ? res.eval.value : -res.eval.value,
                    })
                }
                const gameOver = res.status !== 'ongoing' || !!res.claimableDraws?.includes('fifty')
                playForSan(res.san ?? res.bestmove, gameOver) // move/capture/end cue
                if (res.status !== 'ongoing') {
                    setStatus(res.status)
                    setResult(res.result ?? null)
                    setRunning(false)
                } else if (res.claimableDraws?.includes('fifty')) {
                    setStatus('draw-fifty')
                    setResult('1/2-1/2')
                    setRunning(false)
                }
            } catch (e) {
                if (!cancelled) {
                    setError(e instanceof Error ? e.message : 'move failed')
                    setRunning(false)
                }
            } finally {
                thinkingRef.current = false
            }
        }, MOVE_DELAY)
        return () => {
            cancelled = true
            clearTimeout(id)
        }
        // `local` is a dependency so the loop resumes on its own once the in-browser
        // engine finishes loading — otherwise a match with a local side would stall
        // at the first ply until something else happened to re-render.
    }, [running, ply, over, fen, sideToMove, moverCfg, duck, variant, local])

    // Eval bar = ONE consistent evaluator: the site's primary analysis engine at
    // full strength (plain /analyze, no `side` — engine-agnostic, see api/client.ts),
    // re-reading the current position after every ply regardless of who moved. We
    // deliberately do NOT use the mover's own search — a rating-limited (and
    // one-sided) search is misleading, and Stockfish returns no eval at all. A
    // fast (300ms) /analyze keeps the loop snappy while still surfacing forced
    // mates as M1/M2.
    useEffect(() => {
        if (over) {
            // Duck/antichess decide by white_win/black_win (king capture / running out
            // of material); checkmate is a loss for the side to move; everything else
            // (stalemate, draws) is dead even.
            setWhiteEval(
                status === 'white_win'
                    ? { type: 'mate', white: 1 }
                    : status === 'black_win'
                      ? { type: 'mate', white: -1 }
                      : status === 'checkmate'
                        ? { type: 'mate', white: sideToMove === 'w' ? -1 : 1 }
                        : { type: 'cp', white: 0 },
            )
            return
        }
        if (ply === 0) {
            setWhiteEval(null) // neutral bar on the idle start screen
            return
        }
        // Self-search variants set the eval bar from the mover's returned eval inside
        // the move loop (no independent analyzer on the no-fallback admin path).
        if (isSelfVariant(variant)) return
        // Standard + chess960: ONE consistent full-strength evaluator (plain /analyze,
        // engine-agnostic), re-read after every ply regardless of who moved. We
        // deliberately avoid the mover's own rating-limited (one-sided) search.
        let cancelled = false
        analyze(fen, { movetime: 300 })
            .then((r) => {
                if (cancelled || !r.eval) return
                const white = sideToMove === 'w' ? r.eval.value : -r.eval.value
                setWhiteEval({ type: r.eval.type, white })
            })
            .catch(() => {}) // a transient analyze failure just leaves the last eval shown
        return () => {
            cancelled = true
        }
    }, [fen, status, over, sideToMove, ply, variant])

    // Clear the game back to a given start position (adopting it as the new
    // startFen so history review + the book tree stay consistent).
    function clearGame(fresh: string) {
        setRunning(false)
        setStartFen(fresh)
        setFen(fresh)
        setDuck('')
        setMoves([])
        setStatus('ongoing')
        setResult(null)
        setLastMove(null)
        setWhiteEval(null)
        setError(null)
        setViewIndex(null)
    }

    // Reset reshuffles Chess960 (a fresh random back rank each game); every other
    // variant keeps its stable start.
    function reset() {
        clearGame(variant === 'chess960' ? random960() : startFen)
    }

    // Switch variant: gate each side's engine to one this variant can actually play
    // (an incompatible pick falls back to gomachine — the always-compatible engine),
    // lift the "Unlosable" sentinel where the variant has no worst-move path, then
    // start a fresh game at the variant's start position.
    function changeVariant(v: EngineVsVariant) {
        if (v === variant) return
        const allowed = enginesForVariant(v)
        const fix = (s: SideConfig): SideConfig => {
            let next = s
            if (!allowed.includes(s.engine)) next = { ...next, engine: 'gomachine' }
            if (isSelfVariant(v) && next.rating <= UNLOSABLE_RATING)
                next = { ...next, rating: 1500 } // no worst-move path in self-variants
            return next
        }
        setWhite(fix)
        setBlack(fix)
        setVariant(v)
        clearGame(startFenForVariant(v))
    }

    // Re-entering from the editor with a different position: adopt it and reset the
    // game (the initial state only reads navFen once).
    useEffect(() => {
        if (!navFen) return
        clearGame(navFen)
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [navFen])

    function toggleRun() {
        if (over) reset()
        setRunning((r) => !r)
    }

    function toggleSound() {
        const next = !sound
        setSound(next)
        setSoundEnabled(next)
        if (next) sounds.move()
    }

    if (authStatus === 'loading') {
        return <Centered>Loading…</Centered>
    }
    if (user?.role !== 'admin') {
        return <Centered>This page is for admins only.</Centered>
    }

    const caption = over
        ? `${statusLabel(status)}${result ? ` · ${result}` : ''}`
        : running
          ? ''
          : ply > 0
            ? 'Paused'
            : ''

    return (
        <BoardPage
            left={
                <Box sx={{ display: 'flex', flexDirection: 'column', gap: 1.5 }}>
                    <Box
                        sx={{
                            bgcolor: 'var(--surface)',
                            border: '1px solid var(--line-soft)',
                            borderRadius: 'var(--panel-radius)',
                            p: 1.75,
                            boxShadow: '0 18px 50px -28px rgba(0,0,0,0.8)',
                        }}
                    >
                        <Label>Variant</Label>
                        <ToggleButtonGroup
                            exclusive
                            fullWidth
                            size="small"
                            value={variant}
                            onChange={(_, v) => v && changeVariant(v as EngineVsVariant)}
                            disabled={running}
                            sx={{ ...toggleSx, flexWrap: 'wrap' }}
                        >
                            {EVE_VARIANTS.map((v) => (
                                <ToggleButton key={v} value={v} sx={{ flex: '1 0 30%' }}>
                                    {VARIANT_LABEL[v]}
                                </ToggleButton>
                            ))}
                        </ToggleButtonGroup>
                    </Box>

                    {/* Top player's card first: the top of the board is Black when
                        White-oriented, White when flipped. */}
                    {(orientation === 'w' ? (['b', 'w'] as const) : (['w', 'b'] as const)).map(
                        (c) =>
                            c === 'w' ? (
                                <SideControls
                                    key="w"
                                    cfg={white}
                                    onChange={(patch) => setWhite((s) => ({ ...s, ...patch }))}
                                    disabled={running}
                                    variant={variant}
                                />
                            ) : (
                                <SideControls
                                    key="b"
                                    cfg={black}
                                    onChange={(patch) => setBlack((s) => ({ ...s, ...patch }))}
                                    disabled={running}
                                    variant={variant}
                                />
                            ),
                    )}
                </Box>
            }
            evalBar={<EvalBar ev={whiteEval} orientation={orientation} />}
            right={
                <Box sx={{ display: 'flex', flexDirection: 'column', gap: 1.5 }}>
                    <Box
                        sx={{
                            bgcolor: 'var(--surface)',
                            border: '1px solid var(--line-soft)',
                            borderRadius: 'var(--panel-radius)',
                            p: 1.75,
                            display: 'flex',
                            flexDirection: 'column',
                            gap: 1,
                        }}
                    >
                        {(orientation === 'w' ? (['b', 'w'] as const) : (['w', 'b'] as const)).map(
                            (c) => {
                                const cfg = c === 'w' ? white : black
                                return (
                                    <MatchupRow
                                        key={c}
                                        icon={engineIcon(cfg.engine)}
                                        name={engineName(cfg.engine)}
                                        detail={sideDetail(cfg)}
                                        side={c}
                                    />
                                )
                            },
                        )}
                        <Box sx={{ display: 'flex', alignItems: 'center', gap: 1, mt: 0.5 }}>
                            <Typography
                                sx={{ fontSize: 13, fontWeight: 600, color: 'var(--text-dim)' }}
                            >
                                {caption}
                            </Typography>
                            <Box sx={{ flex: 1 }} />
                            <NavBtn
                                label="Edit start position"
                                onClick={() => navigate('/editor', { state: { fen: startFen } })}
                                disabled={running}
                            >
                                <SquarePen size={18} />
                            </NavBtn>
                            <NavBtn
                                label="Analyse"
                                onClick={() =>
                                    navigate('/analysis', {
                                        state: { moves: moves.map((m) => m.uci), startFen },
                                    })
                                }
                                // Analysis board is standard-mechanics (handles chess960
                                // via the FEN) but doesn't understand the self-variants.
                                disabled={isSelfVariant(variant) || moves.length === 0}
                            >
                                <Telescope size={18} />
                            </NavBtn>
                            <NavBtn
                                label="Play a bot from here"
                                onClick={() => navigate('/bot', { state: { fen } })}
                                // The /bot entry starts a standard game from the FEN.
                                disabled={running || variant !== 'standard'}
                            >
                                <Bot size={18} />
                            </NavBtn>
                            <NavBtn
                                label="Flip board"
                                onClick={() => setOrientation((o) => (o === 'w' ? 'b' : 'w'))}
                            >
                                <FlipVertical2 size={18} />
                            </NavBtn>
                            <NavBtn label={sound ? 'Mute' : 'Unmute'} onClick={toggleSound}>
                                {sound ? <Volume2 size={18} /> : <VolumeX size={18} />}
                            </NavBtn>
                        </Box>
                    </Box>

                    {/* Crazyhouse "in hand": pockets for the shown position (top =
                        Black when White-oriented). Display-only in this admin view. */}
                    {variant === 'crazyhouse' && shownPockets && (
                        <Box
                            sx={{
                                bgcolor: 'var(--surface)',
                                border: '1px solid var(--line-soft)',
                                borderRadius: 'var(--panel-radius)',
                                p: 1.5,
                                display: 'flex',
                                flexDirection: 'column',
                                gap: 0.75,
                            }}
                        >
                            <Label>In hand</Label>
                            <Pocket
                                color={orientation === 'w' ? 'b' : 'w'}
                                pocket={shownPockets}
                                selected={null}
                                interactive={false}
                                onSelect={() => {}}
                            />
                            <Pocket
                                color={orientation}
                                pocket={shownPockets}
                                selected={null}
                                interactive={false}
                                onSelect={() => {}}
                            />
                        </Box>
                    )}

                    {/* Run controls */}
                    <Box sx={{ display: 'flex', gap: 1 }}>
                        <RunBtn
                            primary
                            icon={running ? <Pause size={16} /> : <Play size={16} />}
                            label={running ? 'Pause' : over ? 'Play again' : 'Start'}
                            onClick={toggleRun}
                        />
                        <RunBtn icon={<RotateCcw size={16} />} label="Reset" onClick={reset} />
                    </Box>

                    {error && <ErrorBanner>{error}</ErrorBanner>}
                    <Box sx={{ height: 420, display: 'flex' }}>
                        <MoveList
                            fill
                            moves={moves}
                            currentPly={shownPly}
                            onSelectPly={selectPly}
                        />
                    </Box>

                    {/* Book info: opening name + candidate-move eval bars for the live
                        position (engine-owned). Hover a move for its arrow + opening;
                        click to open that line in the analysis board. Standard-only —
                        the opening book is keyed to the standard start; chess960 and the
                        self-variants have no book. */}
                    {variant === 'standard' && (
                        <Box
                            sx={{
                                bgcolor: 'var(--surface)',
                                border: '1px solid var(--line-soft)',
                                borderRadius: 'var(--panel-radius)',
                                overflow: 'hidden',
                            }}
                        >
                            <OpeningPanel
                                tree={bookTree}
                                currentId={bookNodeId}
                                engineOn
                                onMove={(uci) =>
                                    navigate('/analysis', {
                                        state: {
                                            moves: [...moves.map((m) => m.uci), uci],
                                            startFen,
                                        },
                                    })
                                }
                                onHoverMove={setHoverUci}
                            />
                        </Box>
                    )}
                </Box>
            }
        >
            <Board
                fen={renderFen}
                orientation={orientation}
                sideToMove={sideToMoveOf(renderFen)}
                legalMoves={[]}
                lastMove={shownLast}
                inCheck={false}
                interactive={false}
                onMove={() => {}}
                arrow={atLive ? arrow : null}
                duck={shownDuck}
            />
        </BoardPage>
    )
}

function MatchupRow({
    icon,
    name,
    detail,
    side,
}: {
    icon: React.ReactNode
    name: string
    detail: string
    side: Color
}) {
    return (
        <Box sx={{ display: 'flex', alignItems: 'center', gap: 1 }}>
            <Box sx={{ color: 'var(--accent)' }}>{icon}</Box>
            <Typography sx={{ fontWeight: 700, fontSize: 14 }}>{name}</Typography>
            <Typography sx={{ fontSize: 12.5, color: 'var(--text-dim)' }}>{detail}</Typography>
            <Box sx={{ flex: 1 }} />
            <Typography
                sx={{ fontSize: 11, color: 'var(--muted)', fontFamily: 'var(--font-mono)' }}
            >
                {side === 'w' ? 'White' : 'Black'}
            </Typography>
        </Box>
    )
}

// One side's configuration card. Renders the engine picker plus only the controls
// that apply to the chosen engine, and pins the search budget to exactly one of
// movetime / nodes / depth.
function SideControls({
    cfg,
    onChange,
    disabled,
    variant,
}: {
    cfg: SideConfig
    onChange: (patch: Partial<SideConfig>) => void
    disabled: boolean
    // The active variant. It gates which engines this side may pick and which
    // knobs apply: Stockfish is standard-only; the self-variants (crazyhouse/duck/
    // antichess) ignore aggression + the opening book and have no worst-move stop.
    variant: EngineVsVariant
}) {
    const allowedEngines = enginesForVariant(variant)
    // Self-search variants have their own engine with its own rating→strength
    // weakening; aggression + book don't apply, and there is no worst-move ("Unlosable")
    // path. chess960 rides the standard engine, so it keeps all standard knobs.
    const self = isSelfVariant(variant)
    // gomachine/zugzwang share identical controls (rating/aggr/book/search-limit
    // incl. nodes) — only Stockfish's differ. Stockfish only ever appears in standard.
    const isRatingEngine = cfg.engine !== 'stockfish'
    const allowUnlosable = isRatingEngine && !self
    // Stockfish offers only movetime | depth; if the stored kind is 'nodes' (carried
    // over from gomachine/zugzwang), treat it as movetime for the toggle + sending.
    const effKind: LimitKind =
        !isRatingEngine && cfg.limitKind === 'nodes' ? 'movetime' : cfg.limitKind

    return (
        <Box
            sx={{
                bgcolor: 'var(--surface)',
                border: '1px solid var(--line-soft)',
                borderRadius: 'var(--panel-radius)',
                p: 1.75,
                display: 'flex',
                flexDirection: 'column',
                gap: 1,
                boxShadow: '0 18px 50px -28px rgba(0,0,0,0.8)',
            }}
        >
            {/* Engine picker — only the engines the active variant can actually play
                (Stockfish appears in standard only). A dropdown rather than a toggle
                row: with four engines the buttons no longer fit the card and spilled
                out its right edge. */}
            <Box>
                <Label>Engine</Label>
                <Select
                    fullWidth
                    size="small"
                    value={cfg.engine}
                    disabled={disabled}
                    onChange={(e) => {
                        const v = e.target.value as EngineKind
                        // Neither Stockfish nor the wasm build has a nodes mode, so a
                        // nodes budget carried over from gomachine/zugzwang would be
                        // invalid — coerce it to movetime as we switch.
                        const needsMovetime =
                            (v === 'stockfish' || isLocalEngine(v)) && cfg.limitKind === 'nodes'
                        onChange(needsMovetime ? { engine: v, limitKind: 'movetime' } : { engine: v })
                    }}
                    sx={selectSx}
                >
                    {allowedEngines.map((e) => (
                        <MenuItem key={e} value={e} sx={menuItemSx}>
                            {engineName(e)}
                        </MenuItem>
                    ))}
                </Select>
            </Box>

            {isRatingEngine ? (
                <>
                    <SliderRow
                        label={`${engineName(cfg.engine)} rating`}
                        value={ratingLabel(cfg.rating)}
                        sliderValue={allowUnlosable ? ratingToCoord(cfg.rating) : cfg.rating}
                        min={allowUnlosable ? UNLOSABLE_SLOT : GOMA_RATING_MIN}
                        max={GOMA_RATING_MAX}
                        step={50}
                        disabled={disabled}
                        onChange={(n) => onChange({ rating: allowUnlosable ? coordToRating(n) : n })}
                    />
                    {/* Aggression + opening book are standard-path knobs (standard +
                        chess960); the self-variant engines ignore them. */}
                    {!self && (
                        <>
                            <SliderRow
                                label="Aggression"
                                value={`${cfg.aggr}`}
                                sliderValue={cfg.aggr}
                                min={0}
                                max={100}
                                step={5}
                                disabled={disabled}
                                onChange={(n) => onChange({ aggr: n })}
                            />
                            <Box>
                                <Label>Opening book</Label>
                                <ToggleButtonGroup
                                    exclusive
                                    fullWidth
                                    size="small"
                                    value={cfg.book ? 'on' : 'off'}
                                    onChange={(_, v) => v && onChange({ book: v === 'on' })}
                                    disabled={disabled}
                                    sx={toggleSx}
                                >
                                    <ToggleButton value="on">On</ToggleButton>
                                    <ToggleButton value="off">Off</ToggleButton>
                                </ToggleButtonGroup>
                            </Box>
                        </>
                    )}
                </>
            ) : (
                <SliderRow
                    label="Stockfish strength"
                    value={sfLabel(cfg.sfElo)}
                    sliderValue={cfg.sfElo}
                    min={SF_UCI_MIN}
                    max={SF_UNLEASHED_UCI}
                    step={10}
                    disabled={disabled}
                    onChange={(n) => onChange({ sfElo: n })}
                />
            )}

            {/* Search budget: exactly one of movetime / nodes / depth. */}
            <Box>
                <Label>Search limit</Label>
                <ToggleButtonGroup
                    exclusive
                    fullWidth
                    size="small"
                    value={effKind}
                    onChange={(_, v) => v && onChange({ limitKind: v as LimitKind })}
                    disabled={disabled}
                    sx={toggleSx}
                >
                    <ToggleButton value="movetime">Movetime</ToggleButton>
                    {isRatingEngine && <ToggleButton value="nodes">Nodes</ToggleButton>}
                    <ToggleButton value="depth">Depth</ToggleButton>
                </ToggleButtonGroup>
            </Box>

            {effKind === 'movetime' && (
                <SliderRow
                    label="Movetime"
                    value={`${cfg.movetime} ms`}
                    sliderValue={cfg.movetime}
                    min={MOVETIME_MIN}
                    max={MOVETIME_MAX}
                    step={MOVETIME_STEP}
                    disabled={disabled}
                    onChange={(n) => onChange({ movetime: n })}
                />
            )}
            {effKind === 'depth' && (
                <SliderRow
                    label="Depth"
                    value={`depth ${cfg.depth}`}
                    sliderValue={cfg.depth}
                    min={DEPTH_MIN}
                    max={DEPTH_MAX}
                    step={1}
                    disabled={disabled}
                    onChange={(n) => onChange({ depth: n })}
                />
            )}
            {effKind === 'nodes' && isRatingEngine && (
                <Box>
                    <Label>Nodes</Label>
                    <TextField
                        type="number"
                        size="small"
                        fullWidth
                        value={cfg.nodes}
                        disabled={disabled}
                        onChange={(e) => {
                            const n = Number(e.target.value)
                            if (Number.isFinite(n))
                                onChange({ nodes: clamp(Math.round(n), NODES_MIN, NODES_MAX) })
                        }}
                        inputProps={{ min: NODES_MIN, max: NODES_MAX, step: 1000 }}
                        sx={numberSx}
                    />
                    <Typography sx={{ fontSize: 11, color: 'var(--muted)', mt: 0.25 }}>
                        Hard node cap ({NODES_MIN.toLocaleString()}–{NODES_MAX.toLocaleString()}).
                    </Typography>
                </Box>
            )}
        </Box>
    )
}

// Run control, styled to match the Analysis board's footer action buttons: a gold
// gradient for the primary (Start/Pause) button, a quiet surface for the secondary
// (Reset). `primary` maps to that gold "active" look.
function RunBtn({
    icon,
    label,
    onClick,
    primary,
}: {
    icon: React.ReactNode
    label: string
    onClick: () => void
    primary?: boolean
}) {
    return (
        <Button
            onClick={onClick}
            aria-label={label}
            startIcon={icon}
            disableRipple
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
                color: primary ? '#15171c' : 'var(--text)',
                background: primary
                    ? 'linear-gradient(180deg, #e3b56a, #d8a657)'
                    : 'var(--surface-2)',
                border: primary ? '1px solid var(--accent)' : '1px solid var(--line)',
                boxShadow: primary ? '0 0 16px -4px rgba(216,166,87,0.6)' : 'none',
                transition: 'background-color .15s, color .15s, border-color .15s, box-shadow .2s',
                '& .MuiButton-startIcon': { mr: 0.2 },
                '&:hover': {
                    background: primary
                        ? 'linear-gradient(180deg, #e7bd76, #dcab5d)'
                        : 'var(--line)',
                    color: primary ? '#15171c' : 'var(--accent)',
                    borderColor: primary ? 'var(--accent)' : 'var(--accent-line)',
                },
                '&:active': { transform: 'translateY(1px)' },
            }}
        >
            {label}
        </Button>
    )
}

function SliderRow({
    label,
    value,
    sliderValue,
    min,
    max,
    step,
    disabled,
    onChange,
}: {
    label: string
    value: string
    sliderValue: number
    min: number
    max: number
    step: number
    disabled: boolean
    onChange: (n: number) => void
}) {
    return (
        <Box>
            <Box sx={{ display: 'flex', alignItems: 'baseline', justifyContent: 'space-between' }}>
                <Label>{label}</Label>
                <SettingValue>{value}</SettingValue>
            </Box>
            <Slider
                value={sliderValue}
                onChange={(_, v) => onChange(v as number)}
                min={min}
                max={max}
                step={step}
                disabled={disabled}
                sx={sliderSx}
            />
        </Box>
    )
}

function Centered({ children }: { children: React.ReactNode }) {
    return (
        <Box
            sx={{ flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center', p: 4 }}
        >
            <Typography sx={{ color: 'var(--text-dim)' }}>{children}</Typography>
        </Box>
    )
}

function Label({ children }: { children: React.ReactNode }) {
    return (
        <Typography
            sx={{
                fontFamily: 'var(--font-mono)',
                fontSize: 11,
                letterSpacing: '0.16em',
                textTransform: 'uppercase',
                color: 'var(--muted)',
            }}
        >
            {children}
        </Typography>
    )
}

function SettingValue({ children }: { children: React.ReactNode }) {
    return (
        <Typography
            sx={{
                fontFamily: 'var(--font-mono)',
                fontSize: 13,
                fontWeight: 700,
                color: 'var(--accent)',
            }}
        >
            {children}
        </Typography>
    )
}

const sliderSx = {
    color: 'var(--accent)',
    height: 5,
    mt: 0.25,
    mb: 0,
    '& .MuiSlider-rail': { opacity: 0.4, bgcolor: 'var(--line)' },
    '& .MuiSlider-track': { border: 'none' },
    '& .MuiSlider-thumb': { width: 16, height: 16, bgcolor: '#f3eee2' },
}

// Matches the number field's outlined look so the engine dropdown reads as part of
// the same control set rather than stock MUI.
const selectSx = {
    mt: 0.5,
    color: 'var(--text)',
    fontFamily: 'var(--font-display)',
    fontWeight: 600,
    fontSize: 13.5,
    borderRadius: '10px',
    '& .MuiOutlinedInput-notchedOutline': { borderColor: 'var(--line)' },
    '&:hover .MuiOutlinedInput-notchedOutline': { borderColor: 'var(--accent)' },
    '&.Mui-focused .MuiOutlinedInput-notchedOutline': { borderColor: 'var(--accent)' },
    '& .MuiSelect-icon': { color: 'var(--muted)' },
}

const menuItemSx = {
    fontFamily: 'var(--font-display)',
    fontWeight: 600,
    fontSize: 13.5,
}

const numberSx = {
    mt: 0.75,
    '& .MuiOutlinedInput-root': {
        color: 'var(--text)',
        fontFamily: 'var(--font-mono)',
        fontSize: 14,
        fontWeight: 700,
        '& fieldset': { borderColor: 'var(--line)' },
        '&:hover fieldset': { borderColor: 'var(--accent)' },
        '&.Mui-focused fieldset': { borderColor: 'var(--accent)' },
    },
}

const toggleSx = {
    mt: 0.5,
    gap: 0.75,
    '& .MuiToggleButton-root': {
        color: 'var(--text-dim)',
        border: '1px solid var(--line)',
        borderRadius: '10px !important',
        textTransform: 'none',
        fontFamily: 'var(--font-display)',
        fontWeight: 600,
        fontSize: 13.5,
        py: 0.7,
        '&.Mui-selected': {
            color: '#15171c',
            background: 'linear-gradient(180deg, #e3b56a, #d8a657)',
            borderColor: 'var(--accent)',
        },
    },
}
