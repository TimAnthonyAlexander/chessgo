import { Box, Typography } from '@mui/material'
import type { TutorCategoryReport } from '../../api/client'

/** States plainly what the active category's numbers are compared against — a
 * bare "78%" means nothing without it. It lives in the rail rather than above
 * the content because it is the frame around every meter on the page, not one
 * more claim inside it. */
export default function PeerBanner({ category }: { category: TutorCategoryReport }) {
    const { peer } = category
    const none = peer.tier === 'none'

    return (
        <Box>
            <Typography
                sx={{
                    fontFamily: 'var(--font-mono)',
                    fontSize: 11,
                    fontWeight: 600,
                    letterSpacing: '0.16em',
                    textTransform: 'uppercase',
                    color: 'var(--text-dim)',
                    mb: 0.75,
                }}
            >
                Measured against
            </Typography>

            {none ? (
                <Typography sx={{ fontSize: 13, color: 'var(--text-dim)', lineHeight: 1.55 }}>
                    Nobody, yet. There isn't enough peer data in this band, so the figures are yours
                    alone and no comparison bars are drawn.
                </Typography>
            ) : (
                <>
                    <Typography
                        sx={{
                            fontFamily: 'var(--font-display)',
                            fontSize: 20,
                            fontWeight: 700,
                            lineHeight: 1.15,
                            color: 'var(--text)',
                        }}
                    >
                        {peer.bandFrom}–{peer.bandTo}
                    </Typography>
                    <Typography
                        sx={{ fontSize: 12.5, color: 'var(--muted)', mt: 0.25, lineHeight: 1.5 }}
                    >
                        Players in this rating band
                        {peer.tier === 'widened' ? ', widened for a bigger sample' : ''}.
                    </Typography>
                </>
            )}

            <Typography
                sx={{
                    fontFamily: 'var(--font-mono)',
                    fontSize: 11,
                    color: 'var(--muted)',
                    mt: 1,
                    fontVariantNumeric: 'tabular-nums',
                }}
            >
                {category.games} of your {category.gamesAvailable} games
                {category.capHit ? ' (capped)' : ''}
            </Typography>
        </Box>
    )
}
