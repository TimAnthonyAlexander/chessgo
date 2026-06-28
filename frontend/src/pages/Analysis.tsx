import { Fragment, useCallback, useEffect, useMemo, useState } from 'react'
import { Box, Button, Tooltip, Typography } from '@mui/material'
import {
    ChevronFirst,
    ChevronLast,
    ChevronLeft,
    ChevronRight,
    FlipVertical2,
    Play,
    Square,
    Target,
    Zap,
} from 'lucide-react'
import { useLocation, useNavigate, useParams } from 'react-router-dom'
import AnalysisAside from '../components/AnalysisAside'
import Board from '../components/Board'
import EvalBar, { type WhiteEval } from '../components/EvalBar'
import MoveTree from '../components/MoveTree'
import OpeningPanel from '../components/OpeningPanel'
import { analyze, getGameAnalysis, type GameAnalysis } from '../api/client'
import type { Color } from '../api/client'
import {
    type Tree,
    type TreeNode,
    annotateEval,
    buildFromAnalysis,
    buildFromMoves,
    createTree,
    gameOverAt,
    legalUci,
    playMove,
    pvToSan,
    START_FEN,
    turnAt,
} from '../lib/analysisTree'
import { playForSan } from '../lib/sounds'
import { useAuth } from '../lib/auth'

// How long (ms) each auto-played move lingers before the next one.
const AUTO_DELAY = 700

// Color of the board arrow drawn when hovering a candidate (book) move — a clear
// blue, distinct from the gold engine best-move arrow.
const BOOK_ARROW_COLOR = '#4c8bf5'

// Depth schedule for the analysis board's progressive ("streaming") eval. Each
// entry is a separate /analyze call at that ply depth; we render the result as it
// lands, so the panel shows an instant shallow guess that refines as it deepens.
// Coarsening the steps as they get expensive keeps the round-trip count low (the
// deepest search dominates the cost anyway) while still feeling like it "ticks up".
const ANALYSIS_DEPTHS = [6, 9, 12, 14, 16, 18, 20, 22]

type AutoMode = 'off' | 'play' | 'best'

// Play the appropriate sound for the move that leads INTO a node.
function playMoveSound(node?: TreeNode) {
    if (!node?.move) return
    playForSan(node.move.san, false)
}

