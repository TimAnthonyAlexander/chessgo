import { Box, Typography } from '@mui/material'
import type { AdminDashboard } from '../../../api/client'
import { Panel, PanelHead } from '../../home/Panel'
import { STATUS_META, STATUS_ORDER } from './labels'

type ByStatus = AdminDashboard['anticheat']['by_status']

/** The flagged-user review pipeline: how many accounts sit at each verdict
 * status. Rendered as color-coded chips so the open/actionable count stands out. */
export default function FlagStatusBreakdown({ data }: { data: ByStatus }) {
    const total = STATUS_ORDER.reduce((sum, s) => sum + data[s], 0)
    return (
        <Panel>
            <PanelHead title="Review queue" sub="Flagged users by verdict status" />
            <Box
                sx={{
                    display: 'grid',
                    gap: 1,
                    gridTemplateColumns: 'repeat(2, 1fr)',
                }}
            >
                {STATUS_ORDER.map((s) => {
                    const { label, color } = STATUS_META[s]
                    return (
                        <Box
                            key={s}
                            sx={{
                                display: 'flex',
                                alignItems: 'center',
                                gap: 1,
                                px: 1.25,
                                py: 1,
                                borderRadius: '10px',
                                bgcolor: 'var(--surface-2)',
                                border: '1px solid var(--line-soft)',
                            }}
                        >
                            <Box
                                sx={{
                                    width: 8,
                                    height: 8,
                                    borderRadius: '50%',
                                    bgcolor: color,
                                    flexShrink: 0,
                                }}
                            />
                            <Typography
                                sx={{ fontSize: 12.5, color: 'var(--text-dim)', flex: 1, minWidth: 0 }}
                            >
                                {label}
                            </Typography>
                            <Typography
                                sx={{
                                    fontFamily: 'var(--font-mono)',
                                    fontSize: 16,
                                    fontWeight: 700,
                                    color: 'var(--text)',
                                }}
                            >
                                {data[s]}
                            </Typography>
                        </Box>
                    )
                })}
            </Box>
            <Typography sx={{ fontSize: 11.5, color: 'var(--muted)', mt: 1.25 }}>
                {total} flagged {total === 1 ? 'account' : 'accounts'} total
            </Typography>
        </Panel>
    )
}
