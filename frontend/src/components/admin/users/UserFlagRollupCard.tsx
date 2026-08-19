import { Box, Typography } from '@mui/material'
import { ArrowRight } from 'lucide-react'
import { Link as RouterLink } from 'react-router-dom'
import type { FlaggedUserRollup, FlagStatus } from '../../../api/client'
import { Panel, PanelHead } from '../../home/Panel'
import { SEVERITY_META } from '../anticheat/shared'
import { CATEGORY_LABELS, STATUS_META } from '../dashboard/labels'
import { fmtDate } from './shared'

/** A SUMMARY of a flagged account: verdict status, top severity, total flags,
 * per-category counts, and first/last seen — with a deep link to the full
 * timeline in the anti-cheat tab (the timeline itself lives there, not here). */
export default function UserFlagRollupCard({ rollup }: { rollup: FlaggedUserRollup }) {
    const status = STATUS_META[rollup.status as FlagStatus] ?? {
        label: rollup.status,
        color: 'var(--muted)',
    }
    const severity = SEVERITY_META[rollup.top_severity] ?? {
        label: rollup.top_severity,
        color: 'var(--muted)',
    }
    const counts = Object.entries(rollup.counts).filter(([, n]) => n > 0)
    const maxCount = Math.max(1, ...counts.map(([, n]) => n))

    return (
        <Panel sx={{ border: '1px solid rgba(202, 74, 74, 0.35)' }}>
            <PanelHead
                title="Anti-cheat rollup"
                sub="Summary — the full event timeline is in the Anti-cheat tab"
                action={
                    <Box
                        component={RouterLink}
                        to={`/admin/anticheat/${encodeURIComponent(rollup.user_id)}`}
                        sx={{
                            display: 'inline-flex',
                            alignItems: 'center',
                            gap: 0.4,
                            fontSize: 12.5,
                            fontWeight: 700,
                            color: 'var(--accent)',
                            textDecoration: 'none',
                            whiteSpace: 'nowrap',
                            '&:hover': { textDecoration: 'underline' },
                        }}
                    >
                        Review <ArrowRight size={14} />
                    </Box>
                }
            />

            <Box
                sx={{
                    display: 'grid',
                    gap: 1.25,
                    gridTemplateColumns: 'repeat(3, 1fr)',
                    mb: 2,
                }}
            >
                <MetricTile label="Total flags" value={String(rollup.total_flags)} />
                <MetricTile label="Status" value={status.label} color={status.color} />
                <MetricTile label="Top severity" value={severity.label} color={severity.color} />
            </Box>

            {counts.length > 0 && (
                <Box sx={{ display: 'flex', flexDirection: 'column', gap: 1 }}>
                    {counts.map(([key, n]) => (
                        <CategoryBar
                            key={key}
                            label={CATEGORY_LABELS[key as keyof typeof CATEGORY_LABELS] ?? key}
                            value={n}
                            max={maxCount}
                        />
                    ))}
                </Box>
            )}

            <Box
                sx={{
                    display: 'flex',
                    justifyContent: 'space-between',
                    gap: 2,
                    mt: 2,
                    pt: 1.5,
                    borderTop: '1px solid var(--line-soft)',
                    flexWrap: 'wrap',
                }}
            >
                <TimeStamp label="First flagged" iso={rollup.first_flagged_at} />
                <TimeStamp label="Last flagged" iso={rollup.last_flagged_at} align="right" />
            </Box>
        </Panel>
    )
}

function MetricTile({ label, value, color }: { label: string; value: string; color?: string }) {
    return (
        <Box
            sx={{
                bgcolor: 'var(--surface-2)',
                border: '1px solid var(--line-soft)',
                borderRadius: 'var(--radius)',
                p: 1.25,
            }}
        >
            <Typography
                sx={{
                    fontFamily: 'var(--font-mono)',
                    fontSize: 9.5,
                    letterSpacing: '0.12em',
                    textTransform: 'uppercase',
                    color: 'var(--muted)',
                }}
            >
                {label}
            </Typography>
            <Typography
                sx={{
                    fontFamily: 'var(--font-mono)',
                    fontSize: 17,
                    fontWeight: 700,
                    mt: 0.5,
                    lineHeight: 1.1,
                    color: color ?? 'var(--text)',
                }}
            >
                {value}
            </Typography>
        </Box>
    )
}

function CategoryBar({ label, value, max }: { label: string; value: number; max: number }) {
    return (
        <Box>
            <Box sx={{ display: 'flex', justifyContent: 'space-between', mb: 0.4 }}>
                <Typography sx={{ fontSize: 12.5, color: 'var(--text-dim)' }}>{label}</Typography>
                <Typography
                    sx={{
                        fontFamily: 'var(--font-mono)',
                        fontSize: 12.5,
                        fontWeight: 700,
                        color: 'var(--text)',
                    }}
                >
                    {value}
                </Typography>
            </Box>
            <Box
                sx={{
                    height: 7,
                    borderRadius: 'var(--radius)',
                    bgcolor: 'var(--surface-2)',
                    overflow: 'hidden',
                }}
            >
                <Box
                    sx={{
                        width: `${(value / max) * 100}%`,
                        height: '100%',
                        bgcolor: '#ca4a4a',
                        borderRadius: 'var(--radius)',
                    }}
                />
            </Box>
        </Box>
    )
}

function TimeStamp({ label, iso, align }: { label: string; iso: string; align?: 'right' }) {
    return (
        <Box sx={{ textAlign: align }}>
            <Typography
                sx={{
                    fontFamily: 'var(--font-mono)',
                    fontSize: 9.5,
                    letterSpacing: '0.12em',
                    textTransform: 'uppercase',
                    color: 'var(--muted)',
                }}
            >
                {label}
            </Typography>
            <Typography sx={{ fontSize: 13, color: 'var(--text-dim)', mt: 0.25 }}>
                {fmtDate(iso)}
            </Typography>
        </Box>
    )
}