export default function Analysis() {
    const { id } = useParams<{ id?: string }>()
    const navigate = useNavigate()
    // Free mode can be seeded with an in-memory game (moves replayed from a start
    // position) passed via navigation state — e.g. from Engine vs Engine, which is
    // never persisted so it can't be loaded by id.
    const navState = useLocation().state as { moves?: string[]; startFen?: string } | null
    const importMoves = navState?.moves ?? null
    const importStartFen = navState?.startFen ?? START_FEN

    const [tree, setTree] = useState<Tree>(() => createTree(START_FEN))
    const [currentId, setCurrentId] = useState(0)
    const [orientation, setOrientation] = useState<Color>('w')
    const [showArrow, setShowArrow] = useState(true)
    const [engineOn, setEngineOn] = useState(true) // master: eval bar + arrow + engine line
    const [game, setGame] = useState<GameAnalysis | null>(null)
    const [loadError, setLoadError] = useState<string | null>(null)
    const [loading, setLoading] = useState<boolean>(!!id)
    const [autoMode, setAutoMode] = useState<AutoMode>('off')
    // UCI of the candidate (book) move currently hovered in the OpeningPanel, drawn
    // as a blue arrow on the board. Cleared whenever the viewed node changes.
    const [hoverUci, setHoverUci] = useState<string | null>(null)

    // --- Load a finished game's analysis (review mode) ---
    useEffect(() => {
        setAutoMode('off')
        if (!id) {
            if (importMoves && importMoves.length > 0) {
                // Seeded free mode: replay an imported game onto a fresh tree.
                const built = buildFromMoves(importStartFen, importMoves)
                setTree(built.tree)
                setCurrentId(built.lastId) // land on the final position
                setGame(null)
                setLoading(false)
                return
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
    }, [id, importMoves, importStartFen])

    // A hovered candidate move only makes sense for the position it was listed for;
    // drop it when the viewed node changes (the row also unmounts on navigation).
    useEffect(() => setHoverUci(null), [currentId])

    const current = tree.nodes[currentId] ?? tree.nodes[tree.rootId]
    const sideToMove = turnAt(current)
    const over = useMemo(() => gameOverAt(current), [current.fen])
    const legalMoves = useMemo(() => (over.over ? [] : legalUci(current)), [current.fen, over.over])

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
        if (!engineOn) return // engine analysis disabled — no fetching
        // While a game is loading, the tree is still the transient empty root; don't
        // fire /analyze against it — that races buildFromAnalysis (whichever lands
        // last wins) and would overwrite the persisted, book-backed game analysis.
        if (loading) return

        // Terminal positions: derive the eval locally, no engine call (no line to show).
        if (over.over) {
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

        let cancelled = false
        // Abort the in-flight request when we leave this position, so the previous
        // position's trailing deep call (up to the server's time ceiling) doesn't hog
        // a browser connection / engine worker and delay the new position's first guess.
        const ac = new AbortController()
        const run = async () => {
            for (const target of ANALYSIS_DEPTHS) {
                if (cancelled) return
                if (target <= achieved) continue

                let r: Awaited<ReturnType<typeof analyze>>
                try {
                    r = await analyze(fen, { depth: target, signal: ac.signal })
                } catch {
                    return // engine error or aborted — keep whatever we already have
                }
                if (cancelled) return

                const got = r.depth ?? target
                if (got <= achieved) continue // don't apply a result that wouldn't deepen

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
                if (got < target) return // engine hit its time ceiling — the opinion has settled
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
    }, [engineOn, loading, current.id, current.fen, over.over, over.checkmate, sideToMove])

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

    useEffect(() => {
        const onKey = (e: KeyboardEvent) => {
            if (e.key === 'ArrowLeft') goPrev()
            else if (e.key === 'ArrowRight') goNext()
            else if (e.key === 'ArrowUp') goStart()
            else if (e.key === 'ArrowDown') goEnd()
            else return
            e.preventDefault()
        }
        window.addEventListener('keydown', onKey)
        return () => window.removeEventListener('keydown', onKey)
    }, [goPrev, goNext, goStart, goEnd])

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
        if (autoMode !== 'best') return
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
    }, [autoMode, currentId, current.bestUci, over.over, tree])

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

    // The board arrow needs the engine on and the arrow toggle enabled — even while
    // Auto Best Move is driving, we honor the user's arrow preference.
    // A hovered candidate (book) move wins over the gold engine arrow, drawn in
    // blue. It shows on hover regardless of the best-move arrow toggle.
    const arrow = hoverUci
        ? {
              from: hoverUci.slice(0, 2),
              to: hoverUci.slice(2, 4),
              color: BOOK_ARROW_COLOR,
          }
        : engineOn && showArrow && current.bestUci
            ? { from: current.bestUci.slice(0, 2), to: current.bestUci.slice(2, 4) }
            : null

    const lastMove = current.move ? { from: current.move.from, to: current.move.to } : null

    return (
        <Box
            sx={{
                flex: 1,
                display: 'flex',
                justifyContent: 'center',
                alignItems: { xs: 'flex-start', md: 'center' },
                px: { xs: 1.5, md: 3 },
                py: { xs: 2, md: 2 },
            }}
        >
            <Box
                sx={{
                    display: 'grid',
                    // A left spacer column mirrors the 360px sidebar so the BOARD (not the
                    // board+sidebar block) is centered in the viewport — same trick as LiveGame.
                    gridTemplateColumns: {
                        xs: '1fr',
                        md: '320px min(calc(100vh - 120px), calc(100vw - 752px), 880px) 320px',
                    },
                    columnGap: { md: 4 },
                    rowGap: 2,
                    alignItems: { xs: 'start', md: 'stretch' },
                    justifyContent: 'center',
                    width: { xs: '100%', md: 'fit-content' },
                    maxWidth: '100%',
                    mx: 'auto',
                }}
            >
                {/* Left column: material + position cards (mirrors the sidebar width, so
            the board stays centered). Setup tools only in free mode — reviewing a
            loaded game shows material alone. */}
                <AnalysisAside
                    fen={current.fen}
                    onLoadFen={loadPosition}
                    onPlayBot={() => navigate('/bot', { state: { fen: current.fen } })}
                    onEditBoard={() => navigate('/editor', { state: { fen: current.fen } })}
                    playBotDisabled={over.over}
                    showSetup={!id}
                />

                {/* Eval bar + board */}
                <Box sx={{ minWidth: 0, display: 'flex', gap: 1, alignItems: 'stretch' }}>
                    <EvalBar ev={engineOn ? current.evalWhite : null} orientation={orientation} />
                    <Box sx={{ flex: 1, minWidth: 0 }}>
                        <Board
                            fen={current.fen}
                            orientation={orientation}
                            sideToMove={sideToMove}
                            legalMoves={legalMoves}
                            lastMove={lastMove}
                            inCheck={over.check}
                            interactive
                            onMove={onMove}
                            arrow={arrow}
                        />
                    </Box>
                </Box>

                {/* Sidebar */}
                <Box
                    sx={{
                        width: { xs: '100%', md: '100%' },
                        justifySelf: { md: 'start' },
                        display: 'flex',
                        flexDirection: 'column',
                        minHeight: 0,
                        border: '1px solid var(--line-soft)',
                        borderRadius: '12px',
                        bgcolor: 'var(--surface)',
                        overflow: 'hidden',
                        boxShadow: '0 18px 50px -28px rgba(0,0,0,0.8)',
                        maxHeight: { xs: '72vh', md: 'none' },
                    }}
                >
                    <EngineLine
                        engineOn={engineOn}
                        onToggleEngine={toggleEngine}
                        evalWhite={current.evalWhite}
                        depth={current.bestDepth}
                        fen={current.fen}
                        pvUci={current.bestPv}
                    />

                    <MoveTree tree={tree} currentId={currentId} onSelect={selectNode} />

                    {id && <Header game={game} loading={loading} loadError={loadError} />}

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
                            <AutoBtn
                                active={autoMode === 'best'}
                                onClick={() => toggleAuto('best')}
                                icon={
                                    autoMode === 'best' ? <Square size={15} /> : <Zap size={15} />
                                }
                                label={autoMode === 'best' ? 'Stop' : 'Auto Best'}
                            />
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
                            >
                                <Target size={19} />
                            </NavBtn>
                            <NavBtn
                                onClick={() => setOrientation((o) => (o === 'w' ? 'b' : 'w'))}
                                label="Flip board"
                            >
                                <FlipVertical2 size={19} />
                            </NavBtn>
                        </Box>
                    </Box>

                    <OpeningPanel
                        tree={tree}
                        currentId={currentId}
                        engineOn={engineOn}
                        onMove={onMove}
                        onHoverMove={setHoverUci}
                    />
                </Box>
            </Box>
        </Box>
    )
}

function NavBtn({
    onClick,
    label,
    active,
    grow,
    children,
}: {
    onClick: () => void
    label: string
    active?: boolean
    grow?: boolean
    children: React.ReactNode
}) {
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
                    color: active ? 'var(--accent)' : 'var(--text-dim)',
                    bgcolor: active ? 'var(--accent-soft)' : 'transparent',
                    border: active ? '1px solid var(--accent-line)' : '1px solid transparent',
                    transition: 'background-color .15s, color .15s, border-color .15s',
                    '&:hover': {
                        color: 'var(--accent)',
                        bgcolor: active ? 'var(--accent-soft)' : 'var(--line)',
                    },
                    '&:active': { transform: 'translateY(1px)' },
                }}
            >
                {children}
            </Button>
        </Tooltip>
    )
}

