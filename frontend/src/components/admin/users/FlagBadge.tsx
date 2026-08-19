import { Box } from '@mui/material'
import { AlertTriangle } from 'lucide-react'
import { Link as RouterLink } from 'react-router-dom'
import type { FlagStatus } from '../../../api/client'
import { STATUS_META } from '../dashboard/labels'

/** A warning badge for a flagged account: the flag count + verdict status, itself
 * a deep link into the anti-cheat per-user review page. The status color comes
 * from the shared STATUS_META so both admin tabs speak the same visual language. */
export default function FlagBadge({
    userId,
    totalFlags,
    status,
    onClick,
}: {
    userId: string
    totalFlags: number
    status: string | null
    onClick?: (e: React.MouseEvent) => void
}) {
    const meta = status && status in STATUS_META ? STATUS_META[status as FlagStatus] : null
    const color = meta?.color ?? '#ca4a4a'
    return (
        <Box
            component={RouterLink}
            to={`/admin/anticheat/${encodeURIComponent(userId)}`}
            onClick={onClick}
            title={`${totalFlags} flag event${totalFlags === 1 ? '' : 's'}${meta ? ` · ${meta.label}` : ''}`}
            sx={{
                display: 'inline-flex',
                alignItems: 'center',
                gap: 0.5,
                px: 0.9,
                py: 0.3,
                borderRadius: 'var(--radius)',
                textDecoration: 'none',
                fontFamily: 'var(--font-mono)',
                fontSize: 11,
                fontWeight: 700,
                lineHeight: 1.3,
                color,
                bgcolor: 'color-mix(in srgb, currentColor 12%, transparent)',
                border: `1px solid color-mix(in srgb, ${color} 45%, transparent)`,
                transition: 'background .12s ease, border-color .12s ease',
                '&:hover': { bgcolor: 'color-mix(in srgb, currentColor 20%, transparent)' },
            }}
        >
            <AlertTriangle size={12} />
            {totalFlags}
            {meta && (
                <Box
                    component="span"
                    sx={{
                        fontSize: 9.5,
                        fontWeight: 700,
                        letterSpacing: '0.06em',
                        textTransform: 'uppercase',
                        opacity: 0.85,
                    }}
                >
                    {meta.label}
                </Box>
            )}
        </Box>
    )
}
