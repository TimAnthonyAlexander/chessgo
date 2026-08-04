import { Box, Typography } from '@mui/material'
import type { TutorCategoryReport } from '../../api/client'
import ComparisonRow from './ComparisonRow'
import DrillCard from './DrillCard'
import MetricList from './MetricList'
import OpeningsBlock from './OpeningsBlock'
import { SectionHead } from './parts'

/**
 * One category's breakdown, in three deliberately different shapes so the page
 * reads as three kinds of claim rather than one long export:
 *
 *   1. Findings — the ranked few, two columns, the only place --danger ink
 *      appears, each answered by its drill card.
 *   2. Metrics  — every measured value as a ranked diverging meter list, with
 *      the phase and piece cuts folded inside the metric they belong to.
 *   3. Openings — two columns of links, because those rows go somewhere.
 *
 * The peer band that frames all of it lives in the rail, not here.
 */
export default function CategorySection({
    category,
    reportId,
}: {
    category: TutorCategoryReport
    reportId: string
}) {
    const noPeer = category.peer.tier === 'none'
    const drillFor = (c: { metric: string; dimension: string }) =>
        category.drills.find((d) => d.metric === c.metric && d.dimension === c.dimension)
    const hasFindings =
        !noPeer && (category.strengths.length > 0 || category.weaknesses.length > 0)

    return (
        <Box>
            {hasFindings && (
                <Box sx={{ mb: 4 }}>
                    <SectionHead
                        title="What stands out"
                        sub="Ranked by distance from the band and weight of evidence"
                    />
                    <Box
                        sx={{
                            display: 'grid',
                            gridTemplateColumns: { xs: '1fr', sm: 'repeat(2, minmax(0, 1fr))' },
                            columnGap: 4,
                            rowGap: 2,
                        }}
                    >
                        {category.strengths.length > 0 && (
                            <Box sx={{ minWidth: 0 }}>
                                <ColumnLabel>Ahead of the band</ColumnLabel>
                                {category.strengths.map((c, i) => (
                                    <ComparisonRow
                                        key={`${c.metric}-${c.dimension}-${i}`}
                                        c={c}
                                        tone="strength"
                                    />
                                ))}
                            </Box>
                        )}
                        {category.weaknesses.length > 0 && (
                            <Box sx={{ minWidth: 0 }}>
                                <ColumnLabel>Behind the band</ColumnLabel>
                                {category.weaknesses.map((c, i) => (
                                    <ComparisonRow
                                        key={`${c.metric}-${c.dimension}-${i}`}
                                        c={c}
                                        tone="weakness"
                                    />
                                ))}
                            </Box>
                        )}
                    </Box>
                </Box>
            )}

            {category.weaknesses.length > 0 && (
                <Box sx={{ mb: 4 }}>
                    {category.weaknesses.map((w, i) => {
                        const drill = drillFor(w)
                        return drill ? (
                            <DrillCard key={`${w.metric}-${w.dimension}-${i}`} drill={drill} />
                        ) : null
                    })}
                </Box>
            )}

            <Box sx={{ mb: 4 }}>
                <SectionHead
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
