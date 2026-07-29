import { useCallback, useEffect, useMemo, useState } from 'react'
import { Box, Typography } from '@mui/material'
import {
    Check,
    ChevronLeft,
    ChevronRight,
    FlipVertical2,
    LogOut,
    RotateCcw,
    SkipForward,
    Target,
    Trophy,
    X,
    Zap,
} from 'lucide-react'
import Board from './Board'
import BoardPage from './BoardPage'
import EvalBar, { type WhiteEval } from './EvalBar'
import AnalysisAside from './AnalysisAside'
import { ActionBtn, ErrorBanner, NavBtn, PANEL_SHADOW } from './PanelUI'
import { MoveSan } from './MoveSan'
import { useBoardInteraction, type BoardControl } from '../lib/useBoardInteraction'
import { pvToSan } from '../lib/analysisTree'
import { Chess } from 'chess.js'
import type { Color, GameAnalysis } from '../api/client'
import {
    type Attempt,
    type BlunderPuzzle,
    type Grade,
    bestPlayerCp,
    buildBlunderPuzzles,
    formatPlayerCp,
    gradeAttempt,
    isRecovered,
    legalUciForFen,
    playerCpToWhiteEval,
} from '../lib/blunderRewind'

// Per-grade display: the retry outcome's label, accent color, and icon.
const GRADE_META: Record<Grade, { label: string; color: string; Icon: typeof Check }> = {
    best: { label: 'Perfect — the engine move', color: '#5b9e5b', Icon: Trophy },
    good: { label: 'Recovered', color: '#5b9e5b', Icon: Check },
    inaccuracy: { label: 'Close, but not best', color: '#e0a33e', Icon: Target },
    miss: { label: 'Still losing', color: '#ca4a4a', Icon: X },
}

/**
 * Blunder Rewind — a "redemption run" over a reviewed game's blunders. Each
 * blunder drops the board into its pre-blunder position; the player retries the
 * move and is graded live against the engine's best line (via /analyze). A
 * self-contained board page (like DuckFreeBoard) that `Analysis` swaps in.
 */
