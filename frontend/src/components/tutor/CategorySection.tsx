import { Box, Typography } from '@mui/material'
import type { TutorCategoryReport } from '../../api/client'
import PeerBanner from './PeerBanner'
import ComparisonRow from './ComparisonRow'
import DrillCard from './DrillCard'
import MetricsTable from './MetricsTable'
import BarCompare from './BarCompare'
import { cap } from './format'

/** One category's full breakdown: peer context, strengths/weaknesses (with
 * their drills), every measured metric, then the phase/piece/opening
 * breakdowns. This is the bulk of the report page's main column. */
export default function CategorySection({ category }: { category: TutorCategoryReport }) {
    const noPeer = category.peer.tier === 'none'
    const drillFor = (c: { metric: string; dimension: string }) =>
        category.drills.find((d) => d.metric === c.metric && d.dimension === c.dimension)

    return (
        <Box>
            <PeerBanner category={category} />

            {!noPeer && (category.strengths.length > 0 || category.weaknesses.length > 0) && (
                <Box
                    sx={{
                        display: 'grid',
                        gridTemplateColumns: { xs: '1fr', sm: '1fr 1fr' },
                        gap: { xs: 3, sm: 4 },
                        mb: 3,
                    }}
                >
                    {category.strengths.length > 0 && (
                        <Box>
                            <SectionLabel>Strengths</SectionLabel>
                            {category.strengths.map((c, i) => (
                                <ComparisonRow key={`${c.metric}-${c.dimension}-${i}`} c={c} tone="strength" />
                            ))}
                        </Box>
                    )}
                    {category.weaknesses.length > 0 && (
                        <Box>
                            <SectionLabel>Weaknesses</SectionLabel>
                            {category.weaknesses.map((c, i) => (
                                <ComparisonRow key={`${c.metric}-${c.dimension}-${i}`} c={c} tone="weakness" />
                            ))}
                        </Box>
                    )}
                </Box>
            )}

            {category.weaknesses.length > 0 && (
                <Box sx={{ mb: 3 }}>
                    {category.weaknesses.map((w, i) => {
                        const drill = drillFor(w)
                        return drill ? <DrillCard key={`${w.metric}-${w.dimension}-${i}`} drill={drill} /> : null
                    })}
                </Box>
            )}

            <Box sx={{ mb: 3 }}>
                <SectionLabel>All metrics</SectionLabel>
                <MetricsTable category={category} />
            </Box>

            <BreakdownGroup title="Phases" items={category.phases} noPeer={noPeer} />
            <BreakdownGroup title="Pieces" items={category.pieces} noPeer={noPeer} />
            <BreakdownGroup title="Openings" items={category.openings} noPeer={noPeer} />
        </Box>
    )
}

function BreakdownGroup({
    title,
    items,
    noPeer,
}: {
    title: string
    items: TutorCategoryReport['phases']
    noPeer: boolean
}) {
    if (items.length === 0) return null
    return (
        <Box sx={{ mb: 3 }}>
            <SectionLabel>{title}</SectionLabel>
            {items.map((c, i) => (
                <BarCompare
                    key={`${c.dimension}-${i}`}
                    label={c.name ?? cap(c.dimension)}
                    mine={c.mine}
                    peer={c.peer}
                    sample={c.sample}
                    peerSample={c.peerSample}
                    unit={c.unit}
                    showPeer={!noPeer}
                />
            ))}
        </Box>
    )
}

function SectionLabel({ children }: { children: React.ReactNode }) {
    return (
        <Typography
            sx={{
                fontFamily: 'var(--font-mono)',
                fontSize: 11.5,
                letterSpacing: '0.12em',
                textTransform: 'uppercase',
                color: 'var(--muted)',
                mb: 1,
            }}
        >
            {children}
        </Typography>
    )
}
