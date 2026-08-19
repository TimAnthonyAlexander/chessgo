import { useEffect, useState } from 'react'
import { Box, CircularProgress, Typography } from '@mui/material'
import { LineChart } from 'lucide-react'
import { ApiError, getTutorTrend, type TutorTrendSeries } from '../api/client'
import TrendRow from '../components/tutor/TrendRow'
import { cap } from '../components/tutor/format'

interface TrendData {
    categories: string[]
    series: Record<string, Record<string, TutorTrendSeries>>
    reports: number
}

/** `/tutor/trend` — how each measured metric has moved across every report
 * you've built, grouped by category with an optional single-category filter. */
export default function TutorTrend() {
    const [data, setData] = useState<TrendData | null>(null)
    const [error, setError] = useState<string | null>(null)
    const [filter, setFilter] = useState<string | null>(null)

    useEffect(() => {
        let cancelled = false
        setData(null)
        setError(null)
        getTutorTrend(filter ?? undefined)
            .then((r) => {
                if (cancelled) return
                setData(r)
            })
            .catch((e) => {
                if (cancelled) return
                setError(e instanceof ApiError ? e.message : 'Could not load the trend.')
            })
        return () => {
            cancelled = true
        }
    }, [filter])

    return (
        <Box sx={{ maxWidth: 900, mx: 'auto', px: { xs: 1.5, md: 3 }, py: { xs: 3, md: 5 }, width: '100%' }}>
            <Box sx={{ mb: 3 }}>
                <Box sx={{ display: 'flex', alignItems: 'center', gap: 1, mb: 1 }}>
                    <Box sx={{ display: 'flex', color: 'var(--accent)' }}>
                        <LineChart size={15} />
                    </Box>
                    <Typography
                        sx={{
                            fontFamily: 'var(--font-mono)',
                            fontSize: 12,
                            letterSpacing: '0.2em',
                            textTransform: 'uppercase',
                            color: 'var(--accent)',
                        }}
                    >
                        Tutor
                    </Typography>
                </Box>
                <Typography
                    sx={{
                        fontFamily: 'var(--font-display)',
                        fontWeight: 700,
                        fontSize: { xs: 26, md: 34 },
                        lineHeight: 1.05,
                    }}
                >
                    Trend
                </Typography>
            </Box>

            {error && !data ? (
                <Box sx={{ py: 8, textAlign: 'center', color: 'var(--text-dim)', fontSize: 14 }}>
                    {error}
                </Box>
            ) : !data ? (
                <Box sx={{ py: 8, display: 'flex', justifyContent: 'center' }}>
                    <CircularProgress size={22} sx={{ color: 'var(--muted)' }} />
                </Box>
            ) : data.reports < 2 ? (
                <Box sx={{ py: 8, textAlign: 'center', color: 'var(--muted)', fontSize: 14 }}>
                    Build at least two reports to see a trend.
                </Box>
            ) : (
                <Box sx={{ display: 'flex', flexDirection: 'column', gap: 3 }}>
                    <Box sx={{ display: 'flex', flexWrap: 'wrap', gap: 0.75 }}>
                        <FilterChip label="All" active={filter === null} onClick={() => setFilter(null)} />
                        {data.categories.map((c) => (
                            <FilterChip
                                key={c}
                                label={cap(c)}
                                active={filter === c}
                                onClick={() => setFilter(c)}
                            />
                        ))}
                    </Box>

                    {Object.entries(data.series).map(([cat, metrics]) => {
                        const entries = Object.entries(metrics)
                        if (entries.length === 0) return null
                        return (
                            <Box key={cat}>
                                <Typography
                                    sx={{
                                        fontFamily: 'var(--font-display)',
                                        fontSize: 17,
                                        fontWeight: 700,
                                        mb: 0.5,
                                    }}
                                >
                                    {cap(cat)}
                                </Typography>
                                {entries.map(([key, series]) => (
                                    <TrendRow key={key} series={series} />
                                ))}
                            </Box>
                        )
                    })}
                </Box>
            )}
        </Box>
    )
}

function FilterChip({
    label,
    active,
    onClick,
}: {
    label: string
    active: boolean
    onClick: () => void
}) {
    return (
        <Box
            onClick={onClick}
            sx={{
                fontSize: 12.5,
                fontWeight: 600,
                px: 1.5,
                py: 0.6,
                borderRadius: 'var(--radius)',
                cursor: 'pointer',
                color: active ? 'var(--on-accent)' : 'var(--text-dim)',
                bgcolor: active ? 'var(--accent)' : 'var(--surface-2)',
                '&:hover': { color: active ? 'var(--on-accent)' : 'var(--accent)' },
            }}
        >
            {label}
        </Box>
    )
}