export default function BlunderRewind({
    game,
    onlyColor,
    onExit,
}: {
    game: GameAnalysis
    /** Restrict the rewind to one side's blunders (the viewer's own). */
    onlyColor?: Color
    onExit: () => void
}) {
    const puzzles = useMemo(() => buildBlunderPuzzles(game, onlyColor), [game, onlyColor])

    const [index, setIndex] = useState(0)
    const [results, setResults] = useState<Record<number, Attempt>>({})
    const [grading, setGrading] = useState(false)
    const [error, setError] = useState<string | null>(null)
    const [orientation, setOrientation] = useState<Color>(puzzles[0]?.playerColor ?? 'w')

    const puzzle = puzzles[index]
    const attempt = results[index] ?? null
    const phase: 'awaiting' | 'grading' | 'revealed' = grading
        ? 'grading'
        : attempt
            ? 'revealed'
            : 'awaiting'

    // Orient the board to the blundering player's POV when the puzzle changes.
    useEffect(() => {
        if (puzzle) setOrientation(puzzle.playerColor)
    }, [puzzle])

    // Check state for the pre-blunder position (king-in-check highlight).
    const inCheck = useMemo(() => {
        if (!puzzle) return false
        try {
            return new Chess(puzzle.fen).isCheck()
        } catch {
            return false
        }
    }, [puzzle])

    const legalMoves = useMemo(
        () => (puzzle && phase === 'awaiting' ? legalUciForFen(puzzle.fen) : []),
        [puzzle, phase],
    )

    // Grade a retry: /analyze the resulting position and compare to best play. The
    // returned promise lets useBoardInteraction clear its optimistic overlay once
    // grading settles (the board FEN itself never advances).
    const submit = useCallback(
        async (uci: string) => {
            if (!puzzle) return
            setGrading(true)
            setError(null)
            try {
                const att = await gradeAttempt(puzzle, uci)
                setResults((r) => ({ ...r, [index]: att }))
            } catch {
                setError('Could not reach the engine to grade that move. Try again.')
            } finally {
                setGrading(false)
            }
        },
        [puzzle, index],
    )

    const control: BoardControl = {
        fen: puzzle?.fen ?? '',
        myTurn: phase === 'awaiting',
        legalMoves,
        submit,
        canPremove: false,
    }
    const bi = useBoardInteraction(control)

    const goTo = useCallback((i: number, total: number) => {
        setIndex(Math.max(0, Math.min(total - 1, i)))
        setError(null)
    }, [])

    const retry = useCallback(() => {
        setResults((r) => {
            const next = { ...r }
            delete next[index]
            return next
        })
        setError(null)
    }, [index])

    const restart = useCallback(() => {
        setResults({})
        setIndex(0)
        setError(null)
    }, [])

    if (!puzzle) {
        // Shouldn't happen (Analysis only enters with puzzles) — degrade gracefully.
        return null
    }

    const answeredCount = Object.keys(results).length
    const recoveredCount = Object.values(results).filter((a) => isRecovered(a.grade)).length
    const total = puzzles.length
    const allDone = answeredCount === total

    // Best-move arrow (revealed only), plus the last move played (their retry).
    const arrow =
        phase === 'revealed'
            ? { from: puzzle.bestUci.slice(0, 2), to: puzzle.bestUci.slice(2, 4) }
            : null
    const lastMove =
        bi.optimisticLast ??
        (attempt ? { from: attempt.uci.slice(0, 2), to: attempt.uci.slice(2, 4) } : null)

    // Eval bar: hidden until answered (no spoilers). Revealed shows the retry's eval
    // (fill) against best play (the second-opinion tick), both White POV.
    const evForBar: WhiteEval | null =
        phase === 'revealed' && attempt
            ? playerCpToWhiteEval(attempt.playerCp, puzzle.playerColor)
            : null
    const bestEvForBar: WhiteEval | null =
        phase === 'revealed' ? playerCpToWhiteEval(bestPlayerCp(puzzle), puzzle.playerColor) : null

    return (
        <BoardPage
            left={
                <AnalysisAside
                    fen={puzzle.fen}
                    onLoadFen={() => {}}
                    showSetup={false}
                    hideActions
                />
            }
            evalBar={
                <EvalBar
                    ev={evForBar}
                    orientation={orientation}
                    sfEv={bestEvForBar}
                    sfColor="#5b9e5b"
                />
            }
            right={
                <Box
                    sx={{
                        width: '100%',
                        flex: { md: 1 },
                        display: 'flex',
                        flexDirection: 'column',
                        minHeight: 0,
                        border: '1px solid var(--line-soft)',
                        borderRadius: 'var(--panel-radius)',
                        bgcolor: 'var(--surface)',
                        overflow: 'hidden',
                        boxShadow: PANEL_SHADOW,
                        maxHeight: { xs: '72vh', md: 'none' },
                    }}
                >
                    <RewindHeader
                        recovered={recoveredCount}
                        answered={answeredCount}
                        total={total}
                    />

                    <ProgressDots
                        puzzles={puzzles}
                        results={results}
                        index={index}
                        onSelect={(i) => goTo(i, total)}
                    />

                    {/* Scrollable body: the prompt + graded feedback. */}
                    <Box sx={{ flex: 1, minHeight: 0, overflowY: 'auto', p: 1.5 }}>
                        {allDone && (
                            <SummaryCard
                                recovered={recoveredCount}
                                total={total}
                                onRestart={restart}
                            />
                        )}

                        <PromptCard puzzle={puzzle} index={index} total={total} phase={phase} />

                        {phase === 'revealed' && attempt && (
                            <FeedbackCard puzzle={puzzle} attempt={attempt} />
                        )}
                    </Box>

                    {error && <ErrorBanner>{error}</ErrorBanner>}

                    {/* Controls */}
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
                        <Box sx={{ display: 'flex', gap: 1 }}>
                            {phase === 'awaiting' && (
                                <ActionBtn
                                    tone="neutral"
                                    icon={<SkipForward size={16} />}
                                    label="Skip"
                                    onClick={() => goTo(index + 1, total)}
                                    disabled={index + 1 >= total}
                                />
                            )}
                            {phase === 'revealed' && attempt && attempt.grade !== 'best' && (
                                <ActionBtn
                                    tone="neutral"
                                    icon={<RotateCcw size={16} />}
                                    label="Try again"
                                    onClick={retry}
                                />
                            )}
                            {phase === 'revealed' && (
                                <ActionBtn
                                    tone="primary"
                                    icon={<ChevronRight size={16} />}
                                    label={index + 1 < total ? 'Next blunder' : 'Finish'}
                                    onClick={() => (index + 1 < total ? goTo(index + 1, total) : onExit())}
                                />
                            )}
                        </Box>

                        <Box sx={{ display: 'flex', alignItems: 'center', gap: 0.5 }}>
                            <NavBtn label="Previous blunder" onClick={() => goTo(index - 1, total)} grow>
                                <ChevronLeft size={20} />
                            </NavBtn>
                            <NavBtn label="Next blunder" onClick={() => goTo(index + 1, total)} grow>
                                <ChevronRight size={20} />
                            </NavBtn>
                            <Box sx={{ width: '1px', height: 26, bgcolor: 'var(--line)', mx: 0.5 }} />
                            <NavBtn
                                label="Flip board"
                                onClick={() => setOrientation((o) => (o === 'w' ? 'b' : 'w'))}
                            >
                                <FlipVertical2 size={18} />
                            </NavBtn>
                            <NavBtn label="Exit Blunder Rewind" onClick={onExit}>
                                <LogOut size={18} />
                            </NavBtn>
                        </Box>
                    </Box>
                </Box>
            }
        >
            <Board
                fen={puzzle.fen}
                orientation={orientation}
                sideToMove={puzzle.playerColor}
                legalMoves={legalMoves}
                lastMove={lastMove}
                inCheck={inCheck}
                interactive={phase === 'awaiting'}
                onMove={bi.onMove}
                overrideBoard={bi.override ?? undefined}
                arrow={arrow}
            />
        </BoardPage>
    )
}

