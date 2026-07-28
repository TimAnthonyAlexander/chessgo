import { useMemo, useState } from 'react'
import { Box, Tooltip, Typography } from '@mui/material'
import { pvToSan } from '../lib/analysisTree'
import { MoveSan } from './MoveSan'
import type { AnalysisLine } from '../api/client'

const MIN_LINES = 1
const MAX_LINES = 5
const DEFAULT_LINES = 3
const LS_KEY = 'chessgo.analysis.multipvLines'

function loadLineCount(): number {
    try {
        const v = parseInt(localStorage.getItem(LS_KEY) ?? '', 10)
        if (v >= MIN_LINES && v <= MAX_LINES) return v
    } catch {
        /* ignore */
    }
    return DEFAULT_LINES
}

function saveLineCount(n: number): void {
    try {
        localStorage.setItem(LS_KEY, String(n))
    } catch {
        /* ignore */
    }
}

function evalText(type: 'cp' | 'mate', white: number): string {
    if (type === 'mate') return `${white < 0 ? '-' : ''}M${Math.abs(white)}`
    const v = white / 100
    return (v > 0 ? '+' : '') + v.toFixed(2)
}

function Toggle({ on, onChange }: { on: boolean; onChange: () => void }) {
    return (
        <Box
            component="button"
            onClick={onChange}
            aria-label="Toggle engine"
            sx={{
                position: 'relative',
                width: 34,
                height: 20,
                borderRadius: 10,
                border: 'none',
                cursor: 'pointer',
                bgcolor: on ? 'var(--accent)' : 'var(--surface-2)',
                transition: 'background-color .2s',
                p: 0,
            }}
        >
            <Box
                sx={{
                    position: 'absolute',
                    top: 2,
                    left: on ? 16 : 2,
                    width: 16,
                    height: 16,
                    borderRadius: '50%',
                    bgcolor: 'var(--text)',
                    transition: 'left .2s',
                }}
            />
        </Box>
    )
}

/**
 * Engine analysis header + ranked multi-PV lines. All lines come from the main
 * progressive-deepening analysis (multipv=5) — no separate /candidates call.
 * Line 1 matches the eval bar exactly; lines 2-N are at the same depth.
 */
