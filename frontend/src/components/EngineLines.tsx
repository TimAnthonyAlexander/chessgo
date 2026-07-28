import { useEffect, useMemo, useState } from 'react'
import { Box, Tooltip, Typography } from '@mui/material'
import { candidates, type CandidateMove } from '../api/client'
import { pvToSan } from '../lib/analysisTree'
import { MoveSan } from './MoveSan'
import type { WhiteEval } from './EvalBar'

const MIN_LINES = 1
const MAX_LINES = 5
const DEFAULT_LINES = 3
const LS_KEY = 'chessgo.analysis.multipvLines'

function loadLineCount(): number {
    try {
        const v = parseInt(localStorage.getItem(LS_KEY) ?? '', 10)
        if (v >= MIN_LINES && v <= MAX_LINES) return v
    } catch { /* ignore */ }
    return DEFAULT_LINES
}

function saveLineCount(n: number): void {
    try { localStorage.setItem(LS_KEY, String(n)) } catch { /* ignore */ }
}

function evalText(type: 'cp' | 'mate', white: number): string {
    if (type === 'mate') return `${white < 0 ? '-' : ''}M${Math.abs(white)}`
    const v = white / 100
    return (v > 0 ? '+' : '') + v.toFixed(2)
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

/**
 * Engine analysis header + ranked multi-PV lines. Line 1 = main progressive-deepening
 * analysis (always matches the eval bar). Lines 2-N = independent /candidates call.
 */
export default function EngineLines({
    engineOn, onToggleEngine, onPlayLine, onHoverMove,
    fen, mainEval, mainPv, mainDepth, mainUci, isDuck, mainSan,
}: {
    engineOn: boolean; onToggleEngine: () => void
    onPlayLine: (pvUci: string[]) => void; onHoverMove?: (uci: string | null) => void
    fen: string
    mainEval: WhiteEval | null; mainPv: string[] | null; mainDepth: number | null; mainUci: string | null
    isDuck?: boolean; mainSan?: string | null
}) {
    const [numLines, setNumLines] = useState(loadLineCount)
    const [candLines, setCandLines] = useState<CandidateMove[]>([])
    const [dataFen, setDataFen] = useState('')

    // Fetch candidates once per position, with a movetime scaled to the main
    // analysis depth. Warm TT from progressive deepening makes this fast.
    useEffect(() => {
        if (!engineOn || !fen || isDuck) { setCandLines([]); setDataFen(''); return }
        const budget = (mainDepth ?? 0) >= 20 ? 800 : (mainDepth ?? 0) >= 12 ? 400 : 200
        const ac = new AbortController()
        let alive = true
        const t = setTimeout(() => {
            void candidates(fen, { multipv: 12, movetime: budget, signal: ac.signal })
                .then((res) => {
                    if (!alive) return
                    const filtered = mainUci
                        ? res.moves.filter((m) => m.uci !== mainUci).slice(0, numLines - 1)
                        : res.moves.slice(0, numLines - 1)
                    setCandLines(filtered)
                    setDataFen(fen)
                })
                .catch(() => { /* aborted */ })
        }, 150)
        return () => { alive = false; clearTimeout(t); ac.abort() }
    }, [engineOn, fen, numLines, mainUci, mainDepth, isDuck])

    if (!engineOn) return null

    const stale = dataFen !== fen

    // Line 1 tokens from main analysis PV.
    const mainTokens = useMemo<{ text: string; num: boolean; firstMove?: boolean }[]>(() => {
        if (!mainPv || mainPv.length === 0) return []
        const sans = pvToSan(fen, mainPv)
        let full = 1; let white = true
        const out: { text: string; num: boolean; firstMove?: boolean }[] = []
        let first = false
        sans.forEach((mv, i) => {
            if (white) out.push({ text: `${full}.`, num: true })
            else if (i === 0) out.push({ text: `${full}…`, num: true })
            out.push({ text: mv.san, num: false, firstMove: !first })
            first = true
            if (!white) full += 1
            white = !white
        })
        return out
    }, [fen, mainPv])

    return (
        <Box sx={{ bgcolor:'var(--bg-2)',
            background: engineOn ? 'linear-gradient(180deg, rgba(216,166,87,0.06), rgba(216,166,87,0) 60%), var(--bg-2)' : 'var(--bg-2)' }}>
            {/* Header */}
            <Box sx={{ display:'flex', alignItems:'center', gap:1.25, px:1.5, pt:1.25, pb:0.5 }}>
                <Tooltip title={engineOn ? 'Turn engine off' : 'Turn engine on'} arrow placement="top">
                    <Toggle on={engineOn} onChange={onToggleEngine} />
                </Tooltip>
                <Typography sx={{ fontFamily:'var(--font-display)', fontSize:13, fontWeight:700, letterSpacing:1.8, textTransform:'uppercase', color:'var(--text)' }}>
                    Engine
                </Typography>
                <Box sx={{ flex:1 }} />
                {mainDepth != null && (
                    <Box sx={{ display:'flex', alignItems:'baseline', gap:0.6 }}>
                        <Typography sx={{ fontSize:10, letterSpacing:1.2, textTransform:'uppercase', color:'var(--muted)' }}>depth</Typography>
                        <Typography sx={{ fontFamily:'var(--font-mono)', fontSize:13.5, fontWeight:700, color:'var(--text-dim)' }}>{mainDepth}</Typography>
                    </Box>
                )}
            </Box>

            {/* Lines */}
            <Box sx={{ borderTop:'1px solid var(--line-soft)', px:1.5, py:1.1 }}>
                <Box sx={{ display:'flex', alignItems:'center', gap:1, mb:0.75 }}>
                    <Typography sx={{ flex:1, fontFamily:'var(--font-display)', fontSize:11.5, fontWeight:700, letterSpacing:1.6, textTransform:'uppercase', color:'var(--text-dim)' }}>
                        Engine lines
                    </Typography>
                    <Box sx={{ display:'flex', gap:0.4 }}>
                        {[1,2,3,4,5].map((n) => (
                            <Box key={n} component="button"
                                onClick={() => { setNumLines(n); saveLineCount(n) }}
                                aria-label={`Show ${n} line${n>1?'s':''}`}
                                sx={{ width:19, height:19, borderRadius:'5px', cursor:'pointer', fontFamily:'var(--font-mono)', fontSize:10.5, fontWeight:700, lineHeight:1,
                                      color: numLines===n ? 'var(--accent)' : 'var(--text-dim)',
                                      bgcolor: numLines===n ? 'var(--accent-soft)' : 'transparent',
                                      border:`1px solid ${numLines===n ? 'var(--accent-line)' : 'var(--line)'}`,
                                      transition:'color .12s, background-color .12s, border-color .12s',
                                      '&:hover':{ color:'var(--accent)', borderColor:'var(--accent-line)' } }}>
                                {n}
                            </Box>
                        ))}
                    </Box>
                </Box>

                <Box sx={{ display:'flex', flexDirection:'column', gap:0.15 }}>
                    {/* Line 1: main analysis, highlighted */}
                    {isDuck && mainSan ? (
                        <Box sx={{ display:'grid', gridTemplateColumns:'1fr auto', alignItems:'baseline', gap:0.85, px:0.5, py:0.45, borderRadius:'6px', bgcolor:'var(--accent-soft)', border:'1px solid var(--accent-line)' }}>
                            <Typography sx={{ fontFamily:'var(--font-mono)', fontSize:12.5, color:'var(--text)' }}>{mainSan}</Typography>
                            <Box sx={{ fontFamily:'var(--font-mono)', fontSize:11.5, fontWeight:700, px:0.65, py:0.25, borderRadius:'4px',
                                       color:'#ece9e1', background:'#15171c', boxShadow:'0 1px 2px rgba(0,0,0,0.25)', textAlign:'center' }}>?</Box>
                        </Box>
                    ) : mainTokens.length > 0 ? (
                        <LineRow tokens={mainTokens} eval={mainEval} highlighted
                            onPlay={() => mainPv && onPlayLine(mainPv)}
                            onHover={mainUci && onHoverMove ? () => onHoverMove(mainUci) : undefined}
                            onHoverEnd={onHoverMove ? () => onHoverMove(null) : undefined} />
                    ) : (
                        <Typography sx={{ fontSize:12, color:'var(--muted)', fontStyle:'italic' }}>Analysing…</Typography>
                    )}

                    {/* Lines 2-N: /candidates, faded while stale */}
                    {candLines.length > 0 && (
                        <Box sx={{ display:'flex', flexDirection:'column', gap:0.15, opacity: stale ? 0.55 : 1, transition:'opacity .15s' }}>
                            {candLines.map((m) => (
                                <CandidateRow key={m.uci} move={m} fen={fen}
                                    onPlay={() => onPlayLine(m.pv)}
                                    onHover={onHoverMove ? () => onHoverMove(m.uci) : undefined}
                                    onHoverEnd={onHoverMove ? () => onHoverMove(null) : undefined} />
                            ))}
                        </Box>
                    )}
                </Box>
            </Box>
        </Box>
    )
}

function CandidateRow({ move, fen, onPlay, onHover, onHoverEnd }: {
    move: CandidateMove; fen: string; onPlay: () => void; onHover?: () => void; onHoverEnd?: () => void
}) {
    const tokens = useMemo(() => {
        const sans = pvToSan(fen, move.pv)
        let full = 1; let white = true
        const out: { text: string; num: boolean; firstMove?: boolean }[] = []
        let first = false
        sans.forEach((mv, i) => {
            if (white) out.push({ text: `${full}.`, num: true })
            else if (i === 0) out.push({ text: `${full}…`, num: true })
            out.push({ text: mv.san, num: false, firstMove: !first })
            first = true
            if (!white) full += 1
            white = !white
        })
        return out
    }, [fen, move.pv])
    const stm = fen.split(' ')[1] !== 'b' ? 'w' : 'b'
    const ev: WhiteEval = stm === 'w'
        ? { type: move.eval.type, white: move.eval.value }
        : { type: move.eval.type, white: -move.eval.value }
    return <LineRow tokens={tokens} eval={ev} onPlay={onPlay} onHover={onHover} onHoverEnd={onHoverEnd} />
}

function LineRow({
    tokens, eval: ev, highlighted, onPlay, onHover, onHoverEnd,
}: {
    tokens: { text: string; num: boolean; firstMove?: boolean }[]
    eval: WhiteEval | null
    highlighted?: boolean
    onPlay: () => void; onHover?: () => void; onHoverEnd?: () => void
}) {
    const text = ev ? evalText(ev.type, ev.white) : '…'
    const whiteBetter = ev ? ev.white > 0 : false
    return (
        <Box role="button" onClick={onPlay} onMouseEnter={onHover} onMouseLeave={onHoverEnd}
            sx={{ display:'grid', gridTemplateColumns:'1fr auto', alignItems:'baseline', gap:0.85, px:0.5, py:0.45, borderRadius:'6px', cursor:'pointer',
                  transition:'background-color .12s', bgcolor: highlighted ? 'var(--accent-soft)' : 'transparent',
                  border: highlighted ? '1px solid var(--accent-line)' : '1px solid transparent',
                  '&:hover':{ bgcolor: highlighted ? 'var(--accent-soft)' : 'var(--line)' } }}>
            <Typography sx={{ fontFamily:'var(--font-mono)', fontSize:12.5, lineHeight:1.4, color:'var(--text)', minWidth:0, whiteSpace:'nowrap', overflow:'hidden', textOverflow:'ellipsis' }}>
                {tokens.map((t, i) => (
                    <Box key={i} component="span"
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
                       color: whiteBetter ? '#15171c' : '#ece9e1',
                       background: whiteBetter ? 'linear-gradient(180deg, #f3eee2, #e4dccb)' : ev && ev.white === 0 ? 'var(--surface-2)' : '#15171c',
                       boxShadow:'0 1px 2px rgba(0,0,0,0.25)', textAlign:'center' }}>
                {text}
            </Box>
        </Box>
    )
}
