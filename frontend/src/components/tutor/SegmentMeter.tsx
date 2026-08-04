import { Box } from '@mui/material'

/**
 * The report's one comparison primitive: seven segments, lit left to right,
 * coloured by where you land against players at your rating.
 *
 * This replaced a diverging bar drawn in a single accent, where polarity lived
 * only in which SIDE of a centre line the fill sat on. That was a deliberate
 * choice and it was the wrong one: readers could not tell good from bad without
 * consulting a legend in the sidebar, which is the definition of a failed
 * chart. If a meter needs a key, the meter is the problem.
 *
 * The seven steps are not a new scale — they ARE the backend's seven verdict
 * words (`much worse` … `much better`), so the picture and the sentence can
 * never disagree, and there is exactly one place that decides what "better"
 * means. Colour repeats the same fact a third time.
 *
 * Colour is never the only channel: the number of lit segments carries the
 * verdict on its own, so the meter still reads in greyscale, at any severity of
 * colour blindness, and in forced-colors. That matters here because good/bad is
 * carried by green/red, the pair deuteranopes struggle with most.
 */

export const SEGMENTS = 7

export type VerdictTone = 'bad' | 'mid' | 'neutral' | 'good'

/**
 * Which of the seven steps a grade lands on, 1–7.
 *
 * The cuts are the backend's own wording thresholds (`TutorGrade::WORDING`,
 * 1.0 / 0.4 / 0.2 on the clamped grade), so step 1 is exactly "much worse" and
 * step 7 exactly "much better".
 */
export function stepFor(grade: number): number {
    if (!Number.isFinite(grade)) return 4
    if (grade <= -1) return 1
    if (grade <= -0.4) return 2
    if (grade <= -0.2) return 3
    if (grade < 0.2) return 4
    if (grade < 0.4) return 5
    if (grade < 1) return 6
    return 7
}

/** The ink for a step. 4 is "similar" — neither good nor bad, so it is neutral
 * rather than a washed-out green, which would read as a weak pass. */
export function toneFor(step: number): VerdictTone {
    if (step <= 2) return 'bad'
    if (step === 3) return 'mid'
    if (step === 4) return 'neutral'
    return 'good'
}

export const TONE_INK: Record<VerdictTone, string> = {
    bad: 'var(--bad)',
    mid: 'var(--warn)',
    neutral: 'var(--text-dim)',
    good: 'var(--good)',
}

export const TONE_SOFT: Record<VerdictTone, string> = {
    bad: 'var(--bad-soft)',
    mid: 'var(--warn-soft)',
    neutral: 'var(--surface-2)',
    good: 'var(--good-soft)',
}

export default function SegmentMeter({
    grade,
    confidence = 1,
    height = 10,
    width,
    title,
}: {
    /** Direction-corrected, [-1, 1]: positive is always good. */
    grade: number
    /** 0.35–1, from `confidence(sample)` — thin evidence is drawn faint. */
    confidence?: number
    height?: number
    /** Fixed track width; omit to fill the container. */
    width?: number | string
    /** Native tooltip carrying the exact figures. */
    title?: string
}) {
    const step = stepFor(grade)
    const tone = toneFor(step)
    const ink = TONE_INK[tone]
    const opacity = Math.min(1, Math.max(0.35, confidence))

    return (
        <Box
            title={title}
            role="img"
            aria-label={title}
            sx={{
                display: 'flex',
                gap: '2px',
                width: width ?? '100%',
                flexShrink: 0,
                alignItems: 'stretch',
            }}
        >
            {Array.from({ length: SEGMENTS }, (_, i) => {
                const lit = i < step
                return (
                    <Box
                        key={i}
                        sx={{
                            flex: 1,
                            minWidth: 3,
                            height,
                            borderRadius: '1.5px',
                            bgcolor: lit ? ink : 'var(--surface-2)',
                            opacity: lit ? opacity : 1,
                        }}
                    />
                )
            })}
        </Box>
    )
}
