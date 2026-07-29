import { useMemo, useState } from 'react'
import { Box, Tooltip, Typography } from '@mui/material'
import { pvToSan } from '../lib/analysisTree'
import { MoveSan } from './MoveSan'
import type { AnalysisLine } from '../api/client'
import type { WhiteEval } from './EvalBar'

const LS_KEY = 'chessgo.analysis.multipvLines'
const DEFAULT_LINES = 3

function loadLineCount(): number {
    try { const v = parseInt(localStorage.getItem(LS_KEY) ?? '', 10); if (v >= 1 && v <= 5) return v } catch { /* ignore */ }
    return DEFAULT_LINES
}
function saveLineCount(n: number): void {
    try { localStorage.setItem(LS_KEY, String(n)) } catch { /* ignore */ }
}
function evalText(type: 'cp' | 'mate', white: number): string {
    if (type === 'mate') return `${white < 0 ? '-' : ''}M${Math.abs(white)}`
    return (white > 0 ? '+' : '') + (white / 100).toFixed(2)
}
function Toggle({ on, onChange }: { on: boolean; onChange: () => void }) {
    return (
        <Box component="button" onClick={onChange} aria-label="Toggle engine"
            sx={{ position:'relative', width:34, height:20, borderRadius:10, border:'none', cursor:'pointer',
                  bgcolor: on ? 'var(--accent)' : 'var(--surface-2)', transition:'background-color .2s', p:0 }}>
            <Box sx={{ position:'absolute', top:2, left: on ? 16 : 2, width:16, height:16,
                       borderRadius:'50%', bgcolor:'var(--text)', transition:'left .2s' }} />
        </Box>
    )
}

