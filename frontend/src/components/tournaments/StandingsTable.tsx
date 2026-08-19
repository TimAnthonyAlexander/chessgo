import { Box, Typography } from '@mui/material'
import { Link } from 'react-router-dom'
import type { TournamentStanding } from '../../api/client'
import TitleBadge from '../TitleBadge'

// Four columns fit at 375px without a scroll container: rank, the name
// (which shrinks/ellipsises first), and two right-aligned tabular numbers.
// The two numeric columns widen slightly on larger screens along with the
// row padding — this is the primary surface on the detail page now, so it
// gets room to breathe rather than staying pinned to its mobile minimum.
const gridSx = {
    display: 'grid',
    gridTemplateColumns: { xs: '22px 1fr 44px 34px', md: '28px 1fr 60px 46px' },
    columnGap: 10,
    alignItems: 'center',
} as const

/** Rank / title+name / score / games played, for one tournament's live
 * standings. Withdrawn players stay listed (struck through) rather than
 * disappearing — their score/games are still real results. The caller's own
 * row (by `currentUserId`) gets a soft highlight. */
export default function StandingsTable({
    standings,
    currentUserId,
}: {
    standings: TournamentStanding[]
    currentUserId?: string | null
}) {
    if (standings.length === 0) {
        return (
            <Box
                sx={{
                    py: 5,
                    textAlign: 'center',
                    color: 'var(--muted)',
                    fontSize: 13.5,
                    border: '1px dashed var(--line)',
                    borderRadius: 'var(--radius)',
                }}
            >
                No players yet.
            </Box>
        )
    }

    return (
        <Box
            sx={{
                border: '1px solid var(--line-soft)',
                borderRadius: 'var(--radius)',
                bgcolor: 'var(--surface)',
                overflow: 'hidden',
            }}
        >
            <Box
                sx={{
                    ...gridSx,
                    px: { xs: 1.5, md: 2 },
                    py: 0.85,
                    bgcolor: 'var(--surface-2)',
                    borderBottom: '1px solid var(--line-soft)',
                    fontFamily: 'var(--font-mono)',
                    fontSize: 10.5,
                    letterSpacing: '0.08em',
                    textTransform: 'uppercase',
                    color: 'var(--muted)',
                    fontWeight: 700,
                }}
            >
                <span>#</span>
                <span>Player</span>
                <span style={{ textAlign: 'right' }}>Pts</span>
                <span style={{ textAlign: 'right' }}>Gms</span>
            </Box>
            {standings.map((s, i) => {
                const mine = s.user_id === currentUserId
                return (
                <Box
                    key={s.user_id}
                    sx={{
                        ...gridSx,
                        px: { xs: 1.5, md: 2 },
                        py: { xs: 0.85, md: 1.05 },
                        borderBottom: i < standings.length - 1 ? '1px solid var(--line-soft)' : 'none',
                        bgcolor: mine ? 'var(--accent-soft)' : 'transparent',
                        boxShadow: mine ? 'inset 3px 0 0 var(--accent)' : 'none',
                    }}
                >
                    <Typography
                        sx={{
                            fontFamily: 'var(--font-mono)',
                            fontSize: 12.5,
                            fontWeight: i < 3 ? 700 : 400,
                            color: i === 0 ? 'var(--accent)' : 'var(--text-dim)',
                        }}
                    >
                        {i + 1}
                    </Typography>
                    <Box sx={{ display: 'flex', alignItems: 'center', gap: 0.6, minWidth: 0 }}>
                        <TitleBadge title={s.title} />
                        {s.name ? (
                            <Typography
                                component={Link}
                                to={`/@/${encodeURIComponent(s.name)}`}
                                sx={{
                                    fontSize: { xs: 13.5, md: 14 },
                                    fontWeight: mine ? 700 : 600,
                                    color: s.withdrawn ? 'var(--muted)' : 'var(--text)',
                                    textDecoration: s.withdrawn ? 'line-through' : 'none',
                                    overflow: 'hidden',
                                    textOverflow: 'ellipsis',
                                    whiteSpace: 'nowrap',
                                    minWidth: 0,
                                    '&:hover': { color: 'var(--accent)' },
                                }}
                            >
                                {s.name}
                            </Typography>
                        ) : (
                            <Typography
                                sx={{
                                    fontSize: { xs: 13.5, md: 14 },
                                    fontWeight: 600,
                                    color: 'var(--muted)',
                                    overflow: 'hidden',
                                    textOverflow: 'ellipsis',
                                    whiteSpace: 'nowrap',
                                    minWidth: 0,
                                }}
                            >
                                Unknown
                            </Typography>
                        )}
                        {s.withdrawn && (
                            <Typography
                                sx={{
                                    fontSize: 10.5,
                                    color: 'var(--muted)',
                                    flexShrink: 0,
                                    textTransform: 'uppercase',
                                    letterSpacing: '0.05em',
                                }}
                            >
                                withdrawn
                            </Typography>
                        )}
                    </Box>
                    <Typography
                        sx={{
                            fontFamily: 'var(--font-mono)',
                            fontSize: 13,
                            fontWeight: 700,
                            textAlign: 'right',
                            fontVariantNumeric: 'tabular-nums',
                        }}
                    >
                        {s.score}
                    </Typography>
                    <Typography
                        sx={{
                            fontFamily: 'var(--font-mono)',
                            fontSize: 13,
                            color: 'var(--text-dim)',
                            textAlign: 'right',
                            fontVariantNumeric: 'tabular-nums',
                        }}
                    >
                        {s.games}
                    </Typography>
                </Box>
                )
            })}
        </Box>
    )
}
