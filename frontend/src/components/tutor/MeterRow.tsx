import type { ReactNode } from 'react'
import { Box, Typography } from '@mui/material'
import SegmentMeter, { stepFor, toneFor, TONE_INK } from './SegmentMeter'
import { Caption, DirectionMark, Verdict } from './parts'
import { confidence, fmtGames, isThin } from './format'

/**
 * The report's detail-page row shape: name and direction on the left, the
 * single bright value on the right, a `SegmentMeter` underneath, and one
 * caption line carrying the wording. Findings, metrics, and phase/piece
 * splits are all this row at two densities, so a reader learns it once.
 *
 * The value is inked by `TONE_INK[toneFor(stepFor(grade))]` — the exact same
 * lookup that colours the meter's lit segments — so the number and the bar
 * can never disagree. The wording stays visible next to it: colour repeats
 * the verdict, it never carries it alone.
 *
 * The exact peer figure, gap, and sample size are folded into the meter's
 * tooltip rather than printed on the row, matching `StatRow` — a row that
 * spells out label, peer value, gap AND sample every time is the wall of
 * numbers this replaced.
 *
 * `grade === null` means there was no peer comparison to make (peer tier
 * 'none', or a metric the backend never compared): the meter is omitted
 * entirely rather than drawn empty, because an empty track claims parity.
 */
export default function MeterRow({
    label,
    valueText,
    grade,
    sample,
    higherIsBetter,
    tone = 'plain',
    wording,
    gapText,
    peerText,
    density = 'default',
    trailing,
    note,
}: {
    label: ReactNode
    valueText: string
    grade: number | null
    sample: number
    higherIsBetter?: boolean
    tone?: 'plain' | 'strength' | 'weakness'
    wording?: string
    /** Folded into the meter's tooltip only — never printed on the row. */
    gapText?: string
    peerText?: string
    density?: 'default' | 'compact'
    /** Chevron, external-link mark — anything that says this row goes somewhere. */
    trailing?: ReactNode
    /** Extra muted line under the caption (e.g. the metric a split belongs to). */
    note?: string
}) {
    const compact = density === 'compact'
    const thin = isThin(sample)
    const conf = confidence(sample)
    const step = grade !== null ? stepFor(grade) : null
    const ink = step !== null ? TONE_INK[toneFor(step)] : null
    const tip = [
        `${typeof label === 'string' ? label : 'This metric'}: you ${valueText}`,
        peerText,
        gapText,
        wording,
        fmtGames(sample),
    ]
        .filter(Boolean)
        .join(' · ')

    return (
        <Box sx={{ py: compact ? 0.9 : 1.25, minWidth: 0 }}>
            <Box
                sx={{
                    display: 'flex',
                    alignItems: 'baseline',
                    justifyContent: 'space-between',
                    gap: 1.25,
                    mb: 0.75,
                }}
            >
                <Box sx={{ display: 'flex', alignItems: 'center', gap: 0.75, minWidth: 0 }}>
                    <Typography
                        sx={{
                            fontSize: compact ? 12.5 : 13.5,
                            fontWeight: 600,
                            color: 'var(--text)',
                            lineHeight: 1.3,
                            minWidth: 0,
                            overflow: 'hidden',
                            textOverflow: 'ellipsis',
                            whiteSpace: 'nowrap',
                        }}
                    >
                        {label}
                    </Typography>
                    {higherIsBetter != null && <DirectionMark higherIsBetter={higherIsBetter} />}
                </Box>
                <Box sx={{ display: 'flex', alignItems: 'center', gap: 0.75, flexShrink: 0 }}>
                    <Typography
                        sx={{
                            fontFamily: 'var(--font-mono)',
                            fontSize: compact ? 13 : 15,
                            fontWeight: 700,
                            color: ink ?? (thin ? 'var(--text-dim)' : 'var(--text)'),
                            opacity: ink && thin ? 0.65 : 1,
                            fontVariantNumeric: 'tabular-nums',
                            whiteSpace: 'nowrap',
                        }}
                    >
                        {valueText}
                    </Typography>
                    {trailing}
                </Box>
            </Box>

            {grade !== null && (
                <SegmentMeter
                    grade={grade}
                    confidence={conf}
                    title={tip}
                    height={compact ? 5 : 7}
                />
            )}

            {(wording || note) && (
                <Box sx={{ mt: 0.6 }}>
                    {wording && (
                        <Caption>
                            <Verdict wording={wording} tone={tone} />
                        </Caption>
                    )}
                    {note && <Caption>{note}</Caption>}
                </Box>
            )}
        </Box>
    )
}
