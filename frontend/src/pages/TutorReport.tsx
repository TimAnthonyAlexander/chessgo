import { useEffect, useMemo, useState } from 'react'
import { Box, Typography } from '@mui/material'
import { GraduationCap } from 'lucide-react'
import { Link, useParams } from 'react-router-dom'
import {
    ApiError,
    getTutorReport,
    type TutorPayload,
    type TutorReportSummary,
} from '../api/client'
import CategoryTabs from '../components/tutor/CategoryTabs'
import CategorySection from '../components/tutor/CategorySection'
import TutorReportSkeleton from '../components/tutor/TutorReportSkeleton'
import { cap, fmtDate } from '../components/tutor/format'

/** `/tutor/:id` — one built report: the headline, then a category picker and
 * that category's full breakdown. Echoes Profile.tsx's sidebar/main split. */
export default function TutorReport() {
    const { id = '' } = useParams<{ id: string }>()
    const [report, setReport] = useState<TutorReportSummary | null>(null)
    const [payload, setPayload] = useState<TutorPayload | null>(null)
    const [active, setActive] = useState<string | null>(null)
    const [loading, setLoading] = useState(true)
    const [error, setError] = useState<string | null>(null)

    useEffect(() => {
        let cancelled = false
        setLoading(true)
        setError(null)
        setActive(null)
        getTutorReport(id)
            .then((r) => {
                if (cancelled) return
                setReport(r.report)
                setPayload(r.payload)
                const first = Object.keys(r.payload.categories)[0] ?? null
                setActive(first)
                setLoading(false)
            })
            .catch((e) => {
                if (cancelled) return
                setError(
                    e instanceof ApiError && e.status === 404
                        ? 'Report not found.'
                        : (e as Error).message,
                )
                setLoading(false)
            })
        return () => {
            cancelled = true
        }
    }, [id])

    const activeCategory = useMemo(
        () => (payload && active ? (payload.categories[active] ?? null) : null),
        [payload, active],
    )

    return (
        <Box
            sx={{
                flex: 1,
                display: 'flex',
                justifyContent: 'center',
                px: { xs: 1.5, md: 3 },
                py: { xs: 2, md: 3.5 },
            }}
        >
            <Box sx={{ width: '100%', maxWidth: 1120 }}>
                {loading ? (
                    <TutorReportSkeleton />
                ) : error || !report || !payload ? (
                    <Centered>{error ?? 'Report unavailable.'}</Centered>
                ) : report.status !== 'ready' ? (
                    <Centered>
                        {report.status === 'failed'
                            ? (report.error ?? 'This report failed to build.')
                            : report.status === 'insufficient'
                              ? "There weren't enough games in this range to build a report."
                              : 'This report is still building.'}
                    </Centered>
                ) : (
                    <Box sx={{ display: 'flex', flexDirection: 'column', gap: 2.5 }}>
                        <Box sx={{ pb: { xs: 2, md: 2.5 }, borderBottom: '1px solid var(--line-soft)' }}>
                            <Link
                                to="/tutor"
                                style={{ textDecoration: 'none', display: 'inline-flex' }}
                            >
                                <Box
                                    sx={{
                                        display: 'flex',
                                        alignItems: 'center',
                                        gap: 1,
                                        mb: 1.5,
                                        color: 'var(--accent)',
                                    }}
                                >
                                    <GraduationCap size={15} />
                                    <Typography
                                        sx={{
                                            fontFamily: 'var(--font-mono)',
                                            fontSize: 12,
                                            letterSpacing: '0.2em',
                                            textTransform: 'uppercase',
                                        }}
                                    >
                                        Tutor · {report.rangeLabel}
                                    </Typography>
                                </Box>
                            </Link>

                            {payload.headline ? (
                                <>
                                    <Typography
                                        sx={{
                                            fontFamily: 'var(--font-display)',
                                            fontWeight: 700,
                                            fontSize: { xs: 22, md: 30 },
                                            lineHeight: 1.15,
                                        }}
                                    >
                                        {payload.headline.text}
                                    </Typography>
                                    <Box
                                        sx={{
                                            display: 'flex',
                                            flexWrap: 'wrap',
                                            gap: 2,
                                            mt: 1.5,
                                        }}
                                    >
                                        <Stat label="You" value={fmtPlain(payload.headline.mine)} />
                                        <Stat label="Peer" value={fmtPlain(payload.headline.peer)} />
                                        <Typography
                                            sx={{ fontSize: 12.5, color: 'var(--muted)', alignSelf: 'center' }}
                                        >
                                            {payload.headline.sample} games · {cap(payload.headline.category)}
                                        </Typography>
                                    </Box>
                                </>
                            ) : (
                                <Typography
                                    sx={{
                                        fontFamily: 'var(--font-display)',
                                        fontWeight: 700,
                                        fontSize: { xs: 20, md: 26 },
                                    }}
                                >
                                    Not enough data yet for a headline.
                                </Typography>
                            )}

                            <Typography sx={{ fontSize: 12, color: 'var(--muted)', mt: 1.5 }}>
                                {fmtDate(report.rangeFrom)} – {fmtDate(report.rangeTo)} ·{' '}
                                {report.gamesUsed} of {report.gamesConsidered} games
                                {report.capHit ? ' (capped)' : ''}
                                {report.builtAt ? ` · built ${fmtDate(report.builtAt)}` : ''}
                            </Typography>
                        </Box>

                        <Box
                            sx={{
                                display: 'grid',
                                gridTemplateColumns: {
                                    xs: '1fr',
                                    lg: 'minmax(0, 300px) minmax(0, 1fr)',
                                },
                                gap: 2.5,
                            }}
                        >
                            <Box>
                                <CategoryTabs payload={payload} active={active} onSelect={setActive} />
                            </Box>

                            <Box sx={{ minWidth: 0 }}>
                                {activeCategory ? (
                                    <CategorySection category={activeCategory} />
                                ) : (
                                    <Centered>Pick a category to see its breakdown.</Centered>
                                )}
                            </Box>
                        </Box>
                    </Box>
                )}
            </Box>
        </Box>
    )
}

// The headline carries no `unit` field, unlike TutorComparison — round to one
// decimal only when it isn't already a whole number, no invented % or cp.
function fmtPlain(v: number): string {
    return Number.isInteger(v) ? String(v) : v.toFixed(1)
}

function Stat({ label, value }: { label: string; value: string }) {
    return (
        <Box>
            <Typography
                sx={{
                    fontFamily: 'var(--font-mono)',
                    fontSize: 10.5,
                    letterSpacing: '0.1em',
                    textTransform: 'uppercase',
                    color: 'var(--muted)',
                }}
            >
                {label}
            </Typography>
            <Typography
                sx={{
                    fontFamily: 'var(--font-display)',
                    fontSize: 22,
                    fontWeight: 700,
                    lineHeight: 1.1,
                }}
            >
                {value}
            </Typography>
        </Box>
    )
}

function Centered({ children }: { children: React.ReactNode }) {
    return (
        <Box sx={{ flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center', p: 6 }}>
            <Typography sx={{ fontSize: 14, color: 'var(--text-dim)' }}>{children}</Typography>
        </Box>
    )
}