export default function EngineLines({
    engineOn,
    onToggleEngine,
    onPlayLine,
    onHoverMove,
    lines,
    fen,
    isDuck,
    mainSan,
}: {
    engineOn: boolean
    onToggleEngine: () => void
    onPlayLine: (pvUci: string[]) => void
    onHoverMove?: (uci: string | null) => void
    lines: AnalysisLine[] | null
    fen: string
    isDuck?: boolean
    /** Duck review: the engine's best move as SAN. */
    mainSan?: string | null
}) {
    const [numLines, setNumLines] = useState(loadLineCount)

    if (!engineOn) return null

    const shown = lines?.slice(0, numLines) ?? []
    const top = shown[0] ?? null

    return (
        <Box
            sx={{
                bgcolor: 'var(--bg-2)',
                background: engineOn
                    ? 'linear-gradient(180deg, rgba(216,166,87,0.06), rgba(216,166,87,0) 60%), var(--bg-2)'
                    : 'var(--bg-2)',
            }}
        >
            {/* Header: toggle + wordmark + depth */}
            <Box sx={{ display: 'flex', alignItems: 'center', gap: 1.25, px: 1.5, pt: 1.25, pb: 0.5 }}>
                <Tooltip title={engineOn ? 'Turn engine off' : 'Turn engine on'} arrow placement="top">
                    <Toggle on={engineOn} onChange={onToggleEngine} />
                </Tooltip>
                <Box sx={{ display: 'flex', flexDirection: 'column', lineHeight: 1 }}>
                    <Typography
                        sx={{
                            fontFamily: 'var(--font-display)',
                            fontSize: 13,
                            fontWeight: 700,
                            letterSpacing: 1.8,
                            textTransform: 'uppercase',
                            color: 'var(--text)',
                        }}
                    >
                        Engine
                    </Typography>
                </Box>
                <Box sx={{ flex: 1 }} />
                {top?.depth != null && (
                    <Box sx={{ display: 'flex', alignItems: 'baseline', gap: 0.6 }}>
                        <Typography
                            sx={{
                                fontSize: 10,
                                letterSpacing: 1.2,
                                textTransform: 'uppercase',
                                color: 'var(--muted)',
                            }}
                        >
                            depth
                        </Typography>
                        <Typography
                            sx={{
                                fontFamily: 'var(--font-mono)',
                                fontSize: 13.5,
                                fontWeight: 700,
                                color: 'var(--text-dim)',
                            }}
                        >
                            {top.depth}
                        </Typography>
                    </Box>
                )}
            </Box>

            {/* Ranked lines */}
            <Box sx={{ borderTop: '1px solid var(--line-soft)', px: 1.5, py: 1.1 }}>
                <Box sx={{ display: 'flex', alignItems: 'center', gap: 1, mb: 0.75 }}>
                    <Typography
                        sx={{
                            flex: 1,
                            fontFamily: 'var(--font-display)',
                            fontSize: 11.5,
                            fontWeight: 700,
                            letterSpacing: 1.6,
                            textTransform: 'uppercase',
                            color: 'var(--text-dim)',
                        }}
                    >
                        Engine lines
                    </Typography>
                    <Box sx={{ display: 'flex', gap: 0.4 }}>
                        {[1, 2, 3, 4, 5].map((n) => (
                            <Box
                                key={n}
                                component="button"
                                onClick={() => {
                                    setNumLines(n)
                                    saveLineCount(n)
                                }}
                                aria-label={`Show ${n} line${n > 1 ? 's' : ''}`}
                                sx={{
                                    width: 19,
                                    height: 19,
                                    borderRadius: '5px',
                                    cursor: 'pointer',
                                    fontFamily: 'var(--font-mono)',
                                    fontSize: 10.5,
                                    fontWeight: 700,
                                    lineHeight: 1,
                                    color: numLines === n ? 'var(--accent)' : 'var(--text-dim)',
                                    bgcolor: numLines === n ? 'var(--accent-soft)' : 'transparent',
                                    border: `1px solid ${numLines === n ? 'var(--accent-line)' : 'var(--line)'}`,
                                    transition: 'color .12s, background-color .12s, border-color .12s',
                                    '&:hover': { color: 'var(--accent)', borderColor: 'var(--accent-line)' },
                                }}
                            >
                                {n}
                            </Box>
                        ))}
                    </Box>
                </Box>

                <Box sx={{ display: 'flex', flexDirection: 'column', gap: 0.15 }}>
                    {shown.length === 0 ? (
                        isDuck && mainSan ? (
                            <Box
                                sx={{
                                    display: 'grid',
                                    gridTemplateColumns: '1fr auto',
                                    alignItems: 'baseline',
                                    gap: 0.85,
                                    px: 0.5,
                                    py: 0.45,
                                    borderRadius: '6px',
                                    bgcolor: 'var(--accent-soft)',
                                    border: '1px solid var(--accent-line)',
                                }}
                            >
                                <Typography sx={{ fontFamily: 'var(--font-mono)', fontSize: 12.5, color: 'var(--text)' }}>
                                    {mainSan}
                                </Typography>
                                <Box
                                    sx={{
                                        fontFamily: 'var(--font-mono)',
                                        fontSize: 11.5,
                                        fontWeight: 700,
                                        px: 0.65,
                                        py: 0.25,
                                        borderRadius: '4px',
                                        color: '#ece9e1',
                                        background: '#15171c',
                                        boxShadow: '0 1px 2px rgba(0,0,0,0.25)',
                                        textAlign: 'center',
                                    }}
                                >
                                    ?
                                </Box>
                            </Box>
                        ) : (
                            <Typography sx={{ fontSize: 12, color: 'var(--muted)', fontStyle: 'italic' }}>
                                Analysing…
                            </Typography>
                        )
                    ) : (
                        shown.map((line, i) => (
                            <LineRow
                                key={line.bestmove}
                                line={line}
                                fen={fen}
                                highlighted={i === 0}
                                onPlay={() => onPlayLine(line.pv)}
                                onHover={onHoverMove ? () => onHoverMove(line.bestmove) : undefined}
                                onHoverEnd={onHoverMove ? () => onHoverMove(null) : undefined}
                            />
                        ))
                    )}
                </Box>
            </Box>
        </Box>
    )
}

