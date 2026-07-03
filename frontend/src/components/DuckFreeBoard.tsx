import { useCallback, useEffect, useRef, useState } from 'react'
import { Box, Typography } from '@mui/material'
import {
    ChevronFirst,
    ChevronLast,
    ChevronLeft,
    ChevronRight,
    FlipVertical2,
    LogOut,
    RotateCcw,
} from 'lucide-react'
import Board from './Board'
import BoardPage from './BoardPage'
import EvalBar, { type WhiteEval } from './EvalBar'
import { ActionBtn, ErrorBanner, NavBtn, PANEL_SHADOW } from './PanelUI'
import { duckEval, duckLegalMoves, duckPlay, type Color } from '../api/client'
import { statusLabel } from '../lib/chess'
import { MoveSan } from './MoveSan'
import { useDuckInteraction } from '../lib/useDuckInteraction'
import { START_FEN } from '../lib/variants'

// One position along the free-mode duck analysis line. The duck is stored as a
// bare square string ("" before the first placement), matching the API's shape.
interface DuckPos {
    fen: string
    duck: string
    sideToMove: Color
    legalMoves: string[] // legal PIECE moves in this position (empty until fetched)
    san?: string // SAN of the move that led INTO this position (root has none)
    status?: string // terminal status of this position, if any
}

const INITIAL: DuckPos = { fen: START_FEN, duck: '', sideToMove: 'w', legalMoves: [] }

// A duck position is terminal once the engine reports a status other than "ongoing"
// (king captured / no legal moves / draw). The root has no status → not terminal.
const isTerminal = (status?: string): boolean => !!status && status !== 'ongoing'

// Movetime budget (ms) for the free-mode eval — a quick, responsive read per
// position (the client re-fetches on every navigation, so keep it snappy).
const EVAL_MOVETIME = 900

/**
 * A self-contained interactive Duck Chess board for the FREE-mode analysis page.
 * You play BOTH sides — a piece move then a duck drop (via `useDuckInteraction`) —
 * and the engine evaluates each position (eval bar + gold best-move arrow). The
 * line is a LINEAR history: playing from a past position forks it (the forward
 * moves are discarded, like a real analysis line). `onExit` returns to the
 * standard analysis board.
 */
