import { Box, Typography } from '@mui/material'
import type { ReactNode } from 'react'

/** One labelled telemetry field: an uppercase mono micro-label over a value. The
 * value is emphasised (mono) and can carry an accent (e.g. red for a big gap) plus
 * a comparison hint (the "expected" baseline the flag measured against). */
export default function MetaField({
    label,
    value,
    accent,
    hint,
}: {
    label: string
    value: ReactNode
    accent?: string
    hint?: string
}) {
    return (
        <Box
            sx={{
                bgcolor: 'var(--surface-2)',
                border: '1px solid var(--line-soft)',
                borderRadius: 'var(--radius)',
                px: 1.125,
                py: 0.875,
                minWidth: 0,
            }}
        >
            <Typography
                sx={{
                    fontFamily: 'var(--font-mono)',
                    fontSize: 9.5,
                    letterSpacing: '0.1em',
                    textTransform: 'uppercase',
                    color: 'var(--muted)',
                }}
            >
                {label}
            </Typography>
            <Typography
                sx={{
                    fontFamily: 'var(--font-mono)',
                    fontSize: 14,
                    fontWeight: 700,
                    color: accent ?? 'var(--text)',
                    mt: 0.375,
                    lineHeight: 1.2,
                    overflow: 'hidden',
                    textOverflow: 'ellipsis',
                    whiteSpace: 'nowrap',
                }}
            >
                {value}
            </Typography>
            {hint && (
                <Typography sx={{ fontSize: 10.5, color: 'var(--muted)', mt: 0.25 }}>
                    {hint}
                </Typography>
            )}
        </Box>
    )
}
