import { Box } from '@mui/material'
import { meterMagnitude } from './format'

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
 * `confidence` is the low-sample channel: a bar built on a handful of games is
 * drawn faint so the caveat operates visually, not just in the caption beside
 * it. It ramps with sqrt(sample) rather than snapping at a threshold.
 *
 * THE DOMAIN IS DECLARED, NOT GUESSED, and the bar never silently pins.
 * `grade` is clamped to ±1 by the backend, and on real reports 46% of rows sat
 * exactly at that clamp — every one of them drawn as the same full bar, which
 * is how the largest element on the page came to encode nothing. So the fill
 * comes from `meterMagnitude`: strictly proportional out to the "much
 * better/worse" line, then compressing past it, fed by the unclamped `spread`
 * when the backend sends one. Rows past the line also carry a caret, because
 * "at the edge" and "far beyond the edge" must not be the same picture.
 */
export default function GradeMeter({
    grade,
    spread,
    confidence = 1,
    height = 7,
    label,
}: {
    grade: number
    /** The unclamped ratio behind `grade`, when the backend sent one. Without
     * it the bar can only draw the clamped verdict and rows past the "much"
     * line all render identically — see `meterMagnitude`. */
    spread?: number | null
    /** 0.35–1, from `confidence(sample)`. */
    confidence?: number
    height?: number
    label?: string
}) {
    const m = meterMagnitude(grade, spread)
    const ahead = m >= 0
    const beyond = Math.abs(spread != null && Number.isFinite(spread) ? spread : grade) > 1
    // Half the track is one side of parity; the caret eats the last sliver so
    // an off-the-scale bar never quite reaches the end.
    const pct = Math.abs(m) * (beyond ? 44 : 50)
    const opacity = Math.min(1, Math.max(0.2, confidence))

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
                    opacity,
                    // Square at the baseline, rounded at the data end.
                    ...(ahead
                        ? { left: '50%', ml: '1px', borderRadius: '0 3px 3px 0' }
                        : { right: '50%', mr: '1px', borderRadius: '3px 0 0 3px' }),
                }}
            />
            {beyond && <OverflowCaret ahead={ahead} height={height} opacity={opacity} />}
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

/** The "past the end of the scale" mark: a triangle pointing off the track, in
 * the same accent as the fill so it reads as the bar continuing, not as a
 * second datum. */
function OverflowCaret({
    ahead,
    height,
    opacity,
}: {
    ahead: boolean
    height: number
    opacity: number
}) {
    const size = Math.max(4, Math.round(height * 0.8))
    return (
        <Box
            sx={{
                position: 'absolute',
                top: '50%',
                transform: 'translateY(-50%)',
                width: 0,
                height: 0,
                opacity,
                borderTop: `${size}px solid transparent`,
                borderBottom: `${size}px solid transparent`,
                ...(ahead
                    ? { right: 0, borderLeft: `${size}px solid var(--accent)` }
                    : { left: 0, borderRight: `${size}px solid var(--accent)` }),
            }}
        />
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
    confidence = 1,
    height = 5,
    label,
}: {
    value: number
    max?: number
    /** 0.35–1, from `confidence(sample)`. */
    confidence?: number
    height?: number
    label?: string
}) {
    const pct = Math.max(0, Math.min(100, (value / (max || 1)) * 100))
    const opacity = Math.min(1, Math.max(0.2, confidence))
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
                    opacity,
                    borderRadius: '2px 3px 3px 2px',
                }}
            />
        </Box>
    )
}
