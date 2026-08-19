import { Box, Typography } from '@mui/material'
import type { AdminDashboard } from '../../../api/client'
import { Panel, PanelHead } from '../../home/Panel'

const SCANNED = '#5b9e5b'
const UNSCANNED = 'var(--accent)'

/** The anti-cheat scan backlog: how many persisted games have been analysed vs.
 * still pending a scan, as a proportional bar over a headline coverage percent. */
export default function ScanBacklogCard({ data }: { data: AdminDashboard['games'] }) {
    const { total, scanned, unscanned } = data
    const coverage = total > 0 ? Math.round((scanned / total) * 100) : 0
    const pct = (n: number) => (total > 0 ? (n / total) * 100 : 0)

    return (
        <Panel>
            <PanelHead title="Scan backlog" sub="Anti-cheat analysis coverage" />

            <Box sx={{ display: 'flex', alignItems: 'baseline', gap: 1, mb: 1.5 }}>
                <Typography
                    sx={{
                        fontFamily: 'var(--font-mono)',
                        fontSize: 32,
                        fontWeight: 700,
                        lineHeight: 1,
                        color: 'var(--accent)',
                    }}
                >
                    {coverage}%
                </Typography>
                <Typography sx={{ fontSize: 12.5, color: 'var(--muted)' }}>
                    scanned · {total.toLocaleString()} {total === 1 ? 'game' : 'games'}
                </Typography>
            </Box>

            <Box
                sx={{
                    display: 'flex',
                    height: 10,
                    borderRadius: 'var(--radius)',
                    overflow: 'hidden',
                    bgcolor: 'var(--surface-2)',
                }}
            >
                {total > 0 && (
                    <>
                        <Box sx={{ width: `${pct(scanned)}%`, bgcolor: SCANNED }} />
                        <Box sx={{ width: `${pct(unscanned)}%`, bgcolor: UNSCANNED }} />
                    </>
                )}
            </Box>

            <Box sx={{ display: 'flex', gap: 2, mt: 1.5 }}>
                <Legend color={SCANNED} label="Scanned" value={scanned} />
                <Legend color={UNSCANNED} label="Pending" value={unscanned} />
            </Box>
        </Panel>
    )
}

function Legend({ color, label, value }: { color: string; label: string; value: number }) {
    return (
        <Box sx={{ display: 'flex', alignItems: 'center', gap: 0.75, minWidth: 0 }}>
            <Box sx={{ width: 8, height: 8, borderRadius: 'var(--radius)', bgcolor: color, flexShrink: 0 }} />
            <Typography
                component="span"
                sx={{ fontFamily: 'var(--font-mono)', fontSize: 13, fontWeight: 700 }}
            >
                {value.toLocaleString()}
            </Typography>
            <Typography component="span" sx={{ fontSize: 11.5, color: 'var(--muted)' }}>
                {label}
            </Typography>
        </Box>
    )
}
