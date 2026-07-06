import { Box } from '@mui/material'

/** Colours for a decisive/drawn result, keyed by the White side's outcome so the
 * cell reads at a glance: green = White won, red = Black won, muted = draw. */
const RESULT_STYLE: Record<string, { label: string; color: string }> = {
    '1-0': { label: '1–0', color: '#5b9e5b' },
    '0-1': { label: '0–1', color: '#ca4a4a' },
    '1/2-1/2': { label: '½–½', color: 'var(--text-dim)' },
}

/** The final score, styled by outcome. Unknown/blank results fall back to a dash
 * in the muted colour so a malformed row never renders empty. */
export default function GameResultCell({ result }: { result: string }) {
    const style = RESULT_STYLE[result] ?? { label: result || '—', color: 'var(--muted)' }
    return (
        <Box
            component="span"
            sx={{
                fontFamily: 'var(--font-mono)',
                fontSize: 13,
                fontWeight: 700,
                color: style.color,
                whiteSpace: 'nowrap',
            }}
        >
            {style.label}
        </Box>
    )
}
