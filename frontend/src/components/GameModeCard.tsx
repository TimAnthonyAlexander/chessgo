import { Box, Typography } from '@mui/material'
import { Infinity as InfinityIcon } from 'lucide-react'
import { type Variant, VARIANT_LABEL } from '../lib/variants'
import { ratingLabel, UNLOSABLE_RATING } from '../lib/botSettings'
import NewBadge from './NewBadge'

/** Left-side game-mode card. Untimed, casual play vs the engine; the headline
 * reflects the chosen variant (Standard → "Casual", otherwise the variant name). */
export default function GameModeCard({
    rating,
    variant = 'standard',
}: {
    rating: number
    variant?: Variant
}) {
    // "Unlosable" is Standard rules with a sentinel rating, so it headlines by
    // strength rather than variant; every other Standard game stays "Casual".
    const title =
        rating <= UNLOSABLE_RATING
            ? 'Unlosable'
            : variant === 'standard'
              ? 'Casual'
              : VARIANT_LABEL[variant]
    return (
        <Box
            sx={{
                bgcolor: 'var(--surface)',
                border: '1px solid var(--line-soft)',
                borderRadius: '14px',
                p: 2.5,
                boxShadow: '0 18px 50px -28px rgba(0,0,0,0.8)',
            }}
        >
            <Box sx={{ display: 'flex', alignItems: 'center', gap: 1, color: 'var(--accent)' }}>
                <InfinityIcon size={17} />
                <Typography
                    sx={{
                        fontFamily: 'var(--font-mono)',
                        fontSize: 11,
                        letterSpacing: '0.2em',
                        textTransform: 'uppercase',
                        color: 'var(--text-dim)',
                    }}
                >
                    Untimed
                </Typography>
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
                {title}
            </Typography>

            <Box sx={{ borderTop: '1px solid var(--line-soft)', mt: 2.25, pt: 2.25 }}>
                <Typography
                    sx={{
                        fontFamily: 'var(--font-mono)',
                        fontSize: 10.5,
                        letterSpacing: '0.16em',
                        textTransform: 'uppercase',
                        color: 'var(--muted)',
                        mb: 0.75,
                    }}
                >
                    Opponent
                </Typography>
                <Box sx={{ display: 'flex', alignItems: 'center', gap: 0.75 }}>
                    <Typography sx={{ fontWeight: 600, fontSize: 16 }}>Zugzwang</Typography>
                    <NewBadge />
                </Box>
                <Typography sx={{ color: 'var(--text-dim)', fontSize: 13.5 }}>
                    Engine · {ratingLabel(rating)}
                </Typography>
            </Box>
        </Box>
    )
}
