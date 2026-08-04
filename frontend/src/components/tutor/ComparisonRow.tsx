import { Box, Typography } from '@mui/material'
import type { TutorComparison } from '../../api/client'
import MeterRow from './MeterRow'
import { Value, Verdict } from './parts'
import { fmtValue } from './format'

/** One ranked finding — a row in the strengths or weaknesses list, and the peer
 * block on the opening drilldown. `tone` is ink only: --danger marks a finding
 * the backend actually ranked as a weakness, never a bar fill and never a
 * blanket "below average" tint. Left unset it follows the (already
 * direction-corrected) grade, so a caller can't accidentally paint a bad
 * result in the accent.
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
                    <Value tone={resolved} size={13}>
                        {fmtValue(c.mine, c.unit)}
                    </Value>
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
            spread={c.spread}
            sample={c.sample}
            higherIsBetter={c.higherIsBetter}
            tone={resolved}
            wording={c.wording}
            peerText={`peer ${fmtValue(c.peer, c.unit)}`}
        />
    )
}
