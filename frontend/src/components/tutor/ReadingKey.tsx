import { Box, Typography } from '@mui/material'
import { ArrowDown, ArrowUp } from 'lucide-react'
import GradeMeter from './GradeMeter'
import { THIN_SAMPLE } from './format'

/**
 * The key for the whole report, in the left rail. Every meter on the page is
 * the same primitive, so the reader learns it once here: the rule down the
 * middle is the peer band, the side you land on is the verdict, a full bar
 * means a clearly large gap for that metric (not a percentage of anything),
 * and a triangle at the edge means the real gap didn't fit on the bar.
 *
 * This is the honest place for it. Without it a diverging bar is a shape the
 * reader has to reverse-engineer, and the arrows on each row are decoration.
 */
export default function ReadingKey() {
    return (
        <Box>
            <Typography
                sx={{
                    fontFamily: 'var(--font-mono)',
                    fontSize: 11,
                    fontWeight: 600,
                    letterSpacing: '0.16em',
                    textTransform: 'uppercase',
                    color: 'var(--text-dim)',
                    mb: 1.25,
                }}
            >
                How to read this
            </Typography>

            <Box sx={{ display: 'flex', flexDirection: 'column', gap: 1 }}>
                <Example grade={0.55} text="ahead of your rating band" />
                <Example grade={-0.55} text="behind your rating band" />
                {/* Needs a spread past 1 to actually draw the caret it is
                    describing — the clamped grade alone stops at the "much"
                    line and would render a plain bar here. */}
                <Example grade={1} spread={2.4} text="further than the bar can draw" />
                <Example
                    grade={0.55}
                    confidence={0.35}
                    text={`under ${THIN_SAMPLE} games — drawn faint`}
                />
            </Box>

            <Box sx={{ display: 'flex', flexDirection: 'column', gap: 0.5, mt: 1.75 }}>
                <KeyLine icon={<ArrowUp size={12} strokeWidth={2.25} />} text="Higher is better" />
                <KeyLine icon={<ArrowDown size={12} strokeWidth={2.25} />} text="Lower is better" />
            </Box>

            {/* The examples above already ARE the explanation. All that is left
                to say is the one thing a picture of a bar cannot: what the line
                down the middle stands for. */}
            <Typography sx={{ fontSize: 12, color: 'var(--muted)', mt: 1.5, lineHeight: 1.55 }}>
                The line down the middle is your rating band, not zero.
            </Typography>
        </Box>
    )
}

function Example({
    grade,
    text,
    spread,
    confidence = 1,
}: {
    grade: number
    text: string
    spread?: number
    confidence?: number
}) {
    const faint = confidence < 1
    return (
        <Box sx={{ display: 'flex', alignItems: 'center', gap: 1.25 }}>
            <Box sx={{ width: 56, flexShrink: 0 }}>
                <GradeMeter grade={grade} spread={spread} confidence={confidence} height={6} />
            </Box>
            <Typography
                sx={{
                    fontFamily: 'var(--font-mono)',
                    fontSize: 11,
                    color: faint ? 'var(--warn)' : 'var(--muted)',
                    minWidth: 0,
                }}
            >
                {text}
            </Typography>
        </Box>
    )
}

function KeyLine({ icon, text }: { icon: React.ReactNode; text: string }) {
    return (
        <Box sx={{ display: 'flex', alignItems: 'center', gap: 1.25 }}>
            <Box sx={{ width: 56, flexShrink: 0, display: 'flex', color: 'var(--text-dim)' }}>
                {icon}
            </Box>
            <Typography
                sx={{ fontFamily: 'var(--font-mono)', fontSize: 11, color: 'var(--muted)' }}
            >
                {text}
            </Typography>
        </Box>
    )
}
