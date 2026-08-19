import { useMemo, useState } from 'react'
import { Box, Tooltip, Typography } from '@mui/material'
import { pvToSan } from '../lib/analysisTree'
import { MoveSan } from './MoveSan'
import type { AnalysisLine } from '../api/client'
import type { WhiteEval } from './EvalBar'
import { tbLabel, toWhiteEval, type TbVerdict } from '../lib/engineEval'

export const LINE_COUNT_KEY = 'chessgo.analysis.multipvLines'
const LS_KEY = LINE_COUNT_KEY
const DEFAULT_LINES = 3

export function loadLineCount(): number {
    try { const v = parseInt(localStorage.getItem(LS_KEY) ?? '', 10); if (v >= 1 && v <= 5) return v } catch { /* ignore */ }
    return DEFAULT_LINES
}
export function saveLineCount(n: number): void {
    try { localStorage.setItem(LS_KEY, String(n)) } catch { /* ignore */ }
}
function evalText(type: 'cp' | 'mate', white: number, tb?: TbVerdict): string {
    // A tablebase verdict replaces the number outright: a solved position has
    // no evaluation to print, only a result. See lib/engineEval.ts.
    if (tb) return tbLabel(tb)
    if (type === 'mate') return `${white < 0 ? '-' : ''}M${Math.abs(white)}`
    return (white > 0 ? '+' : '') + (white / 100).toFixed(2)
}
// flexShrink:0 is load-bearing. This sits in EngineLines's header flex row, and
// once that row gained the local-engine control and the Cloud chip it got crowded
// enough to compress the 34px track — while the knob kept its fixed 16px width at
// left:16, so the knob hung out past the right-hand edge of its own track. The
// track must never shrink. Spectate.tsx's Toggle had flexShrink:0 from the start.
function Toggle({ on, onChange }: { on: boolean; onChange: () => void }) {
    return (
        <Box component="button" onClick={onChange} aria-label="Toggle engine"
            sx={{ position:'relative', flexShrink:0, width:34, height:20, borderRadius:'var(--radius)', border:'none', cursor:'pointer',
                  bgcolor: on ? 'var(--accent)' : 'var(--surface-2)', transition:'background-color .2s', p:0 }}>
            {/* translateX, not `left`, so the knob is laid out once at the inset and
                only transformed — a compositor-only animation, and it cannot be
                re-resolved against a track whose width changed. */}
            <Box sx={{ position:'absolute', top:2, left:2, width:16, height:16,
                       borderRadius:'var(--radius)', bgcolor:'var(--text)',
                       transform: on ? 'translateX(14px)' : 'translateX(0)',
                       transition:'transform .2s' }} />
        </Box>
    )
}