// Title + live redemption-run tally.
function RewindHeader({
    recovered,
    answered,
    total,
}: {
    recovered: number
    answered: number
    total: number
}) {
    return (
        <Box
            sx={{
                px: 1.5,
                py: 1.25,
                borderBottom: '1px solid var(--line-soft)',
                bgcolor: 'var(--bg-2)',
                background:
                    'linear-gradient(180deg, rgba(216,166,87,0.08), rgba(216,166,87,0) 70%), var(--bg-2)',
                display: 'flex',
                alignItems: 'center',
                gap: 1,
            }}
        >
            <Zap size={17} color="var(--accent)" />
            <Box sx={{ minWidth: 0 }}>
                <Typography
                    sx={{
                        fontFamily: 'var(--font-display)',
                        fontSize: 13,
                        fontWeight: 700,
                        letterSpacing: 1.4,
                        textTransform: 'uppercase',
                        color: 'var(--text)',
                        lineHeight: 1.1,
                    }}
                >
                    Blunder Rewind
                </Typography>
                <Typography sx={{ fontSize: 11.5, color: 'var(--text-dim)', mt: 0.25 }}>
                    Redemption run
                </Typography>
            </Box>
            <Box sx={{ flex: 1 }} />
            <Box sx={{ textAlign: 'right' }}>
                <Typography
                    sx={{
                        fontFamily: 'var(--font-mono)',
                        fontSize: 15,
                        fontWeight: 700,
                        color: 'var(--accent)',
                        lineHeight: 1,
                    }}
                >
                    {recovered} of {total}
                </Typography>
                <Typography sx={{ fontSize: 10, color: 'var(--muted)', letterSpacing: 0.4 }}>
                    recovered{answered < total ? ` · ${answered} tried` : ''}
                </Typography>
            </Box>
        </Box>
    )
}

// One dot per blunder, colored by outcome; the current one is ringed.
function ProgressDots({
    puzzles,
    results,
    index,
    onSelect,
}: {
    puzzles: BlunderPuzzle[]
    results: Record<number, Attempt>
    index: number
    onSelect: (i: number) => void
}) {
    return (
        <Box
            sx={{
                display: 'flex',
                flexWrap: 'wrap',
                gap: 0.75,
                px: 1.5,
                py: 1.25,
                borderBottom: '1px solid var(--line-soft)',
            }}
        >
            {puzzles.map((p, i) => {
                const att = results[i]
                const color = att
                    ? isRecovered(att.grade)
                        ? '#5b9e5b'
                        : '#ca4a4a'
                    : 'var(--surface-2)'
                const current = i === index
                return (
                    <Box
                        key={p.ply}
                        component="button"
                        aria-label={`Blunder ${i + 1}`}
                        onClick={() => onSelect(i)}
                        sx={{
                            width: 20,
                            height: 20,
                            borderRadius: '50%',
                            cursor: 'pointer',
                            p: 0,
                            bgcolor: color,
                            border: current
                                ? '2px solid var(--accent)'
                                : '1px solid var(--line)',
                            boxShadow: current ? '0 0 10px -2px var(--accent)' : 'none',
                            transition: 'transform .1s, box-shadow .2s',
                            '&:hover': { transform: 'translateY(-1px)' },
                        }}
                    />
                )
            })}
        </Box>
    )
}

