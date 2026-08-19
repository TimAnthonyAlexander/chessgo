import { Box, Typography } from '@mui/material'
import type { FlagStatus } from '../../../api/client'
import { STATUS_META, STATUS_ORDER } from '../dashboard/labels'

export type StatusFilter = FlagStatus | 'all'

const TABS: { value: StatusFilter; label: string; color: string }[] = [
    { value: 'all', label: 'All', color: 'var(--accent)' },
    ...STATUS_ORDER.map((s) => ({
        value: s as StatusFilter,
        label: STATUS_META[s].label,
        color: STATUS_META[s].color,
    })),
]

/** The queue's verdict-status filter, as a segmented pill row. Drives `?status=`;
 * the "All" tab clears the filter. Each tab carries the status accent so the
 * active open/reviewing/cleared/banned tab reads at a glance. */
export default function FlagStatusTabs({
    value,
    onChange,
}: {
    value: StatusFilter
    onChange: (v: StatusFilter) => void
}) {
    return (
        <Box
            sx={{
                display: 'inline-flex',
                gap: 0.5,
                p: 0.5,
                borderRadius: 'var(--radius)',
                bgcolor: 'var(--surface-2)',
                border: '1px solid var(--line-soft)',
                flexWrap: 'wrap',
            }}
        >
            {TABS.map((tab) => {
                const active = value === tab.value
                return (
                    <Box
                        key={tab.value}
                        component="button"
                        onClick={() => onChange(tab.value)}
                        sx={{
                            appearance: 'none',
                            border: '1px solid',
                            borderColor: active
                                ? `color-mix(in srgb, ${tab.color} 46%, transparent)`
                                : 'transparent',
                            cursor: 'pointer',
                            px: 1.5,
                            py: 0.75,
                            borderRadius: 'var(--radius)',
                            bgcolor: active
                                ? `color-mix(in srgb, ${tab.color} 16%, transparent)`
                                : 'transparent',
                            transition: 'background .12s ease, color .12s ease',
                            '&:hover': { bgcolor: active ? undefined : 'rgba(255,255,255,0.04)' },
                        }}
                    >
                        <Typography
                            sx={{
                                fontSize: 12,
                                fontWeight: 700,
                                letterSpacing: '0.06em',
                                textTransform: 'uppercase',
                                color: active ? tab.color : 'var(--text-dim)',
                            }}
                        >
                            {tab.label}
                        </Typography>
                    </Box>
                )
            })}
        </Box>
    )
}