export default function EngineLines({
    engineOn, onToggleEngine, onPlayLine, onHoverMove, lines, fen, isDuck, mainSan,
    headerExtra, sourceBadge, evalDepth, numLines: numLinesProp, onNumLinesChange,
}: {
    engineOn: boolean; onToggleEngine: () => void; onPlayLine: (pvUci: string[]) => void
    onHoverMove?: (uci: string | null) => void; lines: AnalysisLine[] | null; fen: string
    isDuck?: boolean; mainSan?: string | null
    // Optional slot for the local-engine control (toggle/download readout) —
    // rendered in the header, left of the depth chip. Undefined by default, so
    // every existing render (local engine untouched) is byte-identical.
    headerExtra?: React.ReactNode
    // 'cache' badges the depth readout as a server eval_cache hit, per Lichess's
    // CLOUD badge — see Analysis.tsx for how the source is tracked. Undefined/
    // null renders nothing.
    sourceBadge?: 'cache' | null
    /** Depth of the currently displayed EVAL (the tree node's bestDepth), which
     *  is what the depth readout and its source badge describe. */
    evalDepth?: number | null
    /** How many lines to show. Optional: when the parent passes it, the parent
     *  OWNS it and is expected to search for that many. Left uncontrolled this
     *  component keeps its own count and merely slices what it was given —
     *  which is wrong wherever the count should change what gets searched. */
    numLines?: number
    onNumLinesChange?: (n: number) => void
}) {
    // Controlled when the parent supplies a count, uncontrolled otherwise. The
    // analysis board controls it, because asking for 3 lines has to make the
    // ENGINE produce 3 — slicing a 1-line answer to 3 just shows 1, which is
    // exactly what a cache-owned position did.
    const [ownNumLines, setOwnNumLines] = useState(loadLineCount)
    const numLines = numLinesProp ?? ownNumLines
    const setNumLines = (n: number) => {
        setOwnNumLines(n)
        onNumLinesChange?.(n)
    }

    const shown = lines?.slice(0, numLines) ?? []
    // The header depth describes the DISPLAYED EVAL — the number the source
    // badge is attached to — not the move list. The two can differ sharply:
    // with the local engine on, a cached book row supplies the eval at depth 22
    // while the move list comes from local MultiPV at depth 14, and reading the
    // list's depth here printed "Cloud · depth 14", labelling a local number as
    // a cloud result. Falls back to the list only when there is no eval depth
    // (e.g. a revisited node with cached lines and no eval yet).
    const depth = evalDepth ?? shown[0]?.depth ?? null

    // Convert each line's UCI PV to SAN tokens.
    const stm: 'w' | 'b' = fen.split(' ')[1] === 'b' ? 'b' : 'w'
    const allTokens = useMemo(() => shown.map((l): { tokens: { text: string; num: boolean; firstMove?: boolean }[]; ev: WhiteEval } => {
        // The engine scores from the SIDE TO MOVE's point of view; WhiteEval is
        // White-relative, as its name says. Reading l.eval.value straight into
        // `white` printed every line negated on Black's turn (right magnitude,
        // wrong sign) — and inverted the chip's light/dark fill with it, since
        // that keys off ev.white > 0. Analysis.tsx already routes the eval bar
        // and the tree annotation through toWhiteEval; the line list was the one
        // consumer that skipped it. toWhiteEval flips the tb verdict alongside
        // the number, so label and number still agree on who is winning.
        const ev: WhiteEval = toWhiteEval(l.eval, stm) ?? { type: l.eval.type, white: l.eval.value }
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
    }), [fen, stm, lines, numLines])

    // Engine off hides the LINES, never the header — the on/off Toggle lives in
    // that header, so returning null for the whole panel (as this used to) left
    // no way to turn the engine back on except the `L` hotkey. The off-state
    // styling below (the flat background, the "Turn engine on" tooltip) was
    // written for exactly this and had been dead code ever since.
    return (
        <Box sx={{ bgcolor:'var(--bg-2)',
            background: 'var(--bg-2)' }}>
            <Box sx={{ display:'flex', alignItems:'center', gap:1.25, px:1.5, pt:1.25, pb:0.5 }}>
                <Tooltip title={engineOn ? 'Turn engine off' : 'Turn engine on'} arrow placement="top">
                    <Toggle on={engineOn} onChange={onToggleEngine} />
                </Tooltip>
                {/* No "Engine" label — the toggle's tooltip and the panel below say
                    what it is. This spacer takes all the slack so nothing else in the
                    row is ever asked to shrink (see the Toggle's comment). */}
                <Box sx={{ flex:1, minWidth:0 }} />
                {engineOn && headerExtra}
                {engineOn && depth != null && sourceBadge === 'cache' && (
                    <Tooltip title="Served from the shared server cache — a stored evaluation, often far deeper than a fresh search would reach here" arrow placement="top">
                        <Typography sx={{ fontFamily:'var(--font-mono)', fontSize:9.5, fontWeight:700, letterSpacing:0.8, textTransform:'uppercase',
                            color:'var(--text-dim)', border:'1px solid var(--line)', borderRadius:'var(--radius)', px:0.5, py:'1px', cursor:'default',
                            flexShrink:0, whiteSpace:'nowrap' }}>
                            Cloud
                        </Typography>
                    </Tooltip>
                )}
                {engineOn && depth != null && (
                    <Box sx={{ display:'flex', alignItems:'baseline', gap:0.6, flexShrink:0 }}>
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
                                sx={{ width:19, height:19, borderRadius:'var(--radius)', cursor:'pointer', fontFamily:'var(--font-mono)', fontSize:10.5, fontWeight:700, lineHeight:1,
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
                            <Box sx={{ display:'grid', gridTemplateColumns:'1fr auto', alignItems:'baseline', gap:0.85, px:0.5, py:0.45, borderRadius:'var(--radius)', bgcolor:'var(--accent-soft)', border:'1px solid var(--accent-line)' }}>
                                <Typography sx={{ fontFamily:'var(--font-mono)', fontSize:12.5, color:'var(--text)' }}>{mainSan}</Typography>
                                <Box sx={{ fontFamily:'var(--font-mono)', fontSize:11.5, fontWeight:700, px:0.65, py:0.25, borderRadius:'var(--radius)', color:'var(--eval-white)', background:'var(--eval-black)', textAlign:'center' }}>?</Box>
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
                                    sx={{ display:'grid', gridTemplateColumns:'1fr auto', alignItems:'baseline', gap:0.85, px:0.5, py:0.45, borderRadius:'var(--radius)', cursor:'pointer',
                                          transition:'background-color .12s', bgcolor: i===0 ? 'var(--accent-soft)' : 'transparent',
                                          border: i===0 ? '1px solid var(--accent-line)' : '1px solid transparent',
                                          '&:hover':{ bgcolor: i===0 ? 'var(--accent-soft)' : 'var(--line)' } }}>
                                    <Typography sx={{ fontFamily:'var(--font-mono)', fontSize:12.5, lineHeight:1.4, color:'var(--text)', minWidth:0, whiteSpace:'nowrap', overflow:'hidden', textOverflow:'ellipsis' }}>
                                        {row.tokens.map((t, j) => (
                                            <Box key={j} component="span"
                                                sx={{ display: t.firstMove ? 'inline-block' : 'inline', color: t.num ? 'var(--muted)' : 'var(--text)',
                                                      fontWeight: t.num ? 400 : 600, mr: t.num ? 0.35 : 0.7,
                                                      bgcolor: t.firstMove ? 'color-mix(in srgb, var(--accent) 22%, transparent)' : 'transparent',
                                                      borderRadius: 'var(--radius)', px: t.firstMove ? 0.5 : undefined, py: t.firstMove ? '1px' : undefined,
                                                      border: t.firstMove ? '1px solid color-mix(in srgb, var(--accent) 65%, transparent)' : 'none' }}>
                                                {t.num ? t.text : <MoveSan san={t.text} />}
                                            </Box>
                                        ))}
                                    </Typography>
                                    <Box sx={{ fontFamily:'var(--font-mono)', fontSize:11.5, fontWeight:700, px:0.65, py:0.25, borderRadius:'var(--radius)',
                                               color: row.ev.white > 0 ? 'var(--eval-black)' : 'var(--eval-white)',
                                               background: row.ev.white > 0 ? 'var(--eval-white)' : row.ev.white === 0 ? 'var(--surface-2)' : 'var(--eval-black)',
                                               textAlign:'center' }}>
                                        {evalText(row.ev.type, row.ev.white, row.ev.tb)}
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
