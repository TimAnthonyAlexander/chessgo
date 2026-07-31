import { Box, Typography } from '@mui/material'
import type { TournamentSummary } from '../../api/client'
import { VARIANT_LABEL } from '../../lib/variants'
import {
    clockTime,
    formatMinutes,
    isFeaturedSeries,
    parseStartsAt,
    restrictionText,
    stateText,
    STARTING_SOON_MS,
} from './timing'

/** The schedule's column grid — one template shared by the header and every
 * row so they always line up. Narrower at `xs`: variant and duration drop
 * (they're the least decision-relevant columns), everything else stays put
 * so the table never forces a sideways scroll on the page at 375px. */
export const ROW_GRID_SX = {
    display: 'grid',
    gridTemplateColumns: {
        xs: '46px minmax(0,1fr) 50px 34px 76px',
        sm: '58px minmax(0,1fr) 84px 56px 50px 46px 112px',
    },
    gridTemplateAreas: {
        xs: '"time name clock players state"',
        sm: '"time name variant clock duration players state"',
    },
    columnGap: { xs: 8, sm: 12 },
    alignItems: 'center',
} as const

const num = { fontVariantNumeric: 'tabular-nums', fontFamily: 'var(--font-mono)' } as const

/** One row of the schedule table: a fixed 5–7 column grid (see
 * {@link ROW_GRID_SX}), the whole row clickable, tight enough to read as a
 * broadcast schedule rather than a stack of cards. */
export default function TournamentListRow({
    t,
    now,
    onClick,
}: {
    t: TournamentSummary
    now: number
    onClick: () => void
}) {
    const featured = isFeaturedSeries(t.series)
    const restriction = restrictionText(t)
    const startsAt = parseStartsAt(t.starts_at)
    const soon = t.status === 'scheduled' && startsAt - now <= STARTING_SOON_MS
    const live = t.status === 'running'

    return (
        <Box
            onClick={onClick}
            role="button"
            tabIndex={0}
            aria-label={t.name}
            onKeyDown={(e) => {
                if (e.key === 'Enter' || e.key === ' ') {
                    e.preventDefault()
                    onClick()
                }
            }}
            sx={{
                ...ROW_GRID_SX,
                px: { xs: 1, sm: 1.5 },
                py: featured ? { xs: 0.85, sm: 0.95 } : { xs: 0.5, sm: 0.55 },
                cursor: 'pointer',
                borderTop: '1px solid var(--line-soft)',
                '&:hover': { bgcolor: 'var(--surface-2)' },
                '&:focus-visible': { outline: '2px solid var(--accent)', outlineOffset: '-2px' },
            }}
        >
            <Typography sx={{ ...num, gridArea: 'time', fontSize: 12, color: 'var(--text-dim)' }}>
                {clockTime(t.status === 'finished' ? t.ends_at_ms : startsAt)}
            </Typography>

            <Box sx={{ gridArea: 'name', display: 'flex', alignItems: 'baseline', gap: 0.6, minWidth: 0 }}>
                <Typography
                    sx={{
                        fontFamily: 'var(--font-display)',
                        fontWeight: featured ? 700 : 500,
                        fontSize: featured ? { xs: 13.5, sm: 14.5 } : { xs: 12.5, sm: 13 },
                        color: featured ? 'var(--text)' : 'var(--text-dim)',
                        minWidth: 0,
                        overflow: 'hidden',
                        textOverflow: 'ellipsis',
                        whiteSpace: 'nowrap',
                    }}
                >
                    {t.name}
                </Typography>
                {restriction && (
                    <Box
                        component="span"
                        sx={{
                            flexShrink: 0,
                            fontSize: 10,
                            fontWeight: 700,
                            letterSpacing: '0.03em',
                            color: 'var(--muted)',
                            border: '1px solid var(--line)',
                            borderRadius: '5px',
                            px: 0.5,
                            py: '1px',
                        }}
                    >
                        {restriction}
                    </Box>
                )}
            </Box>

            <Typography
                sx={{
                    gridArea: 'variant',
                    display: { xs: 'none', sm: 'block' },
                    fontSize: 12,
                    color: 'var(--muted)',
                    overflow: 'hidden',
                    textOverflow: 'ellipsis',
                    whiteSpace: 'nowrap',
                }}
            >
                {VARIANT_LABEL[t.variant]}
            </Typography>

            <Typography sx={{ ...num, gridArea: 'clock', fontSize: 12, color: 'var(--text-dim)' }}>
                {t.pool}
            </Typography>

            <Typography
                sx={{
                    ...num,
                    gridArea: 'duration',
                    display: { xs: 'none', sm: 'block' },
                    fontSize: 12,
                    color: 'var(--muted)',
                    textAlign: 'right',
                }}
            >
                {formatMinutes(t.duration_minutes)}
            </Typography>

            <Typography
                sx={{ ...num, gridArea: 'players', fontSize: 12, color: 'var(--text-dim)', textAlign: 'right' }}
            >
                {t.player_count}
            </Typography>

            <Typography
                sx={{
                    ...num,
                    gridArea: 'state',
                    fontSize: 12,
                    fontWeight: 700,
                    textAlign: 'right',
                    whiteSpace: 'nowrap',
                    color: live || soon ? 'var(--accent)' : 'var(--text-dim)',
                }}
            >
                {stateText(t, now)}
            </Typography>
        </Box>
    )
}
