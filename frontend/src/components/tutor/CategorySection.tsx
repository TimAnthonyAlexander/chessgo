import { Box, Typography } from '@mui/material'
import type { TutorCategoryReport } from '../../api/client'
import ComparisonRow from './ComparisonRow'
import FindingCard from './FindingCard'
import MetricList from './MetricList'
import OpeningsBlock from './OpeningsBlock'
import { SectionHead } from './parts'
import { SECTION_FINDINGS, SECTION_METRICS } from './sections'

/**
 * One category's breakdown, in three deliberately different shapes so the page
 * reads as three kinds of claim rather than one long export:
 *
 *   1. Findings — weaknesses are the ranked few, each a merged finding+drill
 *      card (the only place --danger ink appears); strengths are a compact
 *      one-line list underneath, context rather than the point of the page.
 *   2. Metrics  — every measured value as a ranked diverging meter list, with
 *      the phase and piece cuts folded inside the metric they belong to.
 *   3. Openings — a dense list of links per colour, because those rows go
 *      somewhere.
 *
 * The peer band that frames all of it lives in the rail, not here.
 *
 * `heroKey` is the (category, metric, dimension) triple `ReportHero` already
 * rendered at full weight — see `heroFinding` in ReportHero.tsx. It's dropped
 * from this section's own strengths/weaknesses so the same figure isn't
 * stated twice in a row. The hero only ever covers one category, so a key
 * from a different category is a no-op here by construction.
 */
export default function CategorySection({
    category,
    reportId,
    heroKey = null,
}: {
    category: TutorCategoryReport
    reportId: string
    heroKey?: { category: string; metric: string; dimension: string } | null
}) {
    const noPeer = category.peer.tier === 'none'
    const drillFor = (c: { metric: string; dimension: string }) =>
        category.drills.find((d) => d.metric === c.metric && d.dimension === c.dimension) ?? null

    const isHeroed = (c: { metric: string; dimension: string }) =>
        heroKey !== null &&
        heroKey.category === category.category &&
        heroKey.metric === c.metric &&
        heroKey.dimension === c.dimension

    const strengths = category.strengths.filter((c) => !isHeroed(c))
    const weaknesses = category.weaknesses.filter((c) => !isHeroed(c))
    const hasFindings = !noPeer && (strengths.length > 0 || weaknesses.length > 0)

    return (
        <Box>
            {hasFindings && (
                <Box sx={{ mb: 4 }}>
                    <SectionHead
                        id={SECTION_FINDINGS}
                        title="What stands out"
                        sub="Ranked by distance from the band and weight of evidence"
                    />
                    {weaknesses.length > 0 && (
                        <Box sx={{ mb: strengths.length > 0 ? 3 : 0 }}>
                            <ColumnLabel>Behind the band</ColumnLabel>
                            {weaknesses.map((c, i) => (
                                <FindingCard
                                    key={`${c.metric}-${c.dimension}-${i}`}
                                    c={c}
                                    drill={drillFor(c)}
                                    gameRows={category.gameRows}
                                />
                            ))}
                        </Box>
                    )}
                    {strengths.length > 0 && (
                        <Box>
                            <ColumnLabel>Ahead of the band</ColumnLabel>
                            {strengths.map((c, i) => (
                                <ComparisonRow
                                    key={`${c.metric}-${c.dimension}-${i}`}
                                    c={c}
                                    tone="strength"
                                    variant="line"
                                />
                            ))}
                        </Box>
                    )}
                </Box>
            )}

            <Box sx={{ mb: 4 }}>
                <SectionHead
                    id={SECTION_METRICS}
                    title="Every metric"
                    sub={
                        noPeer
                            ? 'Your values only — no band to compare against yet'
                            : 'Best to worst · open a row for its phase and piece cuts'
                    }
                />
                <MetricList category={category} />
            </Box>

            <OpeningsBlock
                openings={category.openings}
                noPeer={noPeer}
                reportId={reportId}
                category={category.category}
            />
        </Box>
    )
}

function ColumnLabel({ children }: { children: React.ReactNode }) {
    return (
        <Typography
            sx={{
                fontFamily: 'var(--font-mono)',
                fontSize: 10.5,
                letterSpacing: '0.14em',
                textTransform: 'uppercase',
                color: 'var(--muted)',
                mb: 0.5,
            }}
        >
            {children}
        </Typography>
    )
}
