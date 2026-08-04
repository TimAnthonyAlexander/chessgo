import { Box, Typography } from '@mui/material'
import type { TutorCategoryReport } from '../../api/client'
import { fmtValue } from './format'

/** The full metric dump for a category — every row carries its own sample
 * size, since a number without one is an argument, not a fact. Neutral
 * colouring throughout (no red/green here; that's reserved for the ranked
 * strengths/weaknesses list). Scrolls horizontally on narrow screens rather
 * than letting the page itself go sideways. */
export default function MetricsTable({ category }: { category: TutorCategoryReport }) {
    const noPeer = category.peer.tier === 'none'
    const rows = Object.entries(category.metrics).map(([key, m]) => {
        const cmp = category.comparisons.find((c) => c.metric === key && c.dimension === '')
        return { key, m, cmp }
    })

    if (rows.length === 0) return null

    return (
        <Box sx={{ overflowX: 'auto' }}>
            <Box component="table" sx={{ width: '100%', borderCollapse: 'collapse', minWidth: 420 }}>
                <Box component="thead">
                    <Box component="tr">
                        <Th align="left">Metric</Th>
                        <Th>You</Th>
                        {!noPeer && <Th>Peer</Th>}
                        <Th align="right">Sample</Th>
                    </Box>
                </Box>
                <Box component="tbody">
                    {rows.map(({ key, m, cmp }) => (
                        <Box component="tr" key={key}>
                            <Td align="left">{m.label}</Td>
                            <Td>{fmtValue(m.value, m.unit)}</Td>
                            {!noPeer && <Td>{cmp ? fmtValue(cmp.peer, cmp.unit) : '—'}</Td>}
                            <Td align="right">
                                {m.sample}
                                {cmp && !noPeer ? ` · peer ${cmp.peerSample}` : ''}
                            </Td>
                        </Box>
                    ))}
                </Box>
            </Box>
        </Box>
    )
}

function Th({ children, align = 'center' }: { children: React.ReactNode; align?: 'left' | 'right' | 'center' }) {
    return (
        <Box
            component="th"
            sx={{
                textAlign: align,
                fontSize: 11,
                fontFamily: 'var(--font-mono)',
                textTransform: 'uppercase',
                letterSpacing: '0.08em',
                color: 'var(--muted)',
                fontWeight: 600,
                py: 0.75,
                px: 1,
                borderBottom: '1px solid var(--line-soft)',
                whiteSpace: 'nowrap',
            }}
        >
            {children}
        </Box>
    )
}

function Td({ children, align = 'center' }: { children: React.ReactNode; align?: 'left' | 'right' | 'center' }) {
    return (
        <Box
            component="td"
            sx={{
                textAlign: align,
                fontSize: 12.5,
                fontFamily: align === 'left' ? 'inherit' : 'var(--font-mono)',
                color: align === 'left' ? 'var(--text)' : 'var(--text-dim)',
                py: 0.75,
                px: 1,
                borderBottom: '1px solid var(--line-soft)',
                whiteSpace: 'nowrap',
            }}
        >
            <Typography component="span" sx={{ fontSize: 'inherit', fontFamily: 'inherit' }}>
                {children}
            </Typography>
        </Box>
    )
}
