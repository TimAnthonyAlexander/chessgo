import { Box, Typography } from '@mui/material'
import type { TutorComparison } from '../../api/client'
import SegmentMeter, { stepFor, toneFor, TONE_INK } from './SegmentMeter'
import { confidence, fmtValue, isThin, relToBand } from './format'

/**
 * One comparison, one line: what it is, how you stand, your number and theirs.
 *
 * Read in this order — colour first (am I good at this?), then the label, then
 * the two numbers. Exactly two: yours, inked by the verdict, and the band's,
 * muted and labelled "avg". Everything else about the row — the wording, the
 * sample size, what it was measured against — is in the tooltip.
 *
 * The predecessor printed value, peer, signed gap, verdict and sample on every
 * row in near-identical grey, and readers could not find themselves in it.
 */
export default function StatRow({
    c,
    onClick,
}: {
    c: TutorComparison
    onClick?: () => void
}) {
    const step = stepFor(c.grade)
    const tone = toneFor(step)
    const thin = isThin(c.sample)
    const tip = `${c.label}: you ${fmtValue(c.mine, c.unit)}, players at your rating ${fmtValue(
        c.peer,
        c.unit,
    )} — ${relToBand(c.wording)}, from ${c.sample} of your games`

    return (
        <Box
            onClick={onClick}
            sx={{
                display: 'grid',
                // The label column is CAPPED, not `1fr`. Letting it take the
                // slack pushed every meter to the far right of a 900px page
                // with a lane of empty space between a row's name and its own
                // bar, which is exactly the distance at which the eye stops
                // being able to pair them.
                gridTemplateColumns: {
                    xs: '1fr auto',
                    sm: 'minmax(0, 220px) minmax(90px, 1fr) auto',
                },
                alignItems: 'center',
                columnGap: { xs: 1.5, sm: 2.5 },
                rowGap: 0.75,
                py: 1,
                cursor: onClick ? 'pointer' : 'default',
            }}
        >
            <Typography
                sx={{
                    fontSize: 13.5,
                    color: 'var(--text)',
                    minWidth: 0,
                    overflow: 'hidden',
                    textOverflow: 'ellipsis',
                    whiteSpace: 'nowrap',
                }}
            >
                {c.label}
            </Typography>

            {/* On a phone the meter drops to its own full-width line under the
                label rather than shrinking to a stub that can't be read. */}
            <Box
                sx={{
                    gridColumn: { xs: '1 / -1', sm: 'auto' },
                    order: { xs: 1, sm: 0 },
                    width: '100%',
                }}
            >
                <SegmentMeter
                    grade={c.grade}
                    confidence={confidence(c.sample)}
                    title={tip}
                    height={9}
                />
            </Box>

            {/* Both numbers, always, side by side. Hiding the band figure in a
                tooltip is what made the old page unreadable: a lone "28.8%"
                answers nothing, and "you vs them" is the entire question the
                report exists to answer. Two numbers is not clutter; five was. */}
            <Box
                sx={{
                    display: 'flex',
                    alignItems: 'baseline',
                    gap: 0.75,
                    justifySelf: 'end',
                    whiteSpace: 'nowrap',
                }}
            >
                <Typography
                    sx={{
                        fontFamily: 'var(--font-mono)',
                        fontSize: 13,
                        fontWeight: 700,
                        color: TONE_INK[tone],
                        opacity: thin ? 0.65 : 1,
                        fontVariantNumeric: 'tabular-nums',
                    }}
                >
                    {fmtValue(c.mine, c.unit)}
                </Typography>
                <Typography
                    sx={{
                        fontFamily: 'var(--font-mono)',
                        fontSize: 11,
                        color: 'var(--muted)',
                        fontVariantNumeric: 'tabular-nums',
                    }}
                >
                    avg {fmtValue(c.peer, c.unit)}
                </Typography>
            </Box>
        </Box>
    )
}
