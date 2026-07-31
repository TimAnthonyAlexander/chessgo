import { Box, Typography } from '@mui/material'
import { Users } from 'lucide-react'
import type { TournamentSummary } from '../../api/client'
import { VARIANT_LABEL } from '../../lib/variants'
import { timingText } from './timing'

/** One row in the tournament list: name + terms on the first line, pool /
 * player count / live timing on the second. Wraps naturally rather than
 * using a fixed grid, so it never needs a horizontal scroll at 375px. */
export default function TournamentListRow({
    t,
    now,
    onClick,
}: {
    t: TournamentSummary
    now: number
    onClick: () => void
}) {
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
                display: 'flex',
                flexWrap: 'wrap',
                alignItems: 'baseline',
                columnGap: 10,
                rowGap: 4,
                px: 1.5,
                py: 1.1,
                cursor: 'pointer',
                '&:hover': { bgcolor: 'var(--surface-2)' },
                '&:focus-visible': { outline: '2px solid var(--accent)', outlineOffset: '-2px' },
            }}
        >
            <Typography
                sx={{
                    fontFamily: 'var(--font-display)',
                    fontWeight: 700,
                    fontSize: 14.5,
                    minWidth: 0,
                    overflow: 'hidden',
                    textOverflow: 'ellipsis',
                    whiteSpace: 'nowrap',
                }}
            >
                {t.name}
            </Typography>
            {t.variant !== 'standard' && <Tag label={VARIANT_LABEL[t.variant]} />}
            <Tag label={t.rated ? 'Rated' : 'Casual'} accent={t.rated} />

            {/* Forces the meta row below the title row inside the wrapping flexbox. */}
            <Box sx={{ flexBasis: '100%', height: 0 }} />

            <Typography
                sx={{ fontFamily: 'var(--font-mono)', fontSize: 12.5, color: 'var(--text-dim)' }}
            >
                {t.pool}
            </Typography>
            <Box
                component="span"
                sx={{
                    display: 'inline-flex',
                    alignItems: 'center',
                    gap: 0.4,
                    fontSize: 12.5,
                    color: 'var(--text-dim)',
                }}
            >
                <Users size={12} /> {t.player_count}
            </Box>
            <Typography
                sx={{
                    ml: 'auto',
                    fontSize: 12.5,
                    fontWeight: 600,
                    color: t.status === 'running' ? 'var(--accent)' : 'var(--text-dim)',
                    whiteSpace: 'nowrap',
                }}
            >
                {timingText(t, now)}
            </Typography>
        </Box>
    )
}

function Tag({ label, accent }: { label: string; accent?: boolean }) {
    return (
        <Box
            component="span"
            sx={{
                fontSize: 10.5,
                fontWeight: 700,
                letterSpacing: '0.06em',
                textTransform: 'uppercase',
                color: accent ? 'var(--accent)' : 'var(--muted)',
                border: '1px solid',
                borderColor: accent ? 'var(--accent-line)' : 'var(--line)',
                borderRadius: '5px',
                px: 0.6,
                py: '1px',
                flexShrink: 0,
            }}
        >
            {label}
        </Box>
    )
}
