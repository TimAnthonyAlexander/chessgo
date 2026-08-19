import { memo, type ReactNode } from 'react'
import { Box, Typography } from '@mui/material'
import type { SxProps, Theme } from '@mui/material'
import { Crown, Rabbit, Timer, Zap } from 'lucide-react'
import { type Variant, VARIANT_LABEL } from '../lib/variants'

/** Left-side card for a live human game: time-control category, rated/casual, and
 * variant (when not standard).
 *
 * Deliberately says nothing about WHO is playing or which colour you are: both
 * player rows sit beside the board with names and ratings, and your own colour is
 * implied by the orientation you're looking at. Repeating it here was noise.
 *
 * memo()'d: all three props (pool, rated, variant) are primitives that never
 * change mid-game, so this only ever renders once per game. */
function LiveModeCard({
    pool,
    rated,
    variant = 'standard',
    flat = false,
}: {
    pool: string
    rated: boolean
    variant?: Variant
    /** Render as a panel HEADER rather than a standalone card: no chrome of its
     *  own, a single compact row, and a hairline under it. Used by the side-rail
     *  layout, where this sits as the first row of the move panel so the two read
     *  as one continuous box instead of two cards with a gap between them. */
    flat?: boolean
}) {
    const cat = categoryFor(pool)

    if (flat)
        return (
            <Box
                sx={{
                    display: 'flex',
                    alignItems: 'center',
                    gap: 1,
                    px: 1.75,
                    py: 1.25,
                    bgcolor: 'var(--bg-2)',
                    borderBottom: '1px solid var(--line-soft)',
                }}
            >
                <Box sx={{ display: 'flex', color: 'var(--accent)' }}>{cat.icon}</Box>
                <Typography
                    sx={{ fontFamily: 'var(--font-display)', fontSize: 17, fontWeight: 700 }}
                >
                    {cat.label}
                </Typography>
                <Typography
                    sx={{
                        fontFamily: 'var(--font-mono)',
                        fontSize: 12.5,
                        color: 'var(--text-dim)',
                    }}
                >
                    {pool}
                </Typography>
                <Box sx={{ flex: 1 }} />
                {variant !== 'standard' && <VariantChip variant={variant} />}
                <Typography
                    sx={{
                        fontFamily: 'var(--font-mono)',
                        fontSize: 11,
                        letterSpacing: '0.2em',
                        textTransform: 'uppercase',
                        color: 'var(--text-dim)',
                    }}
                >
                    {rated ? 'Rated' : 'Casual'}
                </Typography>
            </Box>
        )

    return (
        <Box
            sx={{
                bgcolor: 'var(--surface)',
                border: '1px solid var(--line-soft)',
                borderRadius: 'var(--radius)',
                p: 2.5,
                boxShadow: 'var(--shadow)',
            }}
        >
            <Box sx={{ display: 'flex', alignItems: 'center', gap: 1, color: 'var(--accent)' }}>
                {cat.icon}
                <Typography
                    sx={{
                        fontFamily: 'var(--font-mono)',
                        fontSize: 11,
                        letterSpacing: '0.2em',
                        textTransform: 'uppercase',
                        color: 'var(--text-dim)',
                    }}
                >
                    {rated ? 'Rated' : 'Casual'}
                </Typography>
                {variant !== 'standard' && <VariantChip variant={variant} sx={{ ml: 'auto' }} />}
            </Box>

            <Typography
                sx={{
                    fontFamily: 'var(--font-display)',
                    fontSize: 32,
                    fontWeight: 600,
                    mt: 1,
                    lineHeight: 1,
                }}
            >
                {cat.label}
            </Typography>
            <Typography
                sx={{
                    fontFamily: 'var(--font-mono)',
                    fontSize: 14,
                    color: 'var(--text-dim)',
                    mt: 0.75,
                }}
            >
                {pool}
            </Typography>
        </Box>
    )
}

export default memo(LiveModeCard)

/** The non-standard-variant badge, shared by the card and the flat header. */
function VariantChip({ variant, sx }: { variant: Variant; sx?: SxProps<Theme> }) {
    return (
        <Box
            sx={{
                px: 1,
                py: 0.3,
                borderRadius: 'var(--radius)',
                fontFamily: 'var(--font-mono)',
                fontSize: 10.5,
                fontWeight: 700,
                letterSpacing: '0.1em',
                textTransform: 'uppercase',
                color: 'var(--accent)',
                bgcolor: 'var(--accent-soft)',
                border: '1px solid var(--accent-line)',
                ...sx,
            }}
        >
            {VARIANT_LABEL[variant]}
        </Box>
    )
}

/** Map a "base+inc" pool (minutes + seconds) to a Lichess-style category. */
function categoryFor(pool: string): { label: string; icon: ReactNode } {
    const [baseMin, incSec] = pool.split('+').map((n) => Number(n) || 0)
    const estSec = baseMin * 60 + incSec * 40
    if (estSec < 180) return { label: 'Bullet', icon: <Rabbit size={17} /> }
    if (estSec < 480) return { label: 'Blitz', icon: <Zap size={17} /> }
    if (estSec < 1500) return { label: 'Rapid', icon: <Timer size={17} /> }
    return { label: 'Classical', icon: <Crown size={17} /> }
}
