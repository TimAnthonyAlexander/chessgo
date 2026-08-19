import { Box, Typography } from '@mui/material'
import type { FlagStatus } from '../../../api/client'
import { STATUS_META } from '../dashboard/labels'

/** A verdict-status pill (open / reviewing / cleared / banned), colour-coded via
 * the shared STATUS_META so it reads identically to the dashboard's review queue. */
export default function StatusChip({ status }: { status: FlagStatus }) {
    const { label, color } = STATUS_META[status] ?? { label: status, color: 'var(--muted)' }
    return (
        <Box
            sx={{
                display: 'inline-flex',
                alignItems: 'center',
                gap: 0.625,
                px: 1,
                py: 0.375,
                borderRadius: 'var(--radius)',
                bgcolor: `color-mix(in srgb, ${color} 14%, transparent)`,
                border: `1px solid color-mix(in srgb, ${color} 38%, transparent)`,
                lineHeight: 1,
            }}
        >
            <Box sx={{ width: 6, height: 6, borderRadius: 'var(--radius)', bgcolor: color, flexShrink: 0 }} />
            <Typography
                sx={{
                    fontSize: 11,
                    fontWeight: 700,
                    letterSpacing: '0.04em',
                    textTransform: 'uppercase',
                    color,
                }}
            >
                {label}
            </Typography>
        </Box>
    )
}