export default function DuckFreeBoard({ onExit }: { onExit: () => void }) {
    const [history, setHistory] = useState<DuckPos[]>([INITIAL])
    const [idx, setIdx] = useState(0)
    const [orientation, setOrientation] = useState<Color>('w')
    const [ev, setEv] = useState<WhiteEval | null>(null)
    const [bestUci, setBestUci] = useState<string | null>(null)
    const [error, setError] = useState<string | null>(null)
    // Bumped by "New game" to re-seed the start position's legal moves.
    const [resetKey, setResetKey] = useState(0)
    const errTimer = useRef<number | undefined>(undefined)

    const cur = history[idx] ?? INITIAL
    const gameOver = isTerminal(cur.status)

    // Seed the start position's legal PIECE moves once (and after each reset).
    useEffect(() => {
        let cancelled = false
        void (async () => {
            try {
                const r = await duckLegalMoves(START_FEN, '')
                if (cancelled) return
                setHistory((h) =>
                    h.length === 1 && h[0].fen === START_FEN && h[0].legalMoves.length === 0
                        ? [{ ...h[0], legalMoves: r.moves }]
                        : h,
                )
            } catch {
                /* engine unreachable — the board just stays empty of dots */
            }
        })()
        return () => {
            cancelled = true
        }
    }, [resetKey])

    // Live engine eval + best move for the VIEWED position. Aborts on navigation
    // so a trailing search doesn't clobber the new position's read.
    useEffect(() => {
        setEv(null)
        setBestUci(null)
        if (gameOver) return
        let cancelled = false
        const ac = new AbortController()
        void (async () => {
            try {
                const r = await duckEval(cur.fen, cur.duck, {
                    movetime: EVAL_MOVETIME,
                    signal: ac.signal,
                })
                if (cancelled) return
                if (r.eval) {
                    // Convert the side-to-move eval to White-relative for the bar.
                    const white = r.sideToMove === 'w' ? r.eval.value : -r.eval.value
                    setEv({ type: r.eval.type, white })
                } else {
                    setEv(null)
                }
                setBestUci(r.bestmove)
            } catch {
                /* aborted or engine error — keep the last shown eval */
            }
        })()
        return () => {
            cancelled = true
            ac.abort()
        }
    }, [cur.fen, cur.duck, gameOver])

    const flashError = useCallback((msg: string) => {
        setError(msg)
        if (errTimer.current) window.clearTimeout(errTimer.current)
        errTimer.current = window.setTimeout(() => setError(null), 2500)
    }, [])
    useEffect(() => () => window.clearTimeout(errTimer.current), [])

    // Submit a completed duck turn. On a legal move, truncate the history forward of
    // the viewed position (forking) and append the new position, then advance.
    const submit = useCallback(
        async (composite: string) => {
            const from = history[idx] ?? INITIAL
            try {
                const r = await duckPlay(from.fen, from.duck, composite)
                if (!r.legal) {
                    flashError(r.error || 'Illegal move.')
                    return
                }
                setError(null)
                setHistory((h) => [
                    ...h.slice(0, idx + 1),
                    {
                        fen: r.newFen,
                        duck: r.duck,
                        sideToMove: r.sideToMove,
                        legalMoves: r.moves,
                        san: r.san,
                        status: r.status,
                    },
                ])
                setIdx((i) => i + 1)
            } catch (e) {
                flashError(e instanceof Error ? e.message : 'Move failed.')
            }
        },
        [history, idx, flashError],
    )

    const duckI = useDuckInteraction({
        fen: cur.fen,
        duck: cur.duck || null,
        myTurn: !gameOver,
        legalMoves: cur.legalMoves,
        submit,
    })

    // The duck is "in hand" (hidden) while mid-placement — mirror BotGame.
    const shownDuck = duckI.override ? null : cur.duck || null

    // Only the in-flight (optimistic) piece move has a reliable from/to to
    // highlight — the committed SAN isn't a plain UCI, so we don't guess one.
    const lastMove = duckI.override ? duckI.optimisticLast : null

    // The engine's best move is a composite "<pieceUci>:<duckSquare>": the arrow shows
    // the piece move (its from/to are the first four chars) and the ring marks the best
    // DUCK placement — which an arrow can't express, and which the piece move is often
    // "blocked" toward until you see where the duck belongs.
    const arrow =
        bestUci && !gameOver ? { from: bestUci.slice(0, 2), to: bestUci.slice(2, 4) } : null
    const duckSq = bestUci && !gameOver ? bestUci.split(':')[1] : undefined
    const circle = duckSq ? { square: duckSq } : null

    const goFirst = useCallback(() => setIdx(0), [])
    const goPrev = useCallback(() => setIdx((i) => Math.max(0, i - 1)), [])
    const goNext = useCallback(() => setIdx((i) => Math.min(history.length - 1, i + 1)), [history.length])
    const goLast = useCallback(() => setIdx(history.length - 1), [history.length])

    const newGame = useCallback(() => {
        setHistory([INITIAL])
        setIdx(0)
        setEv(null)
        setBestUci(null)
        setError(null)
        setResetKey((k) => k + 1)
    }, [])

    // Keyboard navigation over the line (matches the standard analysis board).
    useEffect(() => {
        const onKey = (e: KeyboardEvent) => {
            if (e.key === 'ArrowLeft') goPrev()
            else if (e.key === 'ArrowRight') goNext()
            else if (e.key === 'ArrowUp') goFirst()
            else if (e.key === 'ArrowDown') goLast()
            else return
            e.preventDefault()
        }
        window.addEventListener('keydown', onKey)
        return () => window.removeEventListener('keydown', onKey)
    }, [goPrev, goNext, goFirst, goLast])

    return (
        <BoardPage
            left={<InfoCard onExit={onExit} />}
            evalBar={<EvalBar ev={gameOver ? null : ev} orientation={orientation} />}
            right={
                <SidePanel
                    history={history}
                    idx={idx}
                    error={error}
                    terminal={gameOver ? statusLabel(cur.status ?? '') : null}
                    onSelect={setIdx}
                    onFirst={goFirst}
                    onPrev={goPrev}
                    onNext={goNext}
                    onLast={goLast}
                    onFlip={() => setOrientation((o) => (o === 'w' ? 'b' : 'w'))}
                    onNewGame={newGame}
                    onExit={onExit}
                />
            }
        >
            <Board
                fen={cur.fen}
                orientation={orientation}
                sideToMove={cur.sideToMove}
                legalMoves={cur.legalMoves}
                lastMove={lastMove}
                inCheck={false}
                interactive={!gameOver}
                onMove={duckI.onMove}
                arrow={arrow}
                circle={circle}
                duck={shownDuck}
                duckTargets={duckI.duckTargets}
                onPlaceDuck={duckI.onPlaceDuck}
                {...(duckI.override ? { overrideBoard: duckI.override } : {})}
            />
        </BoardPage>
    )
}

