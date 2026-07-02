import { useEffect, useState } from 'react'
import { Box, Typography } from '@mui/material'
import { useNavigate } from 'react-router-dom'
import { Panel, PanelHead } from './Panel'
import SkeletonBar from './SkeletonBar'
import { EMPTY_FEN, STRIP_H } from './boardCard'
import MiniBoard from '../MiniBoard'
import { getDailyPuzzle, type DailyPuzzle } from '../../api/client'

/** Pretty-print a Lichess theme tag (e.g. "mateIn2" -> "Mate In 2"). */
function titleCaseTheme(theme: string): string {
    const spaced = theme
        .replace(/([a-z])([A-Z0-9])/g, '$1 $2')
        .replace(/[_-]+/g, ' ')
        .trim()
    return spaced
        .split(/\s+/)
        .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
        .join(' ')
}

/** The shared strip chrome above/below the board (fixed height so it lines up
 * with the Live-now card's player strips). */
function Strip({ children }: { children: React.ReactNode }) {
    return (
        <Box
            sx={{
                height: STRIP_H,
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'space-between',
                gap: 1,
                px: 1.25,
            }}
        >
            {children}
        </Box>
    )
}

/** Homepage "Puzzle of the day" widget. Self-contained: fetches once on mount,
 * shows the position + side-to-move + rating + a couple of themes, and routes to
 * the full trainer at /puzzles. While loading it renders an empty board plus
 * text skeletons — the board never late-pops, only the pieces appear on load.
 * The solution is never fetched here. */
export default function DailyPuzzleWidget() {
    const navigate = useNavigate()
    const [puzzle, setPuzzle] = useState<DailyPuzzle | null>(null)
    const [error, setError] = useState(false)

    useEffect(() => {
        let alive = true
        getDailyPuzzle()
            .then((p) => {
                if (alive) setPuzzle(p)
            })
            .catch(() => {
                if (alive) setError(true)
            })
        return () => {
            alive = false
        }
    }, [])

    const goSolve = () => navigate('/puzzles')
    const interactive = Boolean(puzzle) && !error

    const head = <PanelHead title="Daily puzzle" sub="Find the best move" />

    if (error) {
        return (
            <Panel>
                {head}
                <Typography
                    sx={{ fontSize: 13, color: 'var(--muted)', py: 4, textAlign: 'center' }}
                >
                    Couldn't load today's puzzle
                </Typography>
            </Panel>
        )
    }

    const themeLabel =
        puzzle && puzzle.themes.length > 0
            ? puzzle.themes.slice(0, 2).map(titleCaseTheme).join(' · ')
            : puzzle
              ? 'Tactics'
              : ''

    const body = (
        <>
            {head}
            <Box
                sx={{
                    border: '1px solid var(--line-soft)',
                    borderRadius: '10px',
                    overflow: 'hidden',
                    bgcolor: 'var(--surface-2)',
                }}
            >
                {/* Top strip: side to move + rating (skeletons while loading). */}
                <Strip>
                    {puzzle ? (
                        <>
                            <Typography
                                sx={{
                                    fontFamily: 'var(--font-display)',
                                    fontSize: 14,
                                    fontWeight: 600,
                                    color: 'var(--text)',
                                }}
                            >
                                {puzzle.color === 'w' ? 'White to move' : 'Black to move'}
                            </Typography>
                            <Typography
                                sx={{
                                    fontFamily: 'var(--font-mono)',
                                    fontSize: 13,
                                    color: 'var(--text-dim)',
                                }}
                            >
                                Rating {puzzle.rating}
                            </Typography>
                        </>
                    ) : (
                        <>
                            <SkeletonBar w={104} />
                            <SkeletonBar w={62} />
                        </>
                    )}
                </Strip>

                <MiniBoard
                    fen={puzzle ? puzzle.fen : EMPTY_FEN}
                    lastMove={puzzle ? puzzle.opponent_move : undefined}
                    orientation={puzzle ? puzzle.color : 'w'}
                />

                {/* Bottom strip: themes + a "solve" affordance. */}
                <Strip>
                    {puzzle ? (
                        <>
                            <Typography
                                sx={{
                                    fontSize: 12.5,
                                    color: 'var(--text-dim)',
                                    overflow: 'hidden',
                                    textOverflow: 'ellipsis',
                                    whiteSpace: 'nowrap',
                                }}
                            >
                                {themeLabel}
                            </Typography>
                            <Typography
                                sx={{
                                    fontSize: 13,
                                    fontWeight: 600,
                                    color: 'var(--accent)',
                                    flexShrink: 0,
                                }}
                            >
                                Solve →
                            </Typography>
                        </>
                    ) : (
                        <>
                            <SkeletonBar w={120} />
                            <SkeletonBar w={44} />
                        </>
                    )}
                </Strip>
            </Box>
        </>
    )

    return (
        <Panel
            sx={
                interactive
                    ? {
                          cursor: 'pointer',
                          transition: 'border-color 0.12s ease',
                          '&:hover': { borderColor: 'var(--accent-line)' },
                      }
                    : undefined
            }
        >
            {interactive ? (
                <Box
                    role="button"
                    tabIndex={0}
                    onClick={goSolve}
                    onKeyDown={(e) => {
                        if (e.key === 'Enter' || e.key === ' ') {
                            e.preventDefault()
                            goSolve()
                        }
                    }}
                    sx={{ outline: 'none' }}
                >
                    {body}
                </Box>
            ) : (
                body
            )}
        </Panel>
    )
}