// The challenge: which move was the blunder + the ask.
function PromptCard({
    puzzle,
    index,
    total,
    phase,
}: {
    puzzle: BlunderPuzzle
    index: number
    total: number
    phase: 'awaiting' | 'grading' | 'revealed'
}) {
    return (
        <Box
            sx={{
                border: '1px solid var(--line-soft)',
                borderRadius: '10px',
                bgcolor: 'var(--bg-2)',
                p: 1.5,
                mb: 1.25,
            }}
        >
            <Typography
                sx={{
                    fontSize: 10.5,
                    letterSpacing: 1.2,
                    textTransform: 'uppercase',
                    color: 'var(--muted)',
                    mb: 0.5,
                }}
            >
                Blunder {index + 1} of {total}
            </Typography>
            <Typography sx={{ fontSize: 14, color: 'var(--text)', lineHeight: 1.45 }}>
                <Box component="span" sx={{ fontWeight: 700 }}>
                    {puzzle.playerName}
                </Box>{' '}
                played{' '}
                <Box
                    component="span"
                    sx={{
                        fontFamily: 'var(--font-mono)',
                        fontWeight: 700,
                        color: '#ca4a4a',
                    }}
                >
                    <MoveSan san={puzzle.playedSan} />??
                </Box>
            </Typography>
            <Typography sx={{ fontSize: 13, color: 'var(--text-dim)', mt: 0.75 }}>
                {phase === 'grading'
                    ? 'Checking your move…'
                    : phase === 'awaiting'
                        ? 'Your move — find what the engine saw.'
                        : 'Here is the engine’s line.'}
            </Typography>
        </Box>
    )
}

// The graded result: verdict, eval swing, and the engine's best line.
function FeedbackCard({ puzzle, attempt }: { puzzle: BlunderPuzzle; attempt: Attempt }) {
    const meta = GRADE_META[attempt.grade]
    const { Icon } = meta
    const line = useMemo(() => pvToSan(puzzle.fen, puzzle.bestPv), [puzzle.fen, puzzle.bestPv])

    return (
        <Box
            sx={{
                border: `1px solid ${meta.color}55`,
                borderRadius: '10px',
                bgcolor: `${meta.color}12`,
                p: 1.5,
            }}
        >
            <Box sx={{ display: 'flex', alignItems: 'center', gap: 0.75, mb: 1 }}>
                <Icon size={18} color={meta.color} />
                <Typography sx={{ fontSize: 14.5, fontWeight: 700, color: meta.color }}>
                    {meta.label}
                </Typography>
            </Box>

            {/* Eval swing: what the retry gets vs best play (player POV). */}
            <Box sx={{ display: 'flex', gap: 1, mb: 1 }}>
                <EvalChip
                    label="Your move"
                    san={attempt.san}
                    value={formatPlayerCp(attempt.playerCp)}
                />
                <EvalChip
                    label="Best"
                    san={line[0]?.san ?? puzzle.bestUci}
                    value={formatPlayerCp(attempt.bestCp)}
                    highlight
                />
            </Box>

            {/* The engine's principal variation from the pre-blunder position. */}
            {line.length > 0 && (
                <Box>
                    <Typography
                        sx={{
                            fontSize: 10.5,
                            letterSpacing: 1.2,
                            textTransform: 'uppercase',
                            color: 'var(--muted)',
                            mb: 0.4,
                        }}
                    >
                        Engine line
                    </Typography>
                    <Box
                        sx={{
                            fontFamily: 'var(--font-mono)',
                            fontSize: 13,
                            color: 'var(--text)',
                            lineHeight: 1.6,
                            wordBreak: 'break-word',
                        }}
                    >
                        {line.map((m, i) => (
                            <Box component="span" key={i} sx={{ mr: 0.8 }}>
                                <MoveSan san={m.san} />
                            </Box>
                        ))}
                    </Box>
                </Box>
            )}
        </Box>
    )
}