// Left aside: a compact title card explaining the mode + an exit action (mirrors
// the width/feel of the standard analysis aside).
function InfoCard({ onExit }: { onExit: () => void }) {
    return (
        <Box
            sx={{
                display: { xs: 'none', md: 'flex' },
                flexDirection: 'column',
                gap: 2,
                alignSelf: 'start',
                width: '100%',
            }}
        >
            <Box
                sx={{
                    border: '1px solid var(--line-soft)',
                    borderRadius: '12px',
                    bgcolor: 'var(--surface)',
                    overflow: 'hidden',
                    boxShadow: PANEL_SHADOW,
                }}
            >
                <Typography
                    sx={{
                        fontFamily: 'var(--font-display)',
                        fontSize: 12,
                        fontWeight: 700,
                        letterSpacing: 1.8,
                        textTransform: 'uppercase',
                        color: 'var(--text-dim)',
                        px: 1.75,
                        py: 1.25,
                        borderBottom: '1px solid var(--line-soft)',
                        bgcolor: 'var(--bg-2)',
                    }}
                >
                    Duck Chess
                </Typography>
                <Box sx={{ p: 1.75, display: 'flex', flexDirection: 'column', gap: 1.5 }}>
                    <Typography sx={{ fontSize: 13, color: 'var(--text-dim)', lineHeight: 1.5 }}>
                        Move a piece, then drop the 🦆 on any empty square. Capture the king to
                        win — there's no check. You play both sides; the engine evaluates each
                        position.
                    </Typography>
                    <ActionBtn
                        tone="neutral"
                        icon={<LogOut size={15} />}
                        label="Exit Duck"
                        onClick={onExit}
                    />
                </Box>
            </Box>
        </Box>
    )
}