// Short eval for the colored pill: "+0.34", "-1.2", or "#3" / "-#2" for mate.
function pillEval(ev: WhiteEval | null): string {
    if (!ev) return '–'
    if (ev.type === 'mate') return `${ev.white < 0 ? '-' : ''}#${Math.abs(ev.white)}`
    const v = ev.white / 100
    return (v > 0 ? '+' : '') + v.toFixed(2)
}

// Hand-built on/off switch — a gold track with a sliding knob and a soft glow when
// live. Keyboard + ARIA accessible. Replaces the stock MUI Switch.
function Toggle({ on, onChange }: { on: boolean; onChange: () => void }) {
    return (
        <Box
            role="switch"
            aria-checked={on}
            aria-label="Toggle engine"
            tabIndex={0}
            onClick={onChange}
            onKeyDown={(e) => {
                if (e.key === 'Enter' || e.key === ' ') {
                    e.preventDefault()
                    onChange()
                }
            }}
            sx={{
                position: 'relative',
                flexShrink: 0,
                width: 48,
                height: 28,
                borderRadius: 999,
                cursor: 'pointer',
                bgcolor: on ? 'var(--accent)' : 'var(--surface-2)',
                boxShadow: on
                    ? '0 0 0 1px var(--accent-line), 0 0 14px -3px rgba(216, 166, 87, 0.7)'
                    : 'inset 0 0 0 1px var(--line)',
                transition: 'background-color .22s ease, box-shadow .22s ease',
                outline: 'none',
                '&:hover': { bgcolor: on ? 'var(--accent)' : 'var(--line)' },
                '&:focus-visible': { boxShadow: '0 0 0 2px var(--accent-line)' },
            }}
        >
            <Box
                sx={{
                    position: 'absolute',
                    top: 3,
                    left: 3,
                    width: 22,
                    height: 22,
                    borderRadius: '50%',
                    bgcolor: on ? '#15171c' : 'var(--text-dim)',
                    transform: on ? 'translateX(20px)' : 'translateX(0)',
                    transition:
                        'transform .24s cubic-bezier(.34, 1.4, .5, 1), background-color .22s ease',
                    boxShadow: '0 1px 3px rgba(0, 0, 0, 0.45)',
                }}
            />
        </Box>
    )
}

