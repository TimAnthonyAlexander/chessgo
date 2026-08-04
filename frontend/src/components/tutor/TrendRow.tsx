import { Box, Typography } from '@mui/material'
import { ArrowDown, ArrowUp } from 'lucide-react'
import type { TutorTrendSeries } from '../../api/client'
import RatingSparkline from '../profile/RatingSparkline'
import { fmtDelta, fmtValue } from './format'

/** One metric's history on the trend page: a small line chart (reusing the
 * same sparkline idiom as the profile ratings panel) plus its net change.
 * Neutral colouring — direction is shown with an arrow, not a red/green
 * verdict, since a single metric drifting isn't a ranked "weakness". */
export default function TrendRow({ series }: { series: TutorTrendSeries }) {
    const values = series.points
        .filter((p): p is typeof p & { value: number } => p.value != null)
        .map((p) => p.value)
    const last = series.points[series.points.length - 1]

    return (
        <Box
            sx={{
                display: 'flex',
                alignItems: 'center',
                gap: 2.5,
                py: 1.5,
                borderBottom: '1px solid var(--line-soft)',
            }}
        >
            <Box sx={{ minWidth: 0, flex: 1 }}>
                <Typography sx={{ fontSize: 13.5, fontWeight: 600 }}>{series.label}</Typography>
                <Box sx={{ display: 'flex', alignItems: 'center', gap: 0.5, mt: 0.4 }}>
                    {series.improved ? (
                        <ArrowUp size={13} style={{ color: 'var(--accent)' }} />
                    ) : (
                        <ArrowDown size={13} style={{ color: 'var(--text-dim)' }} />
                    )}
                    <Typography
                        sx={{
                            fontFamily: 'var(--font-mono)',
                            fontSize: 12.5,
                            color: series.improved ? 'var(--accent)' : 'var(--text-dim)',
                        }}
                    >
                        {fmtDelta(series.delta, series.unit)}
                    </Typography>
                    {last && (
                        <Typography sx={{ fontSize: 11.5, color: 'var(--muted)', ml: 0.5 }}>
                            · now {fmtValue(last.value ?? 0, series.unit)} · {last.sample} games
                        </Typography>
                    )}
                </Box>
            </Box>
            {values.length >= 2 && (
                <RatingSparkline
                    series={values}
                    color={series.improved ? 'var(--accent)' : 'var(--text-dim)'}
                    width={128}
                    height={36}
                />
            )}
        </Box>
    )
}
