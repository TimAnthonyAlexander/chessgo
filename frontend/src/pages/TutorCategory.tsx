import { useEffect, useState } from 'react'
import { Box, Typography } from '@mui/material'
import { ChevronLeft } from 'lucide-react'
import { Link, useParams } from 'react-router-dom'
import {
    ApiError,
    getTutorReport,
    type TutorCategoryReport,
    type TutorPayload,
    type TutorReportSummary,
} from '../api/client'
import FindingCard from '../components/tutor/FindingCard'
import MetricList from '../components/tutor/MetricList'
import OpeningsBlock from '../components/tutor/OpeningsBlock'
import PhaseBreakdown from '../components/tutor/PhaseBreakdown'
import { SectionHead } from '../components/tutor/parts'
import { cap, fmtGames } from '../components/tutor/format'

/**
 * `/tutor/:id/:category` — the detail behind the overview's "See more". The
 * overview states one short block per category; everything that used to be
 * crammed onto the report page in one screen lives here instead, in reading
 * order: the ranked weaknesses first (the actual answer), then the full
 * skills reference, then the phase/piece/opening cuts.
 */
export default function TutorCategory() {
    const { id = '', category = '' } = useParams<{ id: string; category: string }>()
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

    const cat: TutorCategoryReport | null = payload?.categories[category] ?? null

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
            <Box sx={{ width: '100%', maxWidth: 780 }}>
                <Box
                    component={Link}
                    to={`/tutor/${encodeURIComponent(id)}`}
                    sx={{
                        display: 'inline-flex',
                        alignItems: 'center',
                        gap: 0.5,
                        mb: 2.5,
                        fontSize: 12.5,
                        fontWeight: 600,
                        color: 'var(--text-dim)',
                        textDecoration: 'none',
                        '&:hover': { color: 'var(--accent)' },
                    }}
                >
                    <ChevronLeft size={14} />
                    Back to overview
                </Box>

                {loading ? (
                    <Centered>Loading…</Centered>
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
                ) : !cat ? (
                    <Centered>
                        This report has no {cap(category)} category.{' '}
                        <Box
                            component={Link}
                            to={`/tutor/${encodeURIComponent(id)}`}
                            sx={{ color: 'var(--accent)' }}
                        >
                            Back to the overview
                        </Box>
                        .
                    </Centered>
                ) : (
                    <CategoryDetail reportId={id} category={cat} />
                )}
            </Box>
        </Box>
    )
}

function CategoryDetail({
    reportId,
    category,
}: {
    reportId: string
    category: TutorCategoryReport
}) {
    const noPeer = category.peer.tier === 'none'
    // Older stored reports never carried gameRows — see TutorGameRow's docblock
    // in api/client.ts. FindingCard's evidence link degrades to "no games" for
    // those rather than crashing on an absent field.
    const gameRows = category.gameRows ?? []
    const drillFor = (c: { metric: string; dimension: string }) =>
        category.drills.find((d) => d.metric === c.metric && d.dimension === c.dimension) ?? null

    return (
        <Box>
            <Box sx={{ pb: 2.5, mb: 3.5, borderBottom: '1px solid var(--line-soft)' }}>
                <Typography
                    sx={{
                        fontFamily: 'var(--font-display)',
                        fontWeight: 700,
                        fontSize: { xs: 24, md: 30 },
                        lineHeight: 1.15,
                    }}
                >
                    {cap(category.category)}
                </Typography>
                <Typography sx={{ fontSize: 13, color: 'var(--text-dim)', mt: 0.75 }}>
                    {fmtGames(category.games)}
                    {!noPeer && (
                        <>
                            {' · players rated '}
                            {category.peer.bandFrom}–{category.peer.bandTo}
                            {category.peer.tier === 'widened' ? ' (widened for a bigger sample)' : ''}
                        </>
                    )}
                </Typography>
                {noPeer && (
                    <Typography sx={{ fontSize: 13, color: 'var(--text-dim)', mt: 1, maxWidth: '56ch' }}>
                        There isn&apos;t enough peer data at your rating yet, so everything below is your
                        numbers alone — no comparison bars.
                    </Typography>
                )}
            </Box>

            {category.weaknesses.length > 0 && (
                <Box sx={{ mb: 4 }}>
                    <SectionHead
                        title="What to work on"
                        sub="Ranked by distance from the band and weight of evidence"
                    />
                    {category.weaknesses.map((c, i) => (
                        <FindingCard
                            key={`${c.metric}-${c.dimension}-${i}`}
                            c={c}
                            drill={drillFor(c)}
                            gameRows={gameRows}
                        />
                    ))}
                </Box>
            )}

            <Box sx={{ mb: 4 }}>
                <SectionHead
                    title="Skills"
                    sub={
                        noPeer
                            ? 'Your values only — no band to compare against yet'
                            : 'What each measure means, and how you compare'
                    }
                />
                <MetricList category={category} />
            </Box>

            <PhaseBreakdown title="By phase" items={category.phases} noPeer={noPeer} kind="phase" />
            <PhaseBreakdown title="By piece" items={category.pieces} noPeer={noPeer} kind="piece" />

            <OpeningsBlock
                openings={category.openings}
                noPeer={noPeer}
                reportId={reportId}
                category={category.category}
            />
        </Box>
    )
}

function Centered({ children }: { children: React.ReactNode }) {
    return (
        <Box sx={{ py: 8, textAlign: 'center' }}>
            <Typography sx={{ fontSize: 14, color: 'var(--text-dim)' }}>{children}</Typography>
        </Box>
    )
}