// The engine panel: the custom toggle is the MASTER engine on/off (off suppresses
// the eval bar, board arrow, and this panel), beside a wordmark + depth readout,
// with a colored eval pill and the predicted best line (PV) in SAN. Display-only.
function EngineLine({
    engineOn,
    onToggleEngine,
    evalWhite,
    depth,
    fen,
    pvUci,
}: {
    engineOn: boolean
    onToggleEngine: () => void
    evalWhite: WhiteEval | null
    depth: number | null
    fen: string
    pvUci: string[] | null
}) {
    // Render the PV as numbered SAN tokens ("12. Nf3 Nc6 13. Bb5 …") relative to
    // the current position's move number and side to move.
    const tokens = useMemo<{ text: string; num: boolean }[]>(() => {
        if (!pvUci || pvUci.length === 0) return []
        const fields = fen.split(' ')
        let full = parseInt(fields[5] || '1', 10) || 1
        let white = fields[1] !== 'b'
        const out: { text: string; num: boolean }[] = []
        pvToSan(fen, pvUci).forEach((m: { san: string }, i) => {
            if (white) out.push({ text: `${full}.`, num: true })
            else if (i === 0) out.push({ text: `${full}…`, num: true })
            out.push({ text: m.san, num: false })
            if (!white) full += 1
            white = !white
        })
        return out
    }, [fen, pvUci])

    // Eval pill follows the eval bar's palette: cream when White's better, dark when
    // Black's. Drawn/zero sits neutral.
    const whiteAdv = !!evalWhite && evalWhite.white > 0
    const blackAdv = !!evalWhite && evalWhite.white < 0
    const pillBg = whiteAdv
        ? 'linear-gradient(180deg, #f3eee2, #e4dccb)'
        : blackAdv
            ? '#15171c'
            : 'var(--surface-2)'
    const pillFg = whiteAdv ? '#15171c' : blackAdv ? '#ece9e1' : 'var(--text-dim)'

    return (
        <Box
            sx={{
                borderBottom: '1px solid var(--line-soft)',
                bgcolor: 'var(--bg-2)',
                background: engineOn
                    ? 'linear-gradient(180deg, rgba(216,166,87,0.06), rgba(216,166,87,0) 60%), var(--bg-2)'
                    : 'var(--bg-2)',
            }}
        >
            {/* Header: toggle + wordmark + depth */}
            <Box sx={{ display: 'flex', alignItems: 'center', gap: 1.25, px: 1.5, py: 1.25 }}>
                <Tooltip
                    title={engineOn ? 'Turn engine off' : 'Turn engine on'}
                    arrow
                    placement="top"
                >
                    <Toggle on={engineOn} onChange={onToggleEngine} />
                </Tooltip>
                <Box sx={{ display: 'flex', flexDirection: 'column', lineHeight: 1 }}>
                    <Typography
                        sx={{
                            fontFamily: 'var(--font-display)',
                            fontSize: 13,
                            fontWeight: 700,
                            letterSpacing: 1.8,
                            textTransform: 'uppercase',
                            color: engineOn ? 'var(--text)' : 'var(--muted)',
                            transition: 'color .2s',
                        }}
                    >
                        Engine
                    </Typography>
                </Box>
                <Box sx={{ flex: 1 }} />
                {engineOn ? (
                    depth != null && (
                        <Box sx={{ display: 'flex', alignItems: 'baseline', gap: 0.6 }}>
                            <Typography
                                sx={{
                                    fontSize: 10,
                                    letterSpacing: 1.2,
                                    textTransform: 'uppercase',
                                    color: 'var(--muted)',
                                }}
                            >
                                depth
                            </Typography>
                            <Typography
                                sx={{
                                    fontFamily: 'var(--font-mono)',
                                    fontSize: 13.5,
                                    fontWeight: 700,
                                    color: 'var(--text-dim)',
                                }}
                            >
                                {depth}
                            </Typography>
                        </Box>
                    )
                ) : (
                    <Typography
                        sx={{
                            fontSize: 10.5,
                            letterSpacing: 1.5,
                            textTransform: 'uppercase',
                            color: 'var(--muted)',
                        }}
                    >
                        off
                    </Typography>
                )}
            </Box>

            {/* Eval pill + best line — only while the engine is on */}
            {engineOn && (
                <Box
                    sx={{ display: 'flex', alignItems: 'flex-start', gap: 1.25, px: 1.5, pb: 1.5 }}
                >
                    <Box
                        sx={{
                            fontFamily: 'var(--font-mono)',
                            fontSize: 14.5,
                            fontWeight: 700,
                            minWidth: 64,
                            height: 32,
                            display: 'flex',
                            alignItems: 'center',
                            justifyContent: 'center',
                            borderRadius: '6px',
                            flexShrink: 0,
                            color: evalWhite ? pillFg : 'var(--muted)',
                            background: evalWhite ? pillBg : 'var(--surface-2)',
                            boxShadow: '0 1px 2px rgba(0,0,0,0.25)',
                        }}
                    >
                        {evalWhite ? pillEval(evalWhite) : '…'}
                    </Box>
                    <Box
                        sx={{
                            flex: 1,
                            minWidth: 0,
                            fontSize: 13.5,
                            lineHeight: '32px',
                            whiteSpace: 'nowrap',
                            overflow: 'hidden',
                            textOverflow: 'ellipsis',
                        }}
                    >
                        {tokens.length === 0 ? (
                            <Box
                                component="span"
                                sx={{ color: 'var(--muted)', fontStyle: 'italic' }}
                            >
                                analysing…
                            </Box>
                        ) : (
                            tokens.map((t, i) => (
                                <Box
                                    key={i}
                                    component="span"
                                    sx={{
                                        color: t.num ? 'var(--muted)' : 'var(--text)',
                                        fontFamily: t.num ? 'var(--font-mono)' : 'var(--font-mono)',
                                        fontWeight: t.num ? 400 : 600,
                                        mr: t.num ? 0.4 : 0.8,
                                    }}
                                >
                                    {t.text}
                                </Box>
                            ))
                        )}
                    </Box>
                </Box>
            )}
        </Box>
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

// The game header (players / result / accuracy). Only rendered in review mode
// (a loaded game); free mode has no header — the engine line sits at the top.
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
                <Typography sx={{ fontWeight: 600, fontSize: 13.5, letterSpacing: 0.2 }}>
                    Game review
                </Typography>
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
