import type { TutorComparison } from '../../api/client'
import MeterRow from './MeterRow'
import { fmtValue, ordinal } from './format'

/** One ranked finding — a row in the strengths or weaknesses list, and the peer
 * block on the opening drilldown. `tone` is ink only: --danger marks a finding
 * the backend actually ranked as a weakness, never a bar fill and never a
 * blanket "below average" tint. Left unset it follows the (already
 * direction-corrected) grade, so a caller can't accidentally paint a bad
 * result in the accent. */
export default function ComparisonRow({
    c,
    tone,
    showMeter = true,
}: {
    c: TutorComparison
    tone?: 'strength' | 'weakness' | 'plain'
    showMeter?: boolean
}) {
    const resolved = tone ?? (c.grade < 0 ? 'weakness' : 'strength')
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
            percentileText={c.percentile != null ? `${ordinal(c.percentile)} pct` : undefined}
        />
    )
}
