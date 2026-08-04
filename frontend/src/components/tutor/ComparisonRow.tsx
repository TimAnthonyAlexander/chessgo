import { Box, Typography } from '@mui/material'
import type { TutorComparison } from '../../api/client'
import { fmtValue } from './format'

/** One row in the strengths or weaknesses list. Only `tone="weakness"` may use
 * --danger — strengths use the single site accent, never a second "good"
 * colour, so the page doesn't turn into a red/green scoreboard. */
export default function ComparisonRow({
    c,
    tone,
}: {
    c: TutorComparison
    tone: 'strength' | 'weakness'
}) {
    const valueColor = tone === 'weakness' ? 'var(--danger)' : 'var(--accent)'
    return (
        <Box sx={{ py: 1.1, borderBottom: '1px solid var(--line-soft)' }}>
            <Box sx={{ display: 'flex', justifyContent: 'space-between', gap: 1.5 }}>
                <Typography sx={{ fontSize: 13.5, fontWeight: 600, minWidth: 0 }}>
                    {c.label}
                </Typography>
                <Typography
                    sx={{
                        fontFamily: 'var(--font-mono)',
                        fontSize: 13,
                        fontWeight: 700,
                        color: valueColor,
                        flexShrink: 0,
                        whiteSpace: 'nowrap',
                    }}
                >
                    {fmtValue(c.mine, c.unit)}
                </Typography>
            </Box>
            <Box sx={{ display: 'flex', justifyContent: 'space-between', gap: 1.5, mt: 0.3 }}>
                <Typography sx={{ fontSize: 12, color: 'var(--text-dim)', minWidth: 0 }}>
                    {c.wording} · peer {fmtValue(c.peer, c.unit)}
                </Typography>
                <Typography
                    sx={{
                        fontSize: 11,
                        color: 'var(--muted)',
                        flexShrink: 0,
                        whiteSpace: 'nowrap',
                    }}
                >
                    {c.sample} {c.sample === 1 ? 'game' : 'games'}
                    {c.percentile != null ? ` · ${c.percentile}th pct` : ''}
                </Typography>
            </Box>
        </Box>
    )
}
