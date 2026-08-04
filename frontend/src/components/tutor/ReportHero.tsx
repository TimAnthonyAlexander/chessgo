import { Box, Typography } from '@mui/material'
import type { TutorComparison, TutorPayload } from '../../api/client'
import GradeMeter from './GradeMeter'
import { Caption, DirectionMark, SampleNote } from './parts'
import { cap, fmtValue, isThin, ordinal, relToBand } from './format'

/** The strongest thing the report found, or null if it found nothing rankable.
 * `importance` is grade x sqrt(evidence x level weight), so the largest
 * absolute value is the claim best supported by the data — the same ordering
 * the backend uses to pick its own headline. */
export function topFinding(
    payload: TutorPayload,
): { c: TutorComparison; category: string } | null {
    let best: { c: TutorComparison; category: string } | null = null
    for (const [key, cat] of Object.entries(payload.categories)) {
        if (cat.peer.tier === 'none') continue
        for (const c of [...cat.strengths, ...cat.weaknesses]) {
            if (!best || Math.abs(c.importance) > Math.abs(best.c.importance)) {
                best = { c, category: key }
            }
        }
    }
    return best
}

/** Whether ReportHero would render anything. The caller needs this to collapse
 * the band's spacing too — a hero that returns null but leaves a 40px gap
 * behind it is the same dead space in a cheaper suit. */
export function hasHero(payload: TutorPayload): boolean {
    return payload.headline !== null || topFinding(payload) !== null
}

/** The comparison behind the backend's headline, if it can be found — the
 * headline itself carries no unit or grade, so without this the hero can only
 * print bare numbers. */
export function headlineComparison(payload: TutorPayload): TutorComparison | null {
    const h = payload.headline
    if (!h) return null
    const cat = payload.categories[h.category]
    if (!cat || cat.peer.tier === 'none') return null
    return cat.comparisons.find((c) => c.metric === h.metric && c.dimension === '') ?? null
}

/**
 * The hero. Three states, in order of how much the report actually knows:
 *
 *  1. The backend wrote a headline — print its sentence, in the display face,
 *     over the same meter every other row uses.
 *  2. It didn't, but a ranked finding exists — lead with that finding as a
 *     figure. No sentence is fabricated around it; the backend's own `wording`
 *     is the caption and nothing else is invented.
 *  3. Neither — render nothing at all. The caller collapses the band and the
 *     content starts higher.
 *
 * State 3 is the whole point of this component existing: the page it replaced
 * gave its largest, most expensive element to the words "Not enough data yet
 * for a headline", which is a null state occupying the best real estate on the
 * screen. A missing headline is not a thing to announce at 30px.
 */
export default function ReportHero({ payload }: { payload: TutorPayload }) {
    const h = payload.headline
    const cmp = headlineComparison(payload)

    if (h) {
        return (
            <Box>
                <Typography
                    component="h1"
                    sx={{
                        fontFamily: 'var(--font-display)',
                        fontWeight: 700,
                        fontSize: { xs: 22, md: 30 },
                        lineHeight: 1.15,
                        color: 'var(--text)',
                        maxWidth: '22ch',
                    }}
                >
                    {h.text}
                </Typography>
                <Figure
                    label={cmp ? cmp.label : cap(h.metric)}
                    mineText={cmp ? fmtValue(h.mine, cmp.unit) : fmtPlain(h.mine)}
                    peerText={cmp ? fmtValue(h.peer, cmp.unit) : fmtPlain(h.peer)}
                    grade={cmp ? cmp.grade : null}
                    sample={h.sample}
                    higherIsBetter={cmp?.higherIsBetter}
                    percentile={cmp?.percentile ?? null}
                    context={cap(h.category)}
                />
            </Box>
        )
    }

    const top = topFinding(payload)
    if (!top) return null

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
                Strongest signal
            </Typography>
            <Typography
                component="h1"
                sx={{
                    fontFamily: 'var(--font-display)',
                    fontWeight: 700,
                    fontSize: { xs: 22, md: 30 },
                    lineHeight: 1.15,
                    color: 'var(--text)',
                    maxWidth: '22ch',
                }}
            >
                {top.c.label}
            </Typography>
            <Figure
                label={`${cap(top.category)} · ${relToBand(top.c.wording)}`}
                mineText={fmtValue(top.c.mine, top.c.unit)}
                peerText={fmtValue(top.c.peer, top.c.unit)}
                grade={top.c.grade}
                sample={top.c.sample}
                higherIsBetter={top.c.higherIsBetter}
                percentile={top.c.percentile}
                context={null}
            />
        </Box>
    )
}

function Figure({
    label,
    mineText,
    peerText,
    grade,
    sample,
    higherIsBetter,
    percentile,
    context,
}: {
    label: string
    mineText: string
    peerText: string
    grade: number | null
    sample: number
    higherIsBetter?: boolean
    percentile: number | null
    context: string | null
}) {
    const thin = isThin(sample)
    return (
        <Box
            sx={{
                mt: 2,
                display: 'flex',
                alignItems: 'flex-end',
                flexWrap: 'wrap',
                gap: { xs: 2, sm: 3.5 },
            }}
        >
            <Box>
                <Box sx={{ display: 'flex', alignItems: 'center', gap: 0.75 }}>
                    <Typography
                        sx={{
                            fontFamily: 'var(--font-mono)',
                            fontSize: 10.5,
                            letterSpacing: '0.14em',
                            textTransform: 'uppercase',
                            color: 'var(--muted)',
                        }}
                    >
                        You
                    </Typography>
                    {higherIsBetter != null && <DirectionMark higherIsBetter={higherIsBetter} />}
                </Box>
                <Typography
                    sx={{
                        fontFamily: 'var(--font-display)',
                        fontSize: { xs: 28, md: 34 },
                        fontWeight: 700,
                        lineHeight: 1.05,
                        color: thin ? 'var(--text-dim)' : 'var(--text)',
                    }}
                >
                    {mineText}
                </Typography>
            </Box>

            <Box>
                <Typography
                    sx={{
                        fontFamily: 'var(--font-mono)',
                        fontSize: 10.5,
                        letterSpacing: '0.14em',
                        textTransform: 'uppercase',
                        color: 'var(--muted)',
                    }}
                >
                    Band
                </Typography>
                <Typography
                    sx={{
                        fontFamily: 'var(--font-display)',
                        fontSize: { xs: 22, md: 26 },
                        fontWeight: 700,
                        lineHeight: 1.2,
                        color: 'var(--text-dim)',
                    }}
                >
                    {peerText}
                </Typography>
            </Box>

            <Box sx={{ flex: '1 1 200px', minWidth: 160, pb: 0.5 }}>
                {grade !== null && (
                    <GradeMeter
                        grade={grade}
                        dim={thin}
                        height={8}
                        label={`${label}: ${mineText} against a band figure of ${peerText}`}
                    />
                )}
                <Box sx={{ mt: 0.75 }}>
                    <Caption>
                        {label}
                        {' · '}
                        <SampleNote sample={sample} />
                        {percentile != null ? ` · ${ordinal(percentile)} pct` : ''}
                        {context ? ` · ${context}` : ''}
                    </Caption>
                </Box>
            </Box>
        </Box>
    )
}

// The headline carries no `unit` field, unlike TutorComparison — round to one
// decimal only when it isn't already a whole number, no invented % or cp.
function fmtPlain(v: number): string {
    return Number.isInteger(v) ? String(v) : v.toFixed(1)
}
