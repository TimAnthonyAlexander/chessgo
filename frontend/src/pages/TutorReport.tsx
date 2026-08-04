import { useEffect, useMemo, useState } from 'react'
import { Box, Typography } from '@mui/material'
import { GraduationCap, TrendingUp } from 'lucide-react'
import { Link, useParams } from 'react-router-dom'
import {
    ApiError,
    getTutorReport,
    type TutorCategoryReport,
    type TutorPayload,
    type TutorReportSummary,
} from '../api/client'
import CategoryTabs from '../components/tutor/CategoryTabs'
import CategorySection from '../components/tutor/CategorySection'
import PeerBanner from '../components/tutor/PeerBanner'
import ReadingKey from '../components/tutor/ReadingKey'
import ReportHero, { hasHero } from '../components/tutor/ReportHero'
import ThemeProfileSection from '../components/tutor/ThemeProfileSection'
import TutorReportSkeleton from '../components/tutor/TutorReportSkeleton'
import { fmtDate, fmtGames } from '../components/tutor/format'

/** `/tutor/:id` — one built report: the hero (when there is one), a rail
 * carrying the frame every figure is read against, and the active category's
 * breakdown. Echoes Profile.tsx's sidebar/main split. */
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
                    <ReadyReport
                        id={id}
                        report={report}
                        payload={payload}
                        active={active}
                        onSelect={setActive}
                        activeCategory={activeCategory}
                    />
                )}
            </Box>
        </Box>
    )
}

function ReadyReport({
    id,
    report,
    payload,
    active,
    onSelect,
    activeCategory,
}: {
    id: string
    report: TutorReportSummary
    payload: TutorPayload
    active: string | null
    onSelect: (c: string) => void
    activeCategory: TutorCategoryReport | null
}) {
    // A report with nothing rankable in it renders no hero at all rather than a
    // large empty statement — see ReportHero's note. When the hero collapses,
    // only the eyebrow is left and the content starts most of a screen higher.
    const hero = hasHero(payload)

    return (
        <Box sx={{ display: 'flex', flexDirection: 'column', gap: { xs: 3, md: 4 } }}>
            <Box>
                <Link to="/tutor" style={{ textDecoration: 'none', display: 'inline-flex' }}>
                    <Box
                        sx={{
                            display: 'flex',
                            alignItems: 'center',
                            gap: 1,
                            mb: hero ? 1.5 : 0,
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
                {hero && <ReportHero payload={payload} />}
            </Box>

            <Box
                sx={{
                    display: 'grid',
                    gridTemplateColumns: {
                        xs: '1fr',
                        lg: 'minmax(0, 260px) minmax(0, 1fr)',
                    },
                    columnGap: 5,
                    rowGap: 4,
                    alignItems: 'start',
                }}
            >
                {/* The rail. On mobile it splits in two around the content:
                    picking a category comes first, the key and the provenance
                    come after — `display: contents` hands both halves straight
                    to the page grid so `order` can place them. */}
                <Box
                    sx={{
                        display: { xs: 'contents', lg: 'flex' },
                        flexDirection: 'column',
                        gap: 4,
                    }}
                >
                    <Box sx={{ order: { xs: 1, lg: 0 } }}>
                        <Box sx={{ display: 'flex', flexDirection: 'column', gap: 3 }}>
                            <CategoryTabs payload={payload} active={active} onSelect={onSelect} />
                            {activeCategory && <PeerBanner category={activeCategory} />}
                        </Box>
                    </Box>
                    <Box sx={{ order: { xs: 3, lg: 0 } }}>
                        <Box sx={{ display: 'flex', flexDirection: 'column', gap: 3 }}>
                            {/* The key explains the peer meter. With no peer
                                band there are no meters, so it would be
                                explaining something that isn't on the page. */}
                            {activeCategory && activeCategory.peer.tier !== 'none' && <ReadingKey />}
                            <ReportMeta report={report} />
                        </Box>
                    </Box>
                </Box>

                <Box sx={{ minWidth: 0, order: { xs: 2, lg: 0 } }}>
                    {activeCategory ? (
                        <CategorySection category={activeCategory} reportId={id} />
                    ) : (
                        <Centered>
                            No category had enough games to report on. Play a few more and build
                            another report.
                        </Centered>
                    )}
                </Box>
            </Box>

            {payload.themeProfile && (
                <Box sx={{ pt: 1 }}>
                    <ThemeProfileSection profile={payload.themeProfile} />
                </Box>
            )}
        </Box>
    )
}

/** Where the report came from — moved out of the hero, where it was competing
 * with the headline, into the rail where it belongs as provenance. */
function ReportMeta({ report }: { report: TutorReportSummary }) {
    return (
        <Box>
            <Typography
                sx={{
                    fontFamily: 'var(--font-mono)',
                    fontSize: 11,
                    fontWeight: 600,
                    letterSpacing: '0.16em',
                    textTransform: 'uppercase',
                    color: 'var(--text-dim)',
                    mb: 0.75,
                }}
            >
                This report
            </Typography>
            <Box sx={{ display: 'flex', flexDirection: 'column', gap: 0.25 }}>
                <MetaLine>
                    {fmtDate(report.rangeFrom)} – {fmtDate(report.rangeTo)}
                </MetaLine>
                <MetaLine>
                    {fmtGames(report.gamesUsed)} of {report.gamesConsidered}
                    {report.capHit ? ' (capped)' : ''}
                </MetaLine>
                {report.builtAt && <MetaLine>Built {fmtDate(report.builtAt)}</MetaLine>}
            </Box>
            <Box
                component={Link}
                to="/tutor/trend"
                sx={{
                    display: 'inline-flex',
                    alignItems: 'center',
                    gap: 0.75,
                    mt: 1.25,
                    fontSize: 12.5,
                    fontWeight: 600,
                    color: 'var(--text-dim)',
                    textDecoration: 'none',
                    '&:hover': { color: 'var(--accent)' },
                }}
            >
                <TrendingUp size={14} />
                Compare with earlier reports
            </Box>
        </Box>
    )
}

function MetaLine({ children }: { children: React.ReactNode }) {
    return (
        <Typography
            sx={{
                fontFamily: 'var(--font-mono)',
                fontSize: 11,
                color: 'var(--muted)',
                fontVariantNumeric: 'tabular-nums',
            }}
        >
            {children}
        </Typography>
    )
}

function Centered({ children }: { children: React.ReactNode }) {
    return (
        <Box sx={{ flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center', p: 6 }}>
            <Typography
                sx={{ fontSize: 14, color: 'var(--text-dim)', textAlign: 'center', maxWidth: '40ch' }}
            >
                {children}
            </Typography>
        </Box>
    )
}
