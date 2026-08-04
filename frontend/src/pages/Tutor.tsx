import { useCallback, useEffect, useState } from 'react'
import { Box, Button, CircularProgress, MenuItem, Select, Typography } from '@mui/material'
import { GraduationCap, TrendingUp } from 'lucide-react'
import { Link, useNavigate } from 'react-router-dom'
import {
    ApiError,
    getTutorReports,
    requestTutorReport,
    type TutorEligibility,
    type TutorReportSummary,
} from '../api/client'
import { fmtDate } from '../components/tutor/format'

const POLL_MS = 5000
const RANGE_LABELS: Record<string, string> = {
    '1m': '1 month',
    '3m': '3 months',
    '6m': '6 months',
    '12m': '12 months',
}
const FALLBACK_RANGES = ['1m', '3m', '6m', '12m']

interface Shelf {
    reports: TutorReportSummary[]
    eligibility: TutorEligibility
    ranges: string[]
    minGames: number
}

/** `/tutor` — the shelf of built report cards, a range picker to build a new
 * one, and a link to the trend once there's enough history. */
export default function Tutor() {
    const navigate = useNavigate()
    const [data, setData] = useState<Shelf | null>(null)
    const [error, setError] = useState<string | null>(null)
    const [range, setRange] = useState('6m')
    const [building, setBuilding] = useState(false)
    const [buildError, setBuildError] = useState<string | null>(null)

    const load = useCallback(() => {
        return getTutorReports()
            .then((r) => {
                setData(r)
                setError(null)
            })
            .catch((e) => setError(e instanceof ApiError ? e.message : 'Could not load Tutor.'))
    }, [])

    useEffect(() => {
        void load()
    }, [load])

    const hasPending = data?.reports.some(
        (r) => r.status === 'queued' || r.status === 'building',
    )

    useEffect(() => {
        if (!hasPending) return
        const id = window.setInterval(() => {
            if (document.visibilityState === 'visible') void load()
        }, POLL_MS)
        return () => window.clearInterval(id)
    }, [hasPending, load])

    const onBuild = () => {
        setBuilding(true)
        setBuildError(null)
        requestTutorReport(range)
            .then(() => load())
            .catch((e) => setBuildError(e instanceof ApiError ? e.message : 'Could not queue a build.'))
            .finally(() => setBuilding(false))
    }

    const readyCount = data?.reports.filter((r) => r.status === 'ready').length ?? 0
    const ranges = data?.ranges && data.ranges.length > 0 ? data.ranges : FALLBACK_RANGES

    return (
        <Box sx={{ maxWidth: 900, mx: 'auto', px: { xs: 1.5, md: 3 }, py: { xs: 3, md: 5 }, width: '100%' }}>
            <Box
                sx={{
                    display: 'flex',
                    alignItems: 'flex-start',
                    justifyContent: 'space-between',
                    gap: 2,
                    mb: 1,
                }}
            >
                <Box>
                    <Box sx={{ display: 'flex', alignItems: 'center', gap: 1, mb: 1 }}>
                        <Box sx={{ display: 'flex', color: 'var(--accent)' }}>
                            <GraduationCap size={15} />
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
                            Report card
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
                        Tutor
                    </Typography>
                </Box>
                {readyCount >= 2 && (
                    <Box
                        component={Link}
                        to="/tutor/trend"
                        sx={{
                            display: 'flex',
                            alignItems: 'center',
                            gap: 0.5,
                            fontSize: 13,
                            fontWeight: 600,
                            color: 'var(--text-dim)',
                            flexShrink: 0,
                            mt: 0.5,
                            '&:hover': { color: 'var(--accent)' },
                        }}
                    >
                        <TrendingUp size={15} />
                        Trend
                    </Box>
                )}
            </Box>

            {error && !data ? (
                <Box sx={{ py: 8, textAlign: 'center', color: 'var(--text-dim)', fontSize: 14 }}>
                    {error}
                </Box>
            ) : !data ? (
                <Box sx={{ py: 8, display: 'flex', justifyContent: 'center' }}>
                    <CircularProgress size={22} sx={{ color: 'var(--muted)' }} />
                </Box>
            ) : (
                <Box sx={{ mt: 3, display: 'flex', flexDirection: 'column', gap: 3 }}>
                    {data.reports.length === 0 && (
                        <Box sx={{ py: 2 }}>
                            <Typography sx={{ fontSize: 14, color: 'var(--text-dim)', lineHeight: 1.6, maxWidth: 560 }}>
                                Tutor reads your recent games and measures how you actually play — accuracy,
                                time use, phase and piece strength — against players in your own rating band.
                                Build a report to see where you're ahead, where you're behind, and a drill for
                                each weakness it finds.
                            </Typography>
                        </Box>
                    )}

                    <Box sx={{ display: 'flex', alignItems: 'center', gap: 1.5, flexWrap: 'wrap' }}>
                        <Select
                            size="small"
                            value={range}
                            onChange={(e) => setRange(e.target.value)}
                            disabled={building}
                            sx={{
                                fontSize: 13,
                                minWidth: 140,
                                bgcolor: 'var(--surface)',
                                '& .MuiOutlinedInput-notchedOutline': { borderColor: 'var(--line)' },
                            }}
                        >
                            {ranges.map((r) => (
                                <MenuItem key={r} value={r} sx={{ fontSize: 13 }}>
                                    {RANGE_LABELS[r] ?? r}
                                </MenuItem>
                            ))}
                        </Select>
                        <Button
                            variant="contained"
                            disabled={!data.eligibility.canRequest || building}
                            onClick={onBuild}
                            sx={{ textTransform: 'none', fontWeight: 600 }}
                        >
                            {building ? 'Queuing…' : 'Build report'}
                        </Button>
                        {!data.eligibility.canRequest && data.eligibility.reason && (
                            <Typography sx={{ fontSize: 12.5, color: 'var(--text-dim)' }}>
                                {data.eligibility.reason}
                            </Typography>
                        )}
                        {buildError && (
                            <Typography sx={{ fontSize: 12.5, color: 'var(--danger)' }}>{buildError}</Typography>
                        )}
                    </Box>

                    {data.reports.length > 0 && (
                        <Box sx={{ display: 'flex', flexDirection: 'column' }}>
                            {data.reports.map((r) => (
                                <ReportRow key={r.id} report={r} onOpen={() => navigate(`/tutor/${r.id}`)} />
                            ))}
                        </Box>
                    )}
                </Box>
            )}
        </Box>
    )
}

