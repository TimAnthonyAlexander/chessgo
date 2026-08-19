import { Box } from '@mui/material'

/**
 * A plain left-anchored magnitude bar for values that have NO peer baseline to
 * diverge from — currently the tactical-theme solve rates (`ThemeProfileSection`,
 * which the backend explicitly marks non-comparable). Having no centre rule is
 * the point: it is how the eye tells "measured against other players" apart
 * from "measured against nothing".
 *
 * The fill is --text-dim, not --accent: a page whose other meters all speak
 * red/green would make an accent-filled bar look like a verdict by
 * association even though it never was one, and the accent itself is red in
 * the Claret palette — exactly the colour a broken bar would use. --text-dim
 * reads as "measured, not judged" in every palette.
 *
 * This used to live in `GradeMeter.tsx` alongside the diverging bar
 * `SegmentMeter` replaced. Once that bar had no importers left, this was the
 * only piece of the file still in use, so it moved here on its own.
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
                borderRadius: 'var(--radius)',
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
                    bgcolor: 'var(--text-dim)',
                    opacity,
                    borderRadius: 'var(--radius)',
                }}
            />
        </Box>
    )
}
