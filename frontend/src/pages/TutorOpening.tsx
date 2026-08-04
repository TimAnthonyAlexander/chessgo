import { useEffect, useState } from 'react'
import { Box, Button, Typography } from '@mui/material'
import { ArrowRight, ChevronLeft } from 'lucide-react'
import { Link, useNavigate, useParams } from 'react-router-dom'
import {
    ApiError,
    getTutorOpening,
    type TutorGameRow,
    type TutorOpeningDetail,
} from '../api/client'
import ComparisonRow from '../components/tutor/ComparisonRow'
import { fmtDate } from '../components/tutor/format'

/** `/tutor/:id/:category/opening/:color/:family` — one opening family from
 * one side, drilled down from a category's Openings breakdown: the summary,
 * the peer comparison (if there were enough games in it), and every game
 * behind the number. Served from `getTutorOpening`, which reads straight off
 * the stored report payload — no re-analysis. */
export default function TutorOpening() {
    const {
        id = '',
        category = '',
        color = 'w',
        family = '',
    } = useParams<{ id: string; category: string; color: string; family: string }>()
    const side: 'w' | 'b' = color === 'b' ? 'b' : 'w'

    const [detail, setDetail] = useState<TutorOpeningDetail | null>(null)
    const [loading, setLoading] = useState(true)
    const [error, setError] = useState<string | null>(null)

    useEffect(() => {
        let cancelled = false
        setLoading(true)
        setError(null)
        getTutorOpening(id, category, side, family)
            .then((d) => {
                if (cancelled) return
                setDetail(d)
                setLoading(false)
            })
            .catch((e) => {
                if (cancelled) return
                setError(
                    e instanceof ApiError && e.status === 404
                        ? "You have no games in this opening from this side in this report."
                        : (e as Error).message,
                )
                setLoading(false)
            })
        return () => {
            cancelled = true
        }
    }, [id, category, side, family])

    return (
        <Box
            sx={{
                flex: 1,
                display: 'flex',
                justifyContent: 'center',
                px: { xs: 1.5, md: 3 },
                py: { xs: 2, md: 3.5 },
            }}
        >
            <Box sx={{ width: '100%', maxWidth: 780 }}>
                <Box
                    component={Link}
                    to={`/tutor/${encodeURIComponent(id)}`}
                    sx={{
                        display: 'inline-flex',
                        alignItems: 'center',
                        gap: 0.5,
                        mb: 2.5,
                        fontSize: 12.5,
                        fontWeight: 600,
                        color: 'var(--text-dim)',
                        textDecoration: 'none',
                        '&:hover': { color: 'var(--accent)' },
                    }}
                >
                    <ChevronLeft size={14} />
                    Back to report
                </Box>

                {loading ? (
                    <Centered>Loading…</Centered>
                ) : error || !detail ? (
                    <Centered>{error ?? 'Opening not found.'}</Centered>
                ) : (
                    <OpeningDetailView detail={detail} />
                )}
            </Box>
        </Box>
    )
}

function OpeningDetailView({ detail }: { detail: TutorOpeningDetail }) {
    const navigate = useNavigate()
    const sideLabel = detail.color === 'w' ? 'White' : 'Black'
    const accCount = detail.games.filter((g) => g.accuracy != null).length
    const noPeer = !detail.peer || detail.peer.tier === 'none'

    return (
        <Box sx={{ display: 'flex', flexDirection: 'column', gap: 2.5 }}>
            <Box sx={{ pb: 2, borderBottom: '1px solid var(--line-soft)' }}>
                <Typography
                    sx={{
                        fontFamily: 'var(--font-display)',
                        fontWeight: 700,
                        fontSize: { xs: 22, md: 28 },
                        lineHeight: 1.15,
                    }}
                >
                    {detail.family} <Box component="span" sx={{ color: 'var(--text-dim)' }}>— as {sideLabel}</Box>
                </Typography>

                <Box sx={{ display: 'flex', flexWrap: 'wrap', gap: 3, mt: 2 }}>
                    <Stat label="Games" value={String(detail.summary.games)} />
                    <Stat
                        label="Score"
                        value={detail.summary.score != null ? `${detail.summary.score}%` : '—'}
                        sub={`${detail.summary.games} games`}
                    />
                    <Stat
                        label="Accuracy"
                        value={detail.summary.accuracy != null ? `${detail.summary.accuracy}%` : '—'}
                        sub={`${accCount} games`}
                    />
                </Box>

                <Box sx={{ mt: 2.5 }}>
                    <Button
                        variant="contained"
                        endIcon={<ArrowRight size={15} />}
                        onClick={() =>
                            navigate(
                                `/bot?opening=${encodeURIComponent(detail.family)}&color=${detail.color}`,
                            )
                        }
                        sx={{ textTransform: 'none', fontWeight: 600 }}
                    >
                        Drill this opening
                    </Button>
                </Box>
            </Box>

            <Box>
                <SectionLabel>Vs peers</SectionLabel>
                {detail.comparison && !noPeer ? (
                    <>
                        {/* No forced tone — the row takes its ink from the
                            (direction-corrected) grade, so a bad result in this
                            opening can't render in the accent. */}
                        <ComparisonRow c={detail.comparison} />
                        <Typography sx={{ fontSize: 11.5, color: 'var(--muted)', mt: 1 }}>
                            Compared to players rated {detail.peer!.bandFrom}–{detail.peer!.bandTo}
                            {detail.peer!.tier === 'widened' ? ' (band widened for a bigger sample)' : ''}.
                        </Typography>
                    </>
                ) : (
                    <Typography sx={{ fontSize: 13, color: 'var(--text-dim)' }}>
                        There weren't enough games in this opening to compare it against peers yet.
                    </Typography>
                )}
            </Box>

            <Box>
                <SectionLabel>Games</SectionLabel>
                {detail.games.length === 0 ? (
                    <Typography sx={{ fontSize: 13, color: 'var(--muted)' }}>No games recorded.</Typography>
                ) : (
                    <GamesTable games={detail.games} />
                )}
            </Box>
        </Box>
    )
}