function ReportRow({ report, onOpen }: { report: TutorReportSummary; onOpen: () => void }) {
    const pending = report.status === 'queued' || report.status === 'building'
    const clickable = report.status === 'ready'

    return (
        <Box
            onClick={clickable ? onOpen : undefined}
            sx={{
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'space-between',
                gap: 2,
                py: 1.5,
                borderBottom: '1px solid var(--line-soft)',
                cursor: clickable ? 'pointer' : 'default',
                '&:hover': clickable ? { bgcolor: 'var(--surface-2)' } : undefined,
                borderRadius: '8px',
                px: 1,
            }}
        >
            <Box sx={{ minWidth: 0 }}>
                <Typography sx={{ fontSize: 13.5, fontWeight: 600 }}>
                    {fmtDate(report.rangeFrom)} – {fmtDate(report.rangeTo)}
                </Typography>
                {report.status === 'ready' && report.headline?.text && (
                    <Typography sx={{ fontSize: 12.5, color: 'var(--text-dim)', mt: 0.25 }}>
                        {report.headline.text}
                    </Typography>
                )}
                {report.status === 'failed' && (
                    <Typography sx={{ fontSize: 12.5, color: 'var(--danger)', mt: 0.25 }}>
                        {report.error ?? 'Build failed.'}
                    </Typography>
                )}
                {report.status === 'insufficient' && (
                    <Typography sx={{ fontSize: 12.5, color: 'var(--text-dim)', mt: 0.25 }}>
                        Not enough games in this range ({report.gamesConsidered} found).
                    </Typography>
                )}
                {pending && (
                    <Typography sx={{ fontSize: 12.5, color: 'var(--text-dim)', mt: 0.25 }}>
                        {report.status === 'queued' ? 'Queued…' : 'Building…'}
                    </Typography>
                )}
            </Box>
            <Box sx={{ display: 'flex', alignItems: 'center', gap: 1.5, flexShrink: 0 }}>
                {pending && <CircularProgress size={14} sx={{ color: 'var(--muted)' }} />}
                <Typography
                    sx={{
                        fontFamily: 'var(--font-mono)',
                        fontSize: 11.5,
                        color: 'var(--muted)',
                        whiteSpace: 'nowrap',
                    }}
                >
                    {report.gamesUsed} games
                </Typography>
            </Box>
        </Box>
    )
}
