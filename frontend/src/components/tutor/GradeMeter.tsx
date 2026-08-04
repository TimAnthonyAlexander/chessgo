import { Box } from '@mui/material'

/**
 * The report's one comparison primitive: a diverging bar on a peer-parity
 * baseline. `grade` is already direction-corrected by the backend ([-1,1],
 * positive is always good however the raw metric runs), so the bar can be read
 * without knowing whether the metric wants to go up or down.
 *
 * POLARITY IS CARRIED BY SIDE, NOT BY HUE, and that is deliberate. Two-hue
 * fills were measured against the site palettes and fail: Brass's accent
 * (#d8a657) sits at OKLab ΔE 11.2 from --danger and 13.6 from --text-dim
 * (floor 15), and Graphite's near-neutral accent is ΔE 4.1 from its own
 * --text-dim. No pair of tokens in this design system is safely tellable apart
 * as two fills across all six palettes, so the fill is a single accent on both
 * sides and the reader uses position — which also survives greyscale, every
 * form of colour blindness, and forced-colors. --danger is never a fill here;
 * it is ink, and only on a ranked weakness.
 *
 * `dim` is the low-sample channel: a bar built on a handful of games is drawn
 * faint so the caveat operates visually, not just in the caption beside it.
 */
export default function GradeMeter({
    grade,
    dim = false,
    height = 7,
    label,
}: {
    grade: number
    dim?: boolean
    height?: number
    label?: string
}) {
    const g = Math.max(-1, Math.min(1, Number.isFinite(grade) ? grade : 0))
    const ahead = g >= 0
    const pct = Math.abs(g) * 50

    return (
        <Box
            role="img"
            aria-label={label}
            sx={{
                position: 'relative',
                height,
                bgcolor: 'var(--surface-2)',
                borderRadius: '2px',
            }}
        >
            <Box
                sx={{
                    position: 'absolute',
                    top: 0,
                    bottom: 0,
                    // Less the 1px surface gap that keeps the bar off the
                    // parity rule, so a full bar lands exactly on the track end.
                    width: `calc(${pct}% - 1px)`,
                    minWidth: 2,
                    bgcolor: 'var(--accent)',
                    opacity: dim ? 0.38 : 1,
                    // Square at the baseline, rounded at the data end.
                    ...(ahead
                        ? { left: '50%', ml: '1px', borderRadius: '0 3px 3px 0' }
                        : { right: '50%', mr: '1px', borderRadius: '3px 0 0 3px' }),
                }}
            />
            {/* The parity rule, drawn last so a full-width bar never hides it. */}
            <Box
                sx={{
                    position: 'absolute',
                    left: '50%',
                    top: -2,
                    bottom: -2,
                    width: '1px',
                    bgcolor: 'var(--text-dim)',
                }}
            />
        </Box>
    )
}

/**
 * A plain left-anchored magnitude bar for values that have NO peer baseline to
 * diverge from — currently only the tactical-theme solve rates, which the
 * backend explicitly marks non-comparable. Having no centre rule is the point:
 * it is how the eye tells "measured against other players" apart from
 * "measured against nothing".
 */
export function MagnitudeBar({
    value,
    max = 100,
    dim = false,
    height = 5,
    label,
}: {
    value: number
    max?: number
    dim?: boolean
    height?: number
    label?: string
}) {
    const pct = Math.max(0, Math.min(100, (value / (max || 1)) * 100))
    return (
        <Box
            role="img"
            aria-label={label}
            sx={{
                position: 'relative',
                height,
                bgcolor: 'var(--surface-2)',
                borderRadius: '2px',
            }}
        >
            <Box
                sx={{
                    position: 'absolute',
                    left: 0,
                    top: 0,
                    bottom: 0,
                    width: `${pct}%`,
                    minWidth: 2,
                    bgcolor: 'var(--accent)',
                    opacity: dim ? 0.38 : 1,
                    borderRadius: '2px 3px 3px 2px',
                }}
            />
        </Box>
    )
}