function GamesTable({ games }: { games: TutorGameRow[] }) {
    return (
        <Box sx={{ overflowX: 'auto' }}>
            <Box component="table" sx={{ width: '100%', borderCollapse: 'collapse', minWidth: 480 }}>
                <Box component="thead">
                    <Box component="tr">
                        <Th align="left">Date</Th>
                        <Th>Result</Th>
                        <Th>You</Th>
                        <Th>Opponent</Th>
                        <Th align="right">Accuracy</Th>
                    </Box>
                </Box>
                <Box component="tbody">
                    {games.map((g) => (
                        <GameRowLink key={g.gameId} game={g} />
                    ))}
                </Box>
            </Box>
        </Box>
    )
}

function GameRowLink({ game }: { game: TutorGameRow }) {
    const navigate = useNavigate()
    const outcome = resultFor(game)
    const outcomeColor =
        outcome === 'Win' ? 'var(--good)' : outcome === 'Loss' ? 'var(--bad)' : 'var(--text-dim)'

    return (
        <Box
            component="tr"
            onClick={() => navigate(`/analysis/${encodeURIComponent(game.gameId)}`)}
            sx={{ cursor: 'pointer', '&:hover': { bgcolor: 'var(--surface-2)' } }}
        >
            <Td align="left">{fmtDate(game.playedAt) || '—'}</Td>
            <Td>
                <Box component="span" sx={{ color: outcomeColor, fontWeight: 700 }}>
                    {outcome}
                </Box>
            </Td>
            <Td>{game.myRating ?? '—'}</Td>
            <Td>{game.oppRating ?? '—'}</Td>
            <Td align="right">{game.accuracy != null ? `${game.accuracy}%` : '—'}</Td>
        </Box>
    )
}

// Result is stored as the game's raw PGN result ('1-0' / '0-1' / '1/2-1/2'),
// shared across both players — resolve it to this row's own outcome using its
// `color`, the same way profile/shared.ts's `perspective()` does for the
// profile game list.
function resultFor(g: TutorGameRow): 'Win' | 'Loss' | 'Draw' {
    if (g.result === '1/2-1/2') return 'Draw'
    const whiteWon = g.result === '1-0'
    const won = g.color === 'w' ? whiteWon : !whiteWon
    return won ? 'Win' : 'Loss'
}

function Stat({ label, value, sub }: { label: string; value: string; sub?: string }) {
    return (
        <Box>
            <Typography
                sx={{
                    fontFamily: 'var(--font-mono)',
                    fontSize: 10.5,
                    letterSpacing: '0.1em',
                    textTransform: 'uppercase',
                    color: 'var(--muted)',
                }}
            >
                {label}
            </Typography>
            <Typography
                sx={{ fontFamily: 'var(--font-display)', fontSize: 22, fontWeight: 700, lineHeight: 1.1 }}
            >
                {value}
            </Typography>
            {sub && (
                <Typography sx={{ fontSize: 11, color: 'var(--muted)', mt: 0.15 }}>{sub}</Typography>
            )}
        </Box>
    )
}

function SectionLabel({ children }: { children: React.ReactNode }) {
    return (
        <Typography
            sx={{
                fontFamily: 'var(--font-mono)',
                fontSize: 11.5,
                letterSpacing: '0.12em',
                textTransform: 'uppercase',
                color: 'var(--muted)',
                mb: 1,
            }}
        >
            {children}
        </Typography>
    )
}

function Th({ children, align = 'center' }: { children: React.ReactNode; align?: 'left' | 'right' | 'center' }) {
    return (
        <Box
            component="th"
            sx={{
                textAlign: align,
                fontSize: 11,
                fontFamily: 'var(--font-mono)',
                textTransform: 'uppercase',
                letterSpacing: '0.08em',
                color: 'var(--muted)',
                fontWeight: 600,
                py: 0.75,
                px: 1,
                borderBottom: '1px solid var(--line-soft)',
                whiteSpace: 'nowrap',
            }}
        >
            {children}
        </Box>
    )
}

function Td({ children, align = 'center' }: { children: React.ReactNode; align?: 'left' | 'right' | 'center' }) {
    return (
        <Box
            component="td"
            sx={{
                textAlign: align,
                fontSize: 12.5,
                fontFamily: align === 'left' ? 'inherit' : 'var(--font-mono)',
                color: align === 'left' ? 'var(--text)' : 'var(--text-dim)',
                py: 0.75,
                px: 1,
                borderBottom: '1px solid var(--line-soft)',
                whiteSpace: 'nowrap',
            }}
        >
            <Typography component="span" sx={{ fontSize: 'inherit', fontFamily: 'inherit' }}>
                {children}
            </Typography>
        </Box>
    )
}

function Centered({ children }: { children: React.ReactNode }) {
    return (
        <Box sx={{ py: 8, textAlign: 'center' }}>
            <Typography sx={{ fontSize: 14, color: 'var(--text-dim)' }}>{children}</Typography>
        </Box>
    )
}
