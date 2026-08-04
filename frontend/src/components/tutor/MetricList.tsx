import { Box, Typography } from '@mui/material'
import type { TutorCategoryReport, TutorComparison } from '../../api/client'
import SegmentMeter, { stepFor, toneFor, TONE_INK } from './SegmentMeter'
import { Caption, SampleNote, Verdict } from './parts'
import { confidence, fmtValue, metricBlurb } from './format'

/**
 * "Skills": every measured metric, one row each — what it means (from
 * `metricBlurb`, the plain-language line that replaced the sidebar legend), a
 * SegmentMeter for the verdict, and both numbers: yours and the band's. This
 * is the reference list a reader comes back to once they've read "What to
 * work on" and want to know what "resourcefulness" actually is.
 *
 * This used to also carry the phase/piece cuts, folded a disclosure level
 * inside each metric, plus a "show all N" fold over the near-parity middle.
 * Both indirections belonged to the overview, where space was scarce; on a
 * dedicated detail page phase and piece are their own sections
 * (`PhaseBreakdown`) and there is room to just show every row.
 */
export default function MetricList({ category }: { category: TutorCategoryReport }) {
    const noPeer = category.peer.tier === 'none'
    const byKey = new Map<string, TutorComparison>()
    for (const c of category.comparisons) {
        if (c.dimension === '') byKey.set(c.metric, c)
    }

    const rows = Object.entries(category.metrics).map(([key, m]) => ({
        key,
        label: m.label,
        unit: m.unit,
        value: m.value,
        sample: m.sample,
        cmp: byKey.get(key) ?? null,
    }))

    // Ranked best to worst when there's a band to rank against; otherwise
    // alphabetical, since grade carries no meaning with nothing to compare to.
    rows.sort((a, b) => {
        const ga = a.cmp && !noPeer ? a.cmp.grade : Number.NEGATIVE_INFINITY
        const gb = b.cmp && !noPeer ? b.cmp.grade : Number.NEGATIVE_INFINITY
        if (ga === gb) return a.label.localeCompare(b.label)
        return gb - ga
    })

    if (rows.length === 0) return null

    return (
        <Box>
            {rows.map((r) => (
                <SkillRow key={r.key} row={r} noPeer={noPeer} />
            ))}
        </Box>
    )
}

function SkillRow({
    row,
    noPeer,
}: {
    row: {
        key: string
        label: string
        unit: 'percent' | 'cp' | 'rating'
        value: number
        sample: number
        cmp: TutorComparison | null
    }
    noPeer: boolean
}) {
    const cmp = noPeer ? null : row.cmp
    const blurb = metricBlurb(row.key)
    const tone = cmp ? toneFor(stepFor(cmp.grade)) : 'neutral'

    return (
        <Box
            sx={{
                py: 1.5,
                borderBottom: '1px solid var(--line-soft)',
                '&:last-of-type': { borderBottom: 0 },
            }}
        >
            <Box
                sx={{
                    display: 'flex',
                    alignItems: 'baseline',
                    justifyContent: 'space-between',
                    gap: 1.5,
                    mb: 0.4,
                }}
            >
                <Typography sx={{ fontSize: 14, fontWeight: 600, color: 'var(--text)' }}>
                    {row.label}
                </Typography>
                <Typography
                    sx={{
                        fontFamily: 'var(--font-mono)',
                        fontSize: 16,
                        fontWeight: 700,
                        color: TONE_INK[tone],
                        fontVariantNumeric: 'tabular-nums',
                        whiteSpace: 'nowrap',
                        flexShrink: 0,
                    }}
                >
                    {fmtValue(row.value, row.unit)}
                </Typography>
            </Box>

            {blurb && (
                <Typography sx={{ fontSize: 12.5, color: 'var(--text-dim)', lineHeight: 1.45, mb: 1 }}>
                    {blurb}
                </Typography>
            )}

            {cmp && (
                <Box sx={{ mb: 0.6 }}>
                    <SegmentMeter grade={cmp.grade} confidence={confidence(cmp.sample)} height={8} />
                </Box>
            )}

            <Caption>
                {cmp && (
                    <>
                        <Verdict wording={cmp.wording} />
                        {' · avg '}
                        {fmtValue(cmp.peer, cmp.unit)}
                        {' · '}
                    </>
                )}
                <SampleNote sample={row.sample} />
            </Caption>
        </Box>
    )
}