function EvalChip({
    label,
    san,
    value,
    highlight,
}: {
    label: string
    san: string
    value: string
    highlight?: boolean
}) {
    return (
        <Box
            sx={{
                flex: 1,
                minWidth: 0,
                borderRadius: '8px',
                border: `1px solid ${highlight ? 'var(--accent-line)' : 'var(--line-soft)'}`,
                bgcolor: highlight ? 'var(--accent-soft)' : 'var(--surface-2)',
                px: 1,
                py: 0.75,
            }}
        >
            <Typography
                sx={{
                    fontSize: 9.5,
                    letterSpacing: 1,
                    textTransform: 'uppercase',
                    color: 'var(--muted)',
                }}
            >
                {label}
            </Typography>
            <Box
                sx={{
                    display: 'flex',
                    alignItems: 'baseline',
                    justifyContent: 'space-between',
                    gap: 0.5,
                }}
            >
                <Box
                    sx={{
                        fontFamily: 'var(--font-mono)',
                        fontSize: 13,
                        fontWeight: 600,
                        color: 'var(--text)',
                        overflow: 'hidden',
                        textOverflow: 'ellipsis',
                        whiteSpace: 'nowrap',
                    }}
                >
                    <MoveSan san={san} />
                </Box>
                <Typography
                    sx={{
                        fontFamily: 'var(--font-mono)',
                        fontSize: 13,
                        fontWeight: 700,
                        color: highlight ? 'var(--accent)' : 'var(--text-dim)',
                        flexShrink: 0,
                    }}
                >
                    {value}
                </Typography>
            </Box>
        </Box>
    )
}

// Shown once every blunder has been attempted.
function SummaryCard({
    recovered,
    total,
    onRestart,
}: {
    recovered: number
    total: number
    onRestart: () => void
}) {
    const perfect = recovered === total
    return (
        <Box
            sx={{
                border: '1px solid var(--accent-line)',
                borderRadius: '10px',
                bgcolor: 'var(--accent-soft)',
                p: 1.5,
                mb: 1.25,
                display: 'flex',
                flexDirection: 'column',
                gap: 1,
            }}
        >
            <Box sx={{ display: 'flex', alignItems: 'center', gap: 0.75 }}>
                <Trophy size={18} color="var(--accent)" />
                <Typography sx={{ fontSize: 14.5, fontWeight: 700, color: 'var(--text)' }}>
                    {perfect ? 'Redemption complete!' : 'Run complete'}
                </Typography>
            </Box>
            <Typography sx={{ fontSize: 13, color: 'var(--text-dim)' }}>
                You recovered {recovered} of {total} blunders
                {perfect ? ' — a clean sweep.' : '. Run it back to beat your score.'}
            </Typography>
            <Box sx={{ display: 'flex' }}>
                <ActionBtn
                    tone="neutral"
                    icon={<RotateCcw size={16} />}
                    label="Run it back"
                    onClick={onRestart}
                />
            </Box>
        </Box>
    )
}

/**
 * The launch banner shown in the game-review sidebar when the reviewed game has
 * blunders. Clicking it swaps `Analysis` into the Blunder Rewind experience.
 */
export function BlunderRewindBanner({ count, onStart }: { count: number; onStart: () => void }) {
    return (
        <Box
            component="button"
            onClick={onStart}
            aria-label="Start Blunder Rewind"
            sx={{
                display: 'flex',
                alignItems: 'center',
                gap: 1,
                width: '100%',
                textAlign: 'left',
                cursor: 'pointer',
                p: 1.25,
                borderTop: '1px solid var(--line-soft)',
                border: 'none',
                borderTopStyle: 'solid',
                bgcolor: 'transparent',
                background:
                    'linear-gradient(180deg, rgba(216,166,87,0.10), rgba(216,166,87,0.02))',
                transition: 'background .15s',
                '&:hover': {
                    background:
                        'linear-gradient(180deg, rgba(216,166,87,0.18), rgba(216,166,87,0.05))',
                },
            }}
        >
            <Box
                sx={{
                    width: 34,
                    height: 34,
                    flexShrink: 0,
                    borderRadius: '9px',
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'center',
                    color: '#15171c',
                    background: 'linear-gradient(180deg, #e3b56a, #d8a657)',
                    boxShadow: '0 0 14px -4px rgba(216,166,87,0.7)',
                }}
            >
                <Zap size={18} />
            </Box>
            <Box sx={{ minWidth: 0, flex: 1 }}>
                <Typography
                    sx={{
                        fontFamily: 'var(--font-display)',
                        fontSize: 13.5,
                        fontWeight: 700,
                        color: 'var(--text)',
                        lineHeight: 1.2,
                    }}
                >
                    Blunder Rewind
                </Typography>
                <Typography sx={{ fontSize: 11.5, color: 'var(--text-dim)' }}>
                    Replay {count} blunder{count === 1 ? '' : 's'} · find what the engine saw
                </Typography>
            </Box>
            <ChevronRight size={18} color="var(--text-dim)" />
        </Box>
    )
}