function LineRow({
    line,
    fen,
    highlighted,
    onPlay,
    onHover,
    onHoverEnd,
}: {
    line: AnalysisLine
    fen: string
    highlighted?: boolean
    onPlay: () => void
    onHover?: () => void
    onHoverEnd?: () => void
}) {
    const tokens = useMemo<{ text: string; num: boolean; firstMove?: boolean }[]>(() => {
        if (!line.pv || line.pv.length === 0) return []
        const sans = pvToSan(fen, line.pv)
        let full = 1
        let whiteToMove = true
        const out: { text: string; num: boolean; firstMove?: boolean }[] = []
        let firstMoveSeen = false
        sans.forEach((mv, i) => {
            if (whiteToMove) out.push({ text: `${full}.`, num: true })
            else if (i === 0) out.push({ text: `${full}…`, num: true })
            const isFirst = !firstMoveSeen
            out.push({ text: mv.san, num: false, firstMove: isFirst })
            firstMoveSeen = true
            if (!whiteToMove) full += 1
            whiteToMove = !whiteToMove
        })
        return out
    }, [fen, line.pv])

    const evalValue = line.eval.value
    const whiteBetter = evalValue > 0

    return (
        <Box
            role="button"
            onClick={onPlay}
            onMouseEnter={onHover}
            onMouseLeave={onHoverEnd}
            sx={{
                display: 'grid',
                gridTemplateColumns: '1fr auto',
                alignItems: 'baseline',
                gap: 0.85,
                px: 0.5,
                py: 0.45,
                borderRadius: '6px',
                cursor: 'pointer',
                transition: 'background-color .12s',
                bgcolor: highlighted ? 'var(--accent-soft)' : 'transparent',
                border: highlighted ? '1px solid var(--accent-line)' : '1px solid transparent',
                '&:hover': { bgcolor: highlighted ? 'var(--accent-soft)' : 'var(--line)' },
            }}
        >
            <Typography
                sx={{
                    fontFamily: 'var(--font-mono)',
                    fontSize: 12.5,
                    lineHeight: 1.4,
                    color: 'var(--text)',
                    minWidth: 0,
                    whiteSpace: 'nowrap',
                    overflow: 'hidden',
                    textOverflow: 'ellipsis',
                }}
            >
                {tokens.map((t, i) => (
                    <Box
                        key={i}
                        component="span"
                        sx={{
                            display: t.firstMove ? 'inline-block' : 'inline',
                            color: t.num ? 'var(--muted)' : 'var(--text)',
                            fontWeight: t.num ? 400 : 600,
                            mr: t.num ? 0.35 : 0.7,
                            bgcolor: t.firstMove ? 'color-mix(in srgb, var(--accent) 22%, transparent)' : 'transparent',
                            borderRadius: t.firstMove ? '4px' : undefined,
                            px: t.firstMove ? 0.5 : undefined,
                            py: t.firstMove ? '1px' : undefined,
                            border: t.firstMove ? '1px solid color-mix(in srgb, var(--accent) 65%, transparent)' : 'none',
                        }}
                    >
                        {t.num ? t.text : <MoveSan san={t.text} />}
                    </Box>
                ))}
            </Typography>
            <Box
                sx={{
                    fontFamily: 'var(--font-mono)',
                    fontSize: 11.5,
                    fontWeight: 700,
                    px: 0.65,
                    py: 0.25,
                    borderRadius: '4px',
                    color: whiteBetter ? '#15171c' : '#ece9e1',
                    background: whiteBetter
                        ? 'linear-gradient(180deg, #f3eee2, #e4dccb)'
                        : evalValue === 0
                            ? 'var(--surface-2)'
                            : '#15171c',
                    boxShadow: '0 1px 2px rgba(0,0,0,0.25)',
                    textAlign: 'center',
                }}
            >
                {evalText(line.eval.type, evalValue)}
            </Box>
        </Box>
    )
}
