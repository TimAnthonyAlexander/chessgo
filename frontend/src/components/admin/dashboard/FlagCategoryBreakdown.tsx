import { Box, Typography } from '@mui/material'
import type { AdminDashboard } from '../../../api/client'
import { Panel, PanelHead } from '../../home/Panel'
import { CATEGORY_LABELS } from './labels'

type Categories = AdminDashboard['anticheat']['events_by_category']

/** A horizontal bar per anti-cheat detection signal, scaled to the busiest one,
 * so an admin sees at a glance which signal is firing most. */
export default function FlagCategoryBreakdown({ data }: { data: Categories }) {
    const keys = Object.keys(CATEGORY_LABELS) as (keyof Categories)[]
    const max = Math.max(1, ...keys.map((k) => data[k]))
    const total = keys.reduce((sum, k) => sum + data[k], 0)

    return (
        <Panel>
            <PanelHead title="Flag signals" sub="Flag events by detection category" />
            {total === 0 ? (
                <Typography sx={{ fontSize: 13, color: 'var(--muted)' }}>
                    No flag events recorded yet.
                </Typography>
            ) : (
                <Box sx={{ display: 'flex', flexDirection: 'column', gap: 1.25 }}>
                    {keys.map((k) => (
                        <CategoryBar key={k} label={CATEGORY_LABELS[k]} value={data[k]} max={max} />
                    ))}
                </Box>
            )}
        </Panel>
    )
}

function CategoryBar({ label, value, max }: { label: string; value: number; max: number }) {
    const pct = (value / max) * 100
    return (
        <Box>
            <Box
                sx={{
                    display: 'flex',
                    justifyContent: 'space-between',
                    alignItems: 'baseline',
                    mb: 0.5,
                }}
            >
                <Typography sx={{ fontSize: 12.5, color: 'var(--text-dim)' }}>{label}</Typography>
                <Typography
                    sx={{
                        fontFamily: 'var(--font-mono)',
                        fontSize: 13,
                        fontWeight: 700,
                        color: value > 0 ? 'var(--text)' : 'var(--muted)',
                    }}
                >
                    {value}
                </Typography>
            </Box>
            <Box
                sx={{
                    height: 8,
                    borderRadius: 'var(--radius)',
                    bgcolor: 'var(--surface-2)',
                    overflow: 'hidden',
                }}
            >
                <Box
                    sx={{
                        width: `${pct}%`,
                        height: '100%',
                        bgcolor: 'var(--accent)',
                        borderRadius: 'var(--radius)',
                        transition: 'width .3s ease',
                    }}
                />
            </Box>
        </Box>
    )
}
