import { Box, Typography } from '@mui/material'
import type { TutorComparison } from '../../api/client'
import MeterRow from './MeterRow'
import { Verdict } from './parts'
import { stepFor, toneFor, TONE_INK } from './SegmentMeter'
import { fmtValue } from './format'

/** One ranked finding — a row in the strengths or weaknesses list, and the peer
 * block on the opening drilldown. The value is always inked by
 * `TONE_INK[toneFor(stepFor(c.grade))]` — the same lookup `SegmentMeter` uses
 * for its lit segments — so a bad result can never render in the accent, and a
 * caller can't accidentally paint over what the grade actually says. `tone` is
 * still accepted so a caller can force the "strength"/"weakness" list a row
 * belongs to (it only affects the `Verdict` wording's ink), but it never
 * overrides the number.
 *
 * `variant="line"` is the compact one-liner strengths use: name, value,
 * verdict, nothing else — no meter, no peer figure, no drill. Strengths are
 * context for the page, not its point, so they don't earn the same weight as
 * a weakness's full finding card. */
export default function ComparisonRow({
    c,
    tone,
    showMeter = true,
    variant = 'row',
}: {
    c: TutorComparison
    tone?: 'strength' | 'weakness' | 'plain'
    showMeter?: boolean
    variant?: 'row' | 'line'
}) {
    const resolved = tone ?? (c.grade < 0 ? 'weakness' : 'strength')
    const ink = TONE_INK[toneFor(stepFor(c.grade))]

    if (variant === 'line') {
        return (
            <Box
                sx={{
                    display: 'flex',
                    alignItems: 'baseline',
                    justifyContent: 'space-between',
                    gap: 1.5,
                    py: 0.6,
                }}
            >
                <Typography
                    sx={{
                        fontSize: 13,
                        color: 'var(--text)',
                        minWidth: 0,
                        overflow: 'hidden',
                        textOverflow: 'ellipsis',
                        whiteSpace: 'nowrap',
                    }}
                >
                    {c.label}
                </Typography>
                <Box sx={{ display: 'flex', alignItems: 'baseline', gap: 1.25, flexShrink: 0 }}>
                    <Typography
                        sx={{
                            fontFamily: 'var(--font-mono)',
                            fontSize: 13,
                            fontWeight: 700,
                            color: ink,
                            fontVariantNumeric: 'tabular-nums',
                            whiteSpace: 'nowrap',
                        }}
                    >
                        {fmtValue(c.mine, c.unit)}
                    </Typography>
                    <Box sx={{ fontSize: 12 }}>
                        <Verdict wording={c.wording} tone={resolved} />
                    </Box>
                </Box>
            </Box>
        )
    }

    return (
        <MeterRow
            label={c.label}
            valueText={fmtValue(c.mine, c.unit)}
            grade={showMeter ? c.grade : null}
            sample={c.sample}
            higherIsBetter={c.higherIsBetter}
            tone={resolved}
            wording={c.wording}
            peerText={`peer ${fmtValue(c.peer, c.unit)}`}
        />
    )
}
