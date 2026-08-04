import { Box, Typography } from '@mui/material'
import type { TutorCategoryReport } from '../../api/client'

/** States plainly what a category's numbers are being compared against —
 * required per-category context, since a bare "78%" means nothing without it. */
export default function PeerBanner({ category }: { category: TutorCategoryReport }) {
    const { peer } = category
    const text =
        peer.tier === 'none'
            ? 'Not enough peer data to compare yet — numbers below are yours alone.'
            : peer.tier === 'widened'
              ? `Compared to players rated ${peer.bandFrom}–${peer.bandTo} (band widened for a bigger sample).`
              : `Compared to players rated ${peer.bandFrom}–${peer.bandTo}.`

    return (
        <Box
            sx={{
                display: 'flex',
                flexWrap: 'wrap',
                alignItems: 'baseline',
                justifyContent: 'space-between',
                gap: 1,
                py: 1.25,
                px: 1.5,
                mb: 2,
                borderRadius: '10px',
                bgcolor: 'var(--surface-2)',
            }}
        >
            <Typography sx={{ fontSize: 12.5, color: 'var(--text-dim)' }}>{text}</Typography>
            <Typography
                sx={{
                    fontFamily: 'var(--font-mono)',
                    fontSize: 11.5,
                    color: 'var(--muted)',
                    whiteSpace: 'nowrap',
                }}
            >
                Based on {category.games} of your {category.gamesAvailable} games
                {category.capHit ? ' (capped)' : ''}.
            </Typography>
        </Box>
    )
}
