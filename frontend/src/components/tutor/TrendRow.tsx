import { Box, Typography } from '@mui/material'
import { ArrowDown, ArrowUp } from 'lucide-react'
import type { TutorTrendSeries } from '../../api/client'
import RatingSparkline from '../profile/RatingSparkline'
import { fmtDelta, fmtValue } from './format'

/** One metric's history on the trend page: a small line chart (reusing the
 * same sparkline idiom as the profile ratings panel) plus its net change.
 * `series.improved` is already direction-corrected by the backend — for a
 * lower-is-better metric a falling line IS improvement — so it is trusted
 * as-is rather than re-derived from the raw delta's sign here. A metric
 * moving the wrong way over time is exactly the kind of "am I getting worse"
 * question colour exists to answer, so improved inks --good and the reverse
 * inks --bad; the arrow direction still carries the same fact for anyone who
 * can't see the colour. */
export default function TrendRow({ series }: { series: TutorTrendSeries }) {
    const values = series.points
        .filter((p): p is typeof p & { value: number } => p.value != null)
        .map((p) => p.value)
    const last = series.points[series.points.length - 1]
    const ink = series.improved ? 'var(--good)' : 'var(--bad)'

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
                        <ArrowUp size={13} style={{ color: ink }} />
                    ) : (
                        <ArrowDown size={13} style={{ color: ink }} />
                    )}
                    <Typography
                        sx={{
                            fontFamily: 'var(--font-mono)',
                            fontSize: 12.5,
                            fontWeight: 700,
                            color: ink,
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
                {series.mixedTiers && (
                    <Typography sx={{ fontSize: 11, color: 'var(--muted)', mt: 0.3 }}>
                        Reports behind this line were compared against different peer groups — the
                        line still plots your raw measured values, so it's valid across them.
                    </Typography>
                )}
            </Box>
            {values.length >= 2 && (
                <RatingSparkline series={values} color={ink} width={128} height={36} />
            )}
        </Box>
    )
}