export default function EngineLines({
    engineOn, onToggleEngine, onPlayLine, onHoverMove, lines, fen, isDuck, mainSan,
}: {
    engineOn: boolean; onToggleEngine: () => void; onPlayLine: (pvUci: string[]) => void
    onHoverMove?: (uci: string | null) => void; lines: AnalysisLine[] | null; fen: string
    isDuck?: boolean; mainSan?: string | null
}) {
    const [numLines, setNumLines] = useState(loadLineCount)

    const shown = lines?.slice(0, numLines) ?? []
    const depth = shown[0]?.depth ?? null

    // Convert each line's UCI PV to SAN tokens.
    const allTokens = useMemo(() => shown.map((l): { tokens: { text: string; num: boolean; firstMove?: boolean }[]; ev: WhiteEval } => {
        const ev: WhiteEval = { type: l.eval.type, white: l.eval.value }
        if (!l.pv || l.pv.length === 0) return { tokens: [], ev }
        const sans = pvToSan(fen, l.pv)
        let full = 1; let white = true
        const out: { text: string; num: boolean; firstMove?: boolean }[] = []
        let first = false
        sans.forEach((mv, i) => {
            if (white) out.push({ text: `${full}.`, num: true })
            else if (i === 0) out.push({ text: `${full}…`, num: true })
            out.push({ text: mv.san, num: false, firstMove: !first })
            first = true
            if (!white) full += 1; white = !white
        })
        return { tokens: out, ev }
        // `shown` is a fresh array every render, so depending on it defeated the
        // memo entirely; it is fully derived from these three, which are stable.
    }), [fen, lines, numLines])

    // Engine off hides the LINES, never the header — the on/off Toggle lives in
    // that header, so returning null for the whole panel (as this used to) left
    // no way to turn the engine back on except the `L` hotkey. The off-state
    // styling below (the flat background, the "Turn engine on" tooltip) was
    // written for exactly this and had been dead code ever since.
    return (
        <Box sx={{ bgcolor:'var(--bg-2)',
            background: engineOn ? 'linear-gradient(180deg, rgba(216,166,87,0.06), rgba(216,166,87,0) 60%), var(--bg-2)' : 'var(--bg-2)' }}>
            <Box sx={{ display:'flex', alignItems:'center', gap:1.25, px:1.5, pt:1.25, pb:0.5 }}>
                <Tooltip title={engineOn ? 'Turn engine off' : 'Turn engine on'} arrow placement="top">
                    <Toggle on={engineOn} onChange={onToggleEngine} />
                </Tooltip>
                <Typography sx={{ fontFamily:'var(--font-display)', fontSize:13, fontWeight:700, letterSpacing:1.8, textTransform:'uppercase', color:'var(--text)' }}>Engine</Typography>
                <Box sx={{ flex:1 }} />
                {engineOn && depth != null && (
                    <Box sx={{ display:'flex', alignItems:'baseline', gap:0.6 }}>
                        <Typography sx={{ fontSize:10, letterSpacing:1.2, textTransform:'uppercase', color:'var(--muted)' }}>depth</Typography>
                        <Typography sx={{ fontFamily:'var(--font-mono)', fontSize:13.5, fontWeight:700, color:'var(--text-dim)' }}>{depth}</Typography>
                    </Box>
                )}
            </Box>
            {engineOn && (
            <Box sx={{ borderTop:'1px solid var(--line-soft)', px:1.5, py:1.1 }}>
                <Box sx={{ display:'flex', alignItems:'center', gap:1, mb:0.75 }}>
                    <Typography sx={{ flex:1, fontFamily:'var(--font-display)', fontSize:11.5, fontWeight:700, letterSpacing:1.6, textTransform:'uppercase', color:'var(--text-dim)' }}>Engine lines</Typography>
                    <Box sx={{ display:'flex', gap:0.4 }}>
                        {[1,2,3,4,5].map((n) => (
                            <Box key={n} component="button" onClick={() => { setNumLines(n); saveLineCount(n) }}
                                aria-label={`Show ${n} line${n>1?'s':''}`}
                                sx={{ width:19, height:19, borderRadius:'5px', cursor:'pointer', fontFamily:'var(--font-mono)', fontSize:10.5, fontWeight:700, lineHeight:1,
                                      color: numLines===n ? 'var(--accent)' : 'var(--text-dim)',
                                      bgcolor: numLines===n ? 'var(--accent-soft)' : 'transparent',
                                      border:`1px solid ${numLines===n ? 'var(--accent-line)' : 'var(--line)'}`,
                                      transition:'color .12s, background-color .12s, border-color .12s',
                                      '&:hover':{ color:'var(--accent)', borderColor:'var(--accent-line)' } }}>{n}</Box>
                        ))}
                    </Box>
                </Box>
                <Box sx={{ display:'flex', flexDirection:'column', gap:0.15 }}>
                    {shown.length === 0 ? (
                        isDuck && mainSan ? (
                            <Box sx={{ display:'grid', gridTemplateColumns:'1fr auto', alignItems:'baseline', gap:0.85, px:0.5, py:0.45, borderRadius:'6px', bgcolor:'var(--accent-soft)', border:'1px solid var(--accent-line)' }}>
                                <Typography sx={{ fontFamily:'var(--font-mono)', fontSize:12.5, color:'var(--text)' }}>{mainSan}</Typography>
                                <Box sx={{ fontFamily:'var(--font-mono)', fontSize:11.5, fontWeight:700, px:0.65, py:0.25, borderRadius:'4px', color:'#ece9e1', background:'#15171c', boxShadow:'0 1px 2px rgba(0,0,0,0.25)', textAlign:'center' }}>?</Box>
                            </Box>
                        ) : (
                            <Typography sx={{ fontSize:12, color:'var(--muted)', fontStyle:'italic' }}>Analysing…</Typography>
                        )
                    ) : (
                        allTokens.map((row, i) => {
                            const line = shown[i]
                            return (
                                <Box key={line.bestmove} role="button"
                                    onClick={() => onPlayLine(line.pv)}
                                    onMouseEnter={onHoverMove ? () => onHoverMove(line.bestmove) : undefined}
                                    onMouseLeave={onHoverMove ? () => onHoverMove(null) : undefined}
                                    sx={{ display:'grid', gridTemplateColumns:'1fr auto', alignItems:'baseline', gap:0.85, px:0.5, py:0.45, borderRadius:'6px', cursor:'pointer',
                                          transition:'background-color .12s', bgcolor: i===0 ? 'var(--accent-soft)' : 'transparent',
                                          border: i===0 ? '1px solid var(--accent-line)' : '1px solid transparent',
                                          '&:hover':{ bgcolor: i===0 ? 'var(--accent-soft)' : 'var(--line)' } }}>
                                    <Typography sx={{ fontFamily:'var(--font-mono)', fontSize:12.5, lineHeight:1.4, color:'var(--text)', minWidth:0, whiteSpace:'nowrap', overflow:'hidden', textOverflow:'ellipsis' }}>
                                        {row.tokens.map((t, j) => (
                                            <Box key={j} component="span"
                                                sx={{ display: t.firstMove ? 'inline-block' : 'inline', color: t.num ? 'var(--muted)' : 'var(--text)',
                                                      fontWeight: t.num ? 400 : 600, mr: t.num ? 0.35 : 0.7,
                                                      bgcolor: t.firstMove ? 'color-mix(in srgb, var(--accent) 22%, transparent)' : 'transparent',
                                                      borderRadius: t.firstMove ? '4px' : undefined, px: t.firstMove ? 0.5 : undefined, py: t.firstMove ? '1px' : undefined,
                                                      border: t.firstMove ? '1px solid color-mix(in srgb, var(--accent) 65%, transparent)' : 'none' }}>
                                                {t.num ? t.text : <MoveSan san={t.text} />}
                                            </Box>
                                        ))}
                                    </Typography>
                                    <Box sx={{ fontFamily:'var(--font-mono)', fontSize:11.5, fontWeight:700, px:0.65, py:0.25, borderRadius:'4px',
                                               color: row.ev.white > 0 ? '#15171c' : '#ece9e1',
                                               background: row.ev.white > 0 ? 'linear-gradient(180deg, #f3eee2, #e4dccb)' : row.ev.white === 0 ? 'var(--surface-2)' : '#15171c',
                                               boxShadow:'0 1px 2px rgba(0,0,0,0.25)', textAlign:'center' }}>
                                        {evalText(row.ev.type, row.ev.white)}
                                    </Box>
                                </Box>
                            )
                        })
                    )}
                </Box>
            </Box>
            )}
        </Box>
    )
}