// Right sidebar: terminal banner, move list, navigation + actions.
function SidePanel({
    history,
    idx,
    error,
    terminal,
    onSelect,
    onFirst,
    onPrev,
    onNext,
    onLast,
    onFlip,
    onNewGame,
    onExit,
}: {
    history: DuckPos[]
    idx: number
    error: string | null
    terminal: string | null
    onSelect: (i: number) => void
    onFirst: () => void
    onPrev: () => void
    onNext: () => void
    onLast: () => void
    onFlip: () => void
    onNewGame: () => void
    onExit: () => void
}) {
    return (
        <Box
            sx={{
                width: '100%',
                display: 'flex',
                flexDirection: 'column',
                minHeight: 0,
                border: '1px solid var(--line-soft)',
                borderRadius: '12px',
                bgcolor: 'var(--surface)',
                overflow: 'hidden',
                boxShadow: PANEL_SHADOW,
                maxHeight: { xs: '72vh', md: 'none' },
            }}
        >
            <Box
                sx={{
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'space-between',
                    gap: 1,
                    px: 1.75,
                    py: 1.25,
                    borderBottom: '1px solid var(--line-soft)',
                    bgcolor: 'var(--bg-2)',
                }}
            >
                <Typography
                    sx={{
                        fontFamily: 'var(--font-display)',
                        fontSize: 12,
                        fontWeight: 700,
                        letterSpacing: 1.8,
                        textTransform: 'uppercase',
                        color: 'var(--text-dim)',
                    }}
                >
                    Line
                </Typography>
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
                    }}
                >
                    Duck 🦆
                </Box>
            </Box>

            {terminal && (
                <Box
                    sx={{
                        px: 1.5,
                        py: 1.1,
                        borderBottom: '1px solid var(--line-soft)',
                        bgcolor: 'var(--accent-soft)',
                        color: 'var(--accent)',
                        fontWeight: 600,
                        fontSize: 13.5,
                        textAlign: 'center',
                    }}
                >
                    {terminal}
                </Box>
            )}

            {error && <ErrorBanner>{error}</ErrorBanner>}

            {/* Move list — the SANs (with the duck glyph) along the line. */}
            <Box sx={{ flex: 1, minHeight: 120, overflowY: 'auto', p: 1.25 }}>
                {history.length <= 1 ? (
                    <Typography
                        sx={{ fontSize: 13, color: 'var(--muted)', fontStyle: 'italic', p: 0.5 }}
                    >
                        Make a move to start the line.
                    </Typography>
                ) : (
                    <Box sx={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: 0.4 }}>
                        {history.slice(1).map((p, k) => {
                            const i = k + 1 // this move's history index
                            const mover = history[i - 1].sideToMove // side that moved
                            const moveNo = Math.ceil(i / 2)
                            const active = i === idx
                            return (
                                <Box
                                    key={i}
                                    sx={{ display: 'flex', alignItems: 'center', gap: 0.4 }}
                                >
                                    {mover === 'w' && (
                                        <Box
                                            component="span"
                                            sx={{
                                                fontFamily: 'var(--font-mono)',
                                                fontSize: 12.5,
                                                color: 'var(--muted)',
                                            }}
                                        >
                                            {moveNo}.
                                        </Box>
                                    )}
                                    <Box
                                        component="button"
                                        onClick={() => onSelect(i)}
                                        sx={{
                                            cursor: 'pointer',
                                            fontFamily: 'var(--font-mono)',
                                            fontSize: 13.5,
                                            fontWeight: 600,
                                            color: active ? '#15171c' : 'var(--text)',
                                            bgcolor: active ? 'var(--accent)' : 'transparent',
                                            border: '1px solid transparent',
                                            borderRadius: '6px',
                                            px: 0.6,
                                            py: '2px',
                                            transition: 'background .12s, color .12s',
                                            '&:hover': {
                                                bgcolor: active ? 'var(--accent)' : 'var(--line)',
                                            },
                                        }}
                                    >
                                        {p.san ? <MoveSan san={p.san} /> : '—'}
                                    </Box>
                                </Box>
                            )
                        })}
                    </Box>
                )}
            </Box>

            {/* Footer: navigation + actions */}
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
                <Box sx={{ display: 'flex', alignItems: 'center', gap: 0.5 }}>
                    <NavBtn label="Start" onClick={onFirst} grow>
                        <ChevronFirst size={21} />
                    </NavBtn>
                    <NavBtn label="Previous" onClick={onPrev} grow>
                        <ChevronLeft size={21} />
                    </NavBtn>
                    <NavBtn label="Next" onClick={onNext} grow>
                        <ChevronRight size={21} />
                    </NavBtn>
                    <NavBtn label="End" onClick={onLast} grow>
                        <ChevronLast size={21} />
                    </NavBtn>
                    <Box sx={{ width: '1px', height: 26, bgcolor: 'var(--line)', mx: 0.5 }} />
                    <NavBtn label="Flip board" onClick={onFlip}>
                        <FlipVertical2 size={19} />
                    </NavBtn>
                </Box>

                <Box sx={{ display: 'flex', gap: 1 }}>
                    <ActionBtn
                        tone="neutral"
                        icon={<LogOut size={15} />}
                        label="Exit Duck"
                        onClick={onExit}
                    />
                    <ActionBtn
                        tone="primary"
                        icon={<RotateCcw size={15} />}
                        label="New game"
                        onClick={onNewGame}
                    />
                </Box>
            </Box>
        </Box>
    )
}
