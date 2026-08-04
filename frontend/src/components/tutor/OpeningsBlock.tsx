import { useState } from 'react'
import { Box, Typography } from '@mui/material'
import { ChevronDown, ChevronRight } from 'lucide-react'
import { Link } from 'react-router-dom'
import type { TutorComparison } from '../../api/client'
import GradeMeter from './GradeMeter'
import { SampleNote, SectionHead } from './parts'
import { cap, confidence, directionText, fmtGap, fmtValue } from './format'
import { SECTION_OPENINGS } from './sections'

/** Families beyond this many, per colour, sit behind a "show all" disclosure —
 * a sorted link list doesn't need a full screen to prove there are ten of them. */
const VISIBLE_CAP = 5

/**
 * The one breakdown that goes somewhere: every row routes into the opening
 * drilldown, so this block is a dense, sorted list of links — one line per
 * family, its value, its distance from the band, and its game count — rather
 * than another full-height meter block. Colours are never merged — the same
 * opening is a different problem from each side.
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
                id={SECTION_OPENINGS}
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
    const [showAll, setShowAll] = useState(false)
    const sorted = [...items].sort((a, b) => b.grade - a.grade)
    const visible = showAll ? sorted : sorted.slice(0, VISIBLE_CAP)
    const hidden = sorted.length - visible.length

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
                <>
                    {visible.map((c, i) => {
                        const name = c.name ?? cap(c.dimension)
                        return (
                            <OpeningRow
                                key={`${c.dimension}-${i}`}
                                name={name}
                                valueText={fmtValue(c.mine, c.unit)}
                                gapText={noPeer ? undefined : fmtGap(c.mine, c.peer, c.unit)}
                                grade={noPeer ? null : c.grade}
                                spread={noPeer ? undefined : c.spread}
                                sample={c.sample}
                                label={showLabel ? c.label : undefined}
                                to={`/tutor/${encodeURIComponent(reportId)}/${encodeURIComponent(category)}/opening/${color}/${encodeURIComponent(name)}`}
                            />
                        )
                    })}
                    {hidden > 0 || showAll ? (
                        <Box
                            role="button"
                            tabIndex={0}
                            aria-expanded={showAll}
                            onClick={() => setShowAll((v) => !v)}
                            onKeyDown={(e) => {
                                if (e.key === 'Enter' || e.key === ' ') {
                                    e.preventDefault()
                                    setShowAll((v) => !v)
                                }
                            }}
                            sx={{
                                display: 'flex',
                                alignItems: 'center',
                                gap: 0.5,
                                py: 0.75,
                                mx: -1,
                                px: 1,
                                borderRadius: '8px',
                                cursor: 'pointer',
                                color: 'var(--muted)',
                                '&:hover': {
                                    bgcolor: 'var(--surface-2)',
                                    color: 'var(--text-dim)',
                                },
                                '&:focus-visible': { outline: '1px solid var(--accent-line)' },
                            }}
                        >
                            <Typography sx={{ fontSize: 12, fontWeight: 600 }}>
                                {showAll ? 'Show fewer' : `Show all ${sorted.length}`}
                            </Typography>
                            <Box
                                sx={{
                                    display: 'inline-flex',
                                    transform: showAll ? 'rotate(180deg)' : 'none',
                                    transition: 'transform 120ms ease',
                                }}
                            >
                                <ChevronDown size={13} />
                            </Box>
                        </Box>
                    ) : null}
                </>
            )}
        </Box>
    )
}

/** One family, one line: name, an inline peer-parity meter, value, gap, and
 * game count, routing into the drilldown. The three-line `MeterRow` block was
 * most of a screen for what is fundamentally a sorted list of links. */
function OpeningRow({
    name,
    valueText,
    gapText,
    grade,
    spread,
    sample,
    label,
    to,
}: {
    name: string
    valueText: string
    gapText?: string
    grade: number | null
    spread?: number
    sample: number
    label?: string
    to: string
}) {
    const conf = confidence(sample)
    return (
        <Box
            component={Link}
            to={to}
            sx={{
                display: 'flex',
                alignItems: 'center',
                gap: 1,
                py: 0.6,
                mx: -1,
                px: 1,
                borderRadius: '8px',
                textDecoration: 'none',
                color: 'inherit',
                '&:hover': { bgcolor: 'var(--surface-2)' },
                '&:focus-visible': { outline: '1px solid var(--accent-line)' },
            }}
        >
            <Typography
                sx={{
                    fontSize: 12.5,
                    fontWeight: 600,
                    color: 'var(--text)',
                    lineHeight: 1.3,
                    flex: 1,
                    minWidth: 0,
                    overflow: 'hidden',
                    textOverflow: 'ellipsis',
                    whiteSpace: 'nowrap',
                }}
            >
                {name}
            </Typography>
            {label && (
                <Typography
                    sx={{
                        fontSize: 10.5,
                        color: 'var(--muted)',
                        flexShrink: 0,
                        whiteSpace: 'nowrap',
                    }}
                >
                    {label}
                </Typography>
            )}
            {grade !== null && (
                <Box sx={{ width: 40, flexShrink: 0 }}>
                    <GradeMeter
                        grade={grade}
                        spread={spread}
                        confidence={conf}
                        height={5}
                        label={`${name}: ${valueText}`}
                    />
                </Box>
            )}
            <Typography
                sx={{
                    fontFamily: 'var(--font-mono)',
                    fontSize: 12,
                    fontWeight: 700,
                    color: 'var(--text)',
                    flexShrink: 0,
                    whiteSpace: 'nowrap',
                    fontVariantNumeric: 'tabular-nums',
                }}
            >
                {valueText}
            </Typography>
            {gapText && (
                <Typography
                    sx={{
                        fontFamily: 'var(--font-mono)',
                        fontSize: 10.5,
                        color: 'var(--muted)',
                        flexShrink: 0,
                        whiteSpace: 'nowrap',
                        fontVariantNumeric: 'tabular-nums',
                    }}
                >
                    {gapText}
                </Typography>
            )}
            <Typography
                sx={{
                    fontFamily: 'var(--font-mono)',
                    fontSize: 10.5,
                    flexShrink: 0,
                    whiteSpace: 'nowrap',
                }}
            >
                <SampleNote sample={sample} />
            </Typography>
            <Box sx={{ display: 'inline-flex', color: 'var(--muted)', flexShrink: 0 }}>
                <ChevronRight size={14} />
            </Box>
        </Box>
    )
}
