import { Box, Typography } from '@mui/material'
import { ChevronRight } from 'lucide-react'
import { Link } from 'react-router-dom'
import type { TutorComparison } from '../../api/client'
import MeterRow from './MeterRow'
import { SectionHead } from './parts'
import { cap, directionText, fmtValue, ordinal } from './format'

/**
 * The one breakdown that goes somewhere: every row routes into the opening
 * drilldown, so this block is shaped as two columns of links with a chevron
 * rather than as another full-width meter list. Colours are never merged — the
 * same opening is a different problem from each side.
 */
export default function OpeningsBlock({
    openings,
    noPeer,
    reportId,
    category,
}: {
    openings: { w: TutorComparison[]; b: TutorComparison[] }
    noPeer: boolean
    reportId: string
    category: string
}) {
    const all = [...openings.w, ...openings.b]
    if (all.length === 0) return null

    // When every row measures the same thing, say it once in the header instead
    // of repeating it on every row.
    const labels = new Set(all.map((c) => c.label))
    const sharedLabel = labels.size === 1 ? [...labels][0] : undefined
    // With one shared metric the direction belongs in the header, not repeated
    // as an identical arrow on every row.
    const sharedDirection =
        sharedLabel !== undefined ? directionText(all[0].higherIsBetter).toLowerCase() : undefined

    return (
        <Box sx={{ mb: 4 }}>
            <SectionHead
                title="Openings"
                sub={
                    sharedLabel
                        ? `${sharedLabel}, ${sharedDirection} · open a family for its games`
                        : 'Per family, per colour · open one for its games'
                }
            />
            <Box
                sx={{
                    display: 'grid',
                    gridTemplateColumns: { xs: '1fr', sm: 'repeat(2, minmax(0, 1fr))' },
                    columnGap: 4,
                    rowGap: 2,
                }}
            >
                <Column
                    title="As White"
                    items={openings.w}
                    noPeer={noPeer}
                    reportId={reportId}
                    category={category}
                    color="w"
                    showLabel={!sharedLabel}
                />
                <Column
                    title="As Black"
                    items={openings.b}
                    noPeer={noPeer}
                    reportId={reportId}
                    category={category}
                    color="b"
                    showLabel={!sharedLabel}
                />
            </Box>
        </Box>
    )
}

function Column({
    title,
    items,
    noPeer,
    reportId,
    category,
    color,
    showLabel,
}: {
    title: string
    items: TutorComparison[]
    noPeer: boolean
    reportId: string
    category: string
    color: 'w' | 'b'
    showLabel: boolean
}) {
    const sorted = [...items].sort((a, b) => b.grade - a.grade)
    return (
        <Box sx={{ minWidth: 0 }}>
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
                {title}
            </Typography>
            {sorted.length === 0 ? (
                <Typography sx={{ fontSize: 12.5, color: 'var(--muted)', py: 1 }}>
                    No games yet.
                </Typography>
            ) : (
                sorted.map((c, i) => {
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
                                mx: -1,
                                px: 1,
                                borderRadius: '8px',
                                '&:hover': { bgcolor: 'var(--surface-2)' },
                                '&:focus-visible': { outline: '1px solid var(--accent-line)' },
                            }}
                        >
                            <MeterRow
                                density="compact"
                                label={name}
                                valueText={fmtValue(c.mine, c.unit)}
                                grade={noPeer ? null : c.grade}
                                sample={c.sample}
                                // Only when the column mixes metrics; otherwise
                                // the header already carries the direction.
                                higherIsBetter={showLabel ? c.higherIsBetter : undefined}
                                wording={noPeer ? undefined : c.wording}
                                peerText={noPeer ? undefined : `peer ${fmtValue(c.peer, c.unit)}`}
                                percentileText={
                                    !noPeer && c.percentile != null
                                        ? `${ordinal(c.percentile)} pct`
                                        : undefined
                                }
                                note={showLabel ? c.label : undefined}
                                trailing={
                                    <Box sx={{ display: 'inline-flex', color: 'var(--muted)' }}>
                                        <ChevronRight size={15} />
                                    </Box>
                                }
                            />
                        </Box>
                    )
                })
            )}
        </Box>
    )
}
