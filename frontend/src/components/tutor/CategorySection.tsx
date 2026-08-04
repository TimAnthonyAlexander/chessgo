import { Box, Typography } from '@mui/material'
import { Link } from 'react-router-dom'
import type { TutorCategoryReport, TutorComparison } from '../../api/client'
import PeerBanner from './PeerBanner'
import ComparisonRow from './ComparisonRow'
import DrillCard from './DrillCard'
import MetricsTable from './MetricsTable'
import BarCompare from './BarCompare'
import { cap } from './format'

/** One category's full breakdown: peer context, strengths/weaknesses (with
 * their drills), every measured metric, then the phase/piece/opening
 * breakdowns. This is the bulk of the report page's main column. `reportId`
 * is only needed to link each opening row into its drilldown page. */
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
            <OpeningsBreakdown
                openings={category.openings}
                noPeer={noPeer}
                reportId={reportId}
                category={category.category}
            />
        </Box>
    )
}

// Openings are split by colour and never merged back into one list — the same
// opening is a different problem from each side (you choose it as White, you
// answer it as Black). Each row links into the drilldown page rather than
// just plotting a bar, since "click an opening" is the point of this
// breakdown existing at all.
function OpeningsBreakdown({
    openings,
    noPeer,
    reportId,
    category,
}: {
    openings: TutorCategoryReport['openings']
    noPeer: boolean
    reportId: string
    category: string
}) {
    if (openings.w.length === 0 && openings.b.length === 0) return null
    return (
        <Box sx={{ mb: 3 }}>
            <SectionLabel>Openings</SectionLabel>
            <Box
                sx={{
                    display: 'grid',
                    gridTemplateColumns: { xs: '1fr', sm: '1fr 1fr' },
                    gap: { xs: 2.5, sm: 3 },
                }}
            >
                <OpeningsColumn
                    title="As White"
                    items={openings.w}
                    noPeer={noPeer}
                    reportId={reportId}
                    category={category}
                    color="w"
                />
                <OpeningsColumn
                    title="As Black"
                    items={openings.b}
                    noPeer={noPeer}
                    reportId={reportId}
                    category={category}
                    color="b"
                />
            </Box>
        </Box>
    )
}

function OpeningsColumn({
    title,
    items,
    noPeer,
    reportId,
    category,
    color,
}: {
    title: string
    items: TutorComparison[]
    noPeer: boolean
    reportId: string
    category: string
    color: 'w' | 'b'
}) {
    return (
        <Box>
            <Typography sx={{ fontSize: 12, fontWeight: 600, color: 'var(--text-dim)', mb: 1 }}>
                {title}
            </Typography>
            {items.length === 0 ? (
                <Typography sx={{ fontSize: 12.5, color: 'var(--muted)' }}>No games yet.</Typography>
            ) : (
                items.map((c, i) => {
                    const name = c.name ?? cap(c.dimension)
                    return (
                        <Box
                            key={`${c.dimension}-${i}`}
                            component={Link}
                            to={`/tutor/${encodeURIComponent(reportId)}/${encodeURIComponent(category)}/opening/${color}/${encodeURIComponent(name)}`}
                            sx={{
                                display: 'block',
                                textDecoration: 'none',
                                color: 'inherit',
                                borderRadius: '8px',
                                mx: -1,
                                px: 1,
                                '&:hover': { bgcolor: 'var(--surface-2)' },
                            }}
                        >
                            <BarCompare
                                label={name}
                                mine={c.mine}
                                peer={c.peer}
                                sample={c.sample}
                                peerSample={c.peerSample}
                                unit={c.unit}
                                showPeer={!noPeer}
                            />
                        </Box>
                    )
                })
            )}
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
