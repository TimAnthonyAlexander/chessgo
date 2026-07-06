import { Box, Tooltip, Typography } from '@mui/material'
import { Panel, PanelHead } from '../../home/Panel'
import { fmtMs } from './shared'

const WHITE_BAR = '#c9cdd6'
const BLACK_BAR = '#6c8fb0'

/** Per-move think-time bar chart (ms), one bar per ply, coloured by side to move.
 * A flat, uniform profile (low coefficient of variation) is the "robotic" pattern
 * `move_time_anomaly` fires on — this makes it visible. The chart also prints the
 * per-side CV so the eye and the number agree. */
export default function MoveTimeChart({ moveTimes }: { moveTimes: number[] }) {
    const has = moveTimes.length > 0
    const max = has ? Math.max(...moveTimes, 1) : 1

    const whiteTimes = moveTimes.filter((_, i) => i % 2 === 0)
    const blackTimes = moveTimes.filter((_, i) => i % 2 === 1)

    return (
        <Panel>
            <PanelHead
                title="Move times"
                sub="Think time per ply — a flat, uniform profile is the robotic tell"
                action={
                    has ? (
                        <Box sx={{ display: 'flex', gap: 1.5 }}>
                            <CvBadge label="White CV" color={WHITE_BAR} times={whiteTimes} />
                            <CvBadge label="Black CV" color={BLACK_BAR} times={blackTimes} />
                        </Box>
                    ) : undefined
                }
            />

            {!has ? (
                <Typography sx={{ fontSize: 13, color: 'var(--muted)' }}>
                    Timing not captured for this game.
                </Typography>
            ) : (
                <Box
                    sx={{
                        display: 'flex',
                        alignItems: 'flex-end',
                        gap: '2px',
                        height: 128,
                        overflowX: 'auto',
                        pb: 0.5,
                    }}
                >
                    {moveTimes.map((ms, i) => {
                        const white = i % 2 === 0
                        const moveNo = Math.floor(i / 2) + 1
                        const h = Math.max(2, (ms / max) * 100)
                        return (
                            <Tooltip
                                key={i}
                                arrow
                                title={`${moveNo}${white ? '.' : '…'} — ${fmtMs(ms)}`}
                            >
                                <Box
                                    sx={{
                                        flex: '1 0 4px',
                                        minWidth: 4,
                                        height: `${h}%`,
                                        borderRadius: '2px 2px 0 0',
                                        bgcolor: white ? WHITE_BAR : BLACK_BAR,
                                        opacity: 0.85,
                                        transition: 'opacity .1s ease',
                                        '&:hover': { opacity: 1 },
                                    }}
                                />
                            </Tooltip>
                        )
                    })}
                </Box>
            )}
        </Panel>
    )
}

/** Coefficient of variation (σ/μ) for one side's think times — the robotic metric. */
function cv(times: number[]): number | null {
    if (times.length < 2) return null
    const mean = times.reduce((a, b) => a + b, 0) / times.length
    if (mean === 0) return null
    const variance = times.reduce((a, b) => a + (b - mean) ** 2, 0) / times.length
    return Math.sqrt(variance) / mean
}

function CvBadge({ label, color, times }: { label: string; color: string; times: number[] }) {
    const v = cv(times)
    const robotic = v != null && v < 0.3
    return (
        <Box sx={{ display: 'flex', alignItems: 'center', gap: 0.5 }}>
            <Box sx={{ width: 8, height: 8, borderRadius: '2px', bgcolor: color, flexShrink: 0 }} />
            <Typography sx={{ fontSize: 10.5, color: 'var(--muted)' }}>{label}</Typography>
            <Typography
                sx={{
                    fontFamily: 'var(--font-mono)',
                    fontSize: 12,
                    fontWeight: 700,
                    color: robotic ? '#ca4a4a' : 'var(--text)',
                }}
            >
                {v == null ? '—' : v.toFixed(3)}
            </Typography>
        </Box>
    )
}
