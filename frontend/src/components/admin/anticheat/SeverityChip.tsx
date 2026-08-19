import { Box, Typography } from '@mui/material'
import type { FlagSeverity } from '../../../api/client'
import { SEVERITY_META } from './shared'

/** A colour-coded severity pill (low / medium / high) — a tinted dot + label on a
 * soft, colour-matched background. `dense` drops the label for tight table cells. */
export default function SeverityChip({
    severity,
    dense = false,
}: {
    severity: FlagSeverity
    dense?: boolean
}) {
    const { label, color } = SEVERITY_META[severity] ?? { label: severity, color: 'var(--muted)' }
    return (
        <Box
            sx={{
                display: 'inline-flex',
                alignItems: 'center',
                gap: 0.625,
                px: dense ? 0.875 : 1,
                py: 0.375,
                borderRadius: 'var(--radius)',
                bgcolor: `color-mix(in srgb, ${color} 15%, transparent)`,
                border: `1px solid color-mix(in srgb, ${color} 40%, transparent)`,
                lineHeight: 1,
            }}
        >
            <Box sx={{ width: 6, height: 6, borderRadius: 'var(--radius)', bgcolor: color, flexShrink: 0 }} />
            <Typography
                sx={{
                    fontFamily: 'var(--font-mono)',
                    fontSize: 10.5,
                    fontWeight: 700,
                    letterSpacing: '0.06em',
                    textTransform: 'uppercase',
                    color,
                }}
            >
                {label}
            </Typography>
        </Box>
    )
}
