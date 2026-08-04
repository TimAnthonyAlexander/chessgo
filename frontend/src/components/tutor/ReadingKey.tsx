import { Box, Typography } from '@mui/material'
import { ArrowDown, ArrowUp } from 'lucide-react'
import GradeMeter from './GradeMeter'
import { THIN_SAMPLE } from './format'

/**
 * The key for the whole report, in the left rail. Every meter on the page is
 * the same primitive, so the reader learns it once here: the rule is the peer
 * band, the side is the verdict, and faintness is thin evidence.
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
                <Example grade={0.62} text="ahead of your rating band" />
                <Example grade={-0.62} text="behind your rating band" />
                <Example grade={0.62} dim text={`under ${THIN_SAMPLE} games — thin evidence`} />
            </Box>

            <Box sx={{ display: 'flex', flexDirection: 'column', gap: 0.5, mt: 1.75 }}>
                <KeyLine icon={<ArrowUp size={12} strokeWidth={2.25} />} text="Higher is better" />
                <KeyLine icon={<ArrowDown size={12} strokeWidth={2.25} />} text="Lower is better" />
            </Box>

            <Typography sx={{ fontSize: 12, color: 'var(--muted)', mt: 1.5, lineHeight: 1.55 }}>
                The upright rule in each bar is the peer band, not zero. Every figure carries the
                number of games behind it.
            </Typography>
        </Box>
    )
}

function Example({ grade, text, dim }: { grade: number; text: string; dim?: boolean }) {
    return (
        <Box sx={{ display: 'flex', alignItems: 'center', gap: 1.25 }}>
            <Box sx={{ width: 56, flexShrink: 0 }}>
                <GradeMeter grade={grade} dim={dim} height={6} />
            </Box>
            <Typography
                sx={{
                    fontFamily: 'var(--font-mono)',
                    fontSize: 11,
                    color: dim ? 'var(--warn)' : 'var(--muted)',
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
            <Typography sx={{ fontFamily: 'var(--font-mono)', fontSize: 11, color: 'var(--muted)' }}>
                {text}
            </Typography>
        </Box>
    )
}
