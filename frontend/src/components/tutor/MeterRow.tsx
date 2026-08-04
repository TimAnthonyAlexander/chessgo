import type { ReactNode } from 'react'
import { Box, Typography } from '@mui/material'
import GradeMeter from './GradeMeter'
import { Caption, DirectionMark, SampleNote, Value, Verdict } from './parts'
import { confidence, isSaturated, isThin, relToBand } from './format'

/**
 * The report's one row shape: name and direction on the left, the single bright
 * value on the right, a peer-parity meter under both, and one muted mono line
 * of provenance. Findings, metrics, phase/piece splits and openings are all
 * this row at three sizes, so a reader learns to read it exactly once.
 *
 * `grade === null` means there was no peer comparison to make (peer tier
 * 'none', or a metric the backend never compared): the meter is omitted
 * entirely rather than drawn empty, because an empty track claims parity.
 */
export default function MeterRow({
    label,
    valueText,
    grade,
    spread,
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
    /** Unclamped ratio behind `grade`; lets the meter separate saturated rows. */
    spread?: number | null
    sample: number
    higherIsBetter?: boolean
    tone?: 'plain' | 'strength' | 'weakness'
    wording?: string
    /** Signed distance from the band, from `fmtGap` — the figure that actually
     * varies down a column, unlike the peer value. */
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
    const meta = [gapText, peerText].filter(Boolean).join(' · ')

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
                    <Value tone={tone} dim={thin && tone === 'plain'} size={compact ? 13 : 15}>
                        {valueText}
                    </Value>
                    {trailing}
                </Box>
            </Box>

            {grade !== null && (
                <GradeMeter
                    grade={grade}
                    spread={spread}
                    confidence={conf}
                    height={compact ? 5 : 7}
                    label={`${typeof label === 'string' ? label : 'This metric'}: ${valueText}${
                        wording ? `, ${relToBand(wording)}` : ''
                    }${isSaturated(grade) ? ', past the end of the scale' : ''}`}
                />
            )}

            <Box sx={{ mt: 0.6 }}>
                <Caption>
                    {wording && (
                        <>
                            <Verdict wording={wording} tone={tone} />
                            {' · '}
                        </>
                    )}
                    {meta && (
                        <>
                            {meta}
                            {' · '}
                        </>
                    )}
                    <SampleNote sample={sample} />
                </Caption>
                {note && <Caption>{note}</Caption>}
            </Box>
        </Box>
    )
}
