import { useEffect, useState } from 'react'
import { Box, Typography } from '@mui/material'
import { GraduationCap } from 'lucide-react'
import { Link, useParams } from 'react-router-dom'
import {
    ApiError,
    getTutorReport,
    type TutorPayload,
    type TutorReportSummary,
} from '../api/client'
import CategoryOverview from '../components/tutor/CategoryOverview'
import ReportHero, { hasHero } from '../components/tutor/ReportHero'
import ThemeProfileSection from '../components/tutor/ThemeProfileSection'
import TutorReportSkeleton from '../components/tutor/TutorReportSkeleton'
import { cap, fmtGames } from '../components/tutor/format'

/**
 * `/tutor/:id` — one built report, as an OVERVIEW: the hero (when there is
 * one) naming the single biggest leak, then one block per rating category
 * carrying its own comparisons, each with a "See more" into its detail page.
 * Categories that didn't qualify get one quiet line — never a silent
 * omission — naming how many more games are needed.
 *
 * This replaces the old four-screen wall: a rail (category picker + peer
 * band + a jump nav + a meter legend + provenance), then per category a
 * findings section, an 11-metric table with phase/piece cuts, an openings
 * block and a theme grid. Readers could not find their answer in it. Every
 * meter here is `SegmentMeter` (via `StatRow`), which needs no legend by
 * construction — colour and the count of lit segments say the same thing —
 * so the rail's "how to read this" key has nowhere left to go. Everything
 * that isn't the headline answer now lives one click away, on the category's
 * own page, rather than being scrolled past to reach it.
 */
export default function TutorReport() {
    const { id = '' } = useParams<{ id: string }>()
    const [report, setReport] = useState<TutorReportSummary | null>(null)
    const [payload, setPayload] = useState<TutorPayload | null>(null)
    const [loading, setLoading] = useState(true)
    const [error, setError] = useState<string | null>(null)

    useEffect(() => {
        let cancelled = false
        setLoading(true)
        setError(null)
        getTutorReport(id)
            .then((r) => {
                if (cancelled) return
                setReport(r.report)
                setPayload(r.payload)
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
            <Box sx={{ width: '100%', maxWidth: 900 }}>
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
                    <ReadyReport id={id} report={report} payload={payload} />
                )}
            </Box>
        </Box>
    )
}

function ReadyReport({
    id,
    report,
    payload,
}: {
    id: string
    report: TutorReportSummary
    payload: TutorPayload
}) {
    // A report with nothing rankable in it renders no hero at all rather than
    // a large empty statement — see ReportHero's note. When the hero
    // collapses, only the eyebrow is left and the content starts higher.
    const hero = hasHero(payload)
    const categories = Object.values(payload.categories)
    const insufficient = Object.entries(payload.insufficient)

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

            {categories.length > 0 ? (
                <Box sx={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
                    {categories.map((c) => (
                        <CategoryOverview key={c.category} category={c} reportId={id} />
                    ))}
                </Box>
            ) : (
                <Centered>
                    No category had enough games to report on. Play a few more and build another
                    report.
                </Centered>
            )}

            {insufficient.length > 0 && (
                <Box sx={{ display: 'flex', flexDirection: 'column', gap: 0.5 }}>
                    {insufficient.map(([key, info]) => (
                        <Typography key={key} sx={{ fontSize: 12.5, color: 'var(--muted)' }}>
                            {cap(key)}: {fmtGames(info.games)} — play {info.need} more to report on
                            it.
                        </Typography>
                    ))}
                </Box>
            )}

            {/* Puzzle themes are measured per PLAYER, not per time control — the
                puzzle pool has no clock — so this belongs to the report, not to
                any one category block, and it is the only thing here with no
                peer comparison behind it. It closes the overview rather than
                sitting between two category blocks that are compared. */}
            {payload.themeProfile && (
                <Box sx={{ pt: 1 }}>
                    <ThemeProfileSection profile={payload.themeProfile} />
                </Box>
            )}
        </Box>
    )
}

function Centered({ children }: { children: React.ReactNode }) {
    return (
        <Box
            sx={{ flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center', p: 6 }}
        >
            <Typography
                sx={{
                    fontSize: 14,
                    color: 'var(--text-dim)',
                    textAlign: 'center',
                    maxWidth: '40ch',
                }}
            >
                {children}
            </Typography>
        </Box>
    )
}
