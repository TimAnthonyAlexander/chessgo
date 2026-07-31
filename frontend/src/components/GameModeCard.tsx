import { Box, Typography } from '@mui/material'
import { Infinity as InfinityIcon } from 'lucide-react'
import { type Variant, VARIANT_LABEL } from '../lib/variants'
import { UNLOSABLE_RATING } from '../lib/botSettings'

/** Left-side game-mode card. Untimed, casual play vs the engine; the headline
 * reflects the chosen variant (Standard → "Casual", otherwise the variant name).
 *
 * Deliberately says nothing about WHO is playing: the opponent's name and rating
 * live in the MovePanel header, the one place they're wired to the zenMode /
 * showOpponentRating preferences. Repeating them here duplicated that readout
 * and ignored those preferences — don't re-add it.
 *
 * It also stays off the variant BLURB: this card renders beside the setup panel
 * while no game exists, and VariantPicker already prints the selected variant's
 * blurb there. Two copies of the same sentence, side by side. */
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
        </Box>
    )
}
