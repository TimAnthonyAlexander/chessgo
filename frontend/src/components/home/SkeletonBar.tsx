import { Box } from '@mui/material'
import type { SxProps, Theme } from '@mui/material'

/** A single pulsing placeholder bar, used while a board card's text is loading.
 * Matches the muted surface tone the rest of the dashboard uses; the gentle
 * opacity pulse signals "loading" without a spinner. */
export default function SkeletonBar({
    w = '100%',
    h = 11,
    sx,
}: {
    w?: number | string
    h?: number | string
    sx?: SxProps<Theme>
}) {
    return (
        <Box
            sx={[
                {
                    width: w,
                    height: h,
                    borderRadius: 'var(--radius)',
                    bgcolor: 'var(--surface-2)',
                    animation: 'skBarPulse 1.4s ease-in-out infinite',
                    '@keyframes skBarPulse': {
                        '0%, 100%': { opacity: 0.45 },
                        '50%': { opacity: 0.9 },
                    },
                },
                ...(Array.isArray(sx) ? sx : [sx]),
            ]}
        />
    )
}
