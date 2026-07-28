import { useEffect, useMemo, useState } from 'react'
import { Box, Tooltip, Typography } from '@mui/material'
import { candidates, type CandidateMove } from '../api/client'
import type { WhiteEval } from './EvalBar'
import { pvToSan } from '../lib/analysisTree'
import { MoveSan } from './MoveSan'

// How many ranked lines the user can choose to see (1-5), default 3.
const MIN_LINES = 1
const MAX_LINES = 5
const DEFAULT_LINES = 3

// Debounce before firing a request, so rapid navigation (arrow-key scrubbing)
// doesn't fire one /candidates call per intermediate position.
const DEBOUNCE_MS = 150

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

// "+1.8" / "-0.5" / "M4" / "-M4", from White's perspective.
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
 * Engine analysis header + ranked multi-PV lines. Line 1 is drawn from the main
 * progressive-deepening analysis (always matches the eval bar). Lines 2-N come
 * from a separate /candidates call, filtered to exclude the main best move so
 * there's no duplicate. The /candidates movetime scales with the main analysis
 * depth — shallow at first, deeper as the analysis climbs the ladder.
 */
export default function EngineLines({
    fen,
    engineOn,
    onToggleEngine,
    onPlayLine,
    onHoverMove,
    refreshKey,
    mainEval,
    mainPv,
    mainDepth,
    mainUci,
    mainSan,
    isDuck,
}: {
    fen: string
    engineOn: boolean
    onToggleEngine: () => void
    onPlayLine: (pvUci: string[]) => void
    onHoverMove?: (uci: string | null) => void
    refreshKey?: number
    /** Main progressive-deepening analysis data (line 1). */
    mainEval: WhiteEval | null
    mainPv: string[] | null
    mainDepth: number | null
    mainUci: string | null
    /** Duck review: the engine's best move as SAN, shown in place of the PV. */
    mainSan?: string | null
    /** Duck: suppress /candidates (engine has no meaningful multi-PV for duck). */
    isDuck?: boolean
}) {
    const [numLines, setNumLines] = useState(loadLineCount)
    const [candLines, setCandLines] = useState<CandidateMove[]>([])
    const [dataFen, setDataFen] = useState('')

    // Scale the /candidates search budget with the main analysis depth, so the
    // candidate lines deepen alongside the main recommendation instead of staying
    // frozen at a shallow 350ms snapshot.
    const movetime = useMemo(() => {
        const d = refreshKey ?? 0
        if (d <= 6) return 350
        if (d <= 12) return 700
        if (d <= 18) return 1500
        if (d <= 25) return 3000
        return 5000
    }, [refreshKey])

    useEffect(() => {
        if (!engineOn || !fen || isDuck) {
            setCandLines([])
            setDataFen('')
            return
        }
        let alive = true
        const ac = new AbortController()
        const t = setTimeout(() => {
            void candidates(fen, { multipv: 12, movetime, signal: ac.signal })
                .then((res) => {
                    if (!alive) return
                    // Dedupe by first move: exclude the main analysis's best move
                    // (line 1) and take only the first numLines-1 distinct UCIs.
                    const filtered = mainUci
                        ? res.moves.filter((m) => m.uci !== mainUci).slice(0, numLines - 1)
                        : res.moves.slice(0, numLines - 1)
                    setCandLines(filtered)
                    setDataFen(fen)
                })
                .catch(() => {
                    /* aborted or engine error — keep last result */
                })
        }, DEBOUNCE_MS)
        return () => {
            alive = false
            clearTimeout(t)
            ac.abort()
        }
    }, [engineOn, fen, numLines, movetime, mainUci, isDuck])

    if (!engineOn) return null

    const stale = dataFen !== fen
    const displayStm: 'w' | 'b' = fen ? (fen.split(' ')[1] === 'b' ? 'b' : 'w') : 'w'

    return (
        <Box
            sx={{
                bgcolor: 'var(--bg-2)',
                background: engineOn
                    ? 'linear-gradient(180deg, rgba(216,166,87,0.06), rgba(216,166,87,0) 60%), var(--bg-2)'
                    : 'var(--bg-2)',
            }}
        >
            {/* Header: toggle + wordmark + depth (absorbed from EngineLine) */}
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
                {mainDepth != null && (
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
                            {mainDepth}
                        </Typography>
                    </Box>
                )}
            </Box>

            {/* Ranked lines: 1 = main analysis (highlighted), 2-N = /candidates */}
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

                <Box
                    sx={{
                        display: 'flex',
                        flexDirection: 'column',
                        gap: 0.15,
                    }}
                >
                    {/* Line 1: main analysis — same grid layout, highlighted */}
                    {isDuck && mainSan ? (
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
                                    color: mainEval && mainEval.white > 0 ? '#15171c' : '#ece9e1',
                                    background: mainEval && mainEval.white > 0
                                        ? 'linear-gradient(180deg, #f3eee2, #e4dccb)'
                                        : mainEval && mainEval.white === 0
                                            ? 'var(--surface-2)'
                                            : '#15171c',
                                    boxShadow: '0 1px 2px rgba(0,0,0,0.25)',
                                    textAlign: 'center',
                                }}
                            >
                                {mainEval ? evalText(mainEval.type, mainEval.white) : '…'}
                            </Box>
                        </Box>
                    ) : mainEval && mainPv && mainPv.length > 0 ? (
                        <LineRow
                            move={{
                                uci: mainUci ?? '',
                                san: mainPv[0],
                                eval: {
                                    type: mainEval.type,
                                    value: displayStm === 'w' ? mainEval.white : -mainEval.white,
                                },
                                pv: mainPv,
                                depth: mainDepth ?? 0,
                                opening: null,
                            }}
                            fen={fen}
                            stm={displayStm}
                            onPlay={() => onPlayLine(mainPv)}
                            onHover={onHoverMove}
                            highlighted
                        />
                    ) : (
                        <Typography sx={{ fontSize: 12, color: 'var(--muted)', fontStyle: 'italic' }}>
                            Analysing…
                        </Typography>
                    )}

                    {candLines.length > 0 && (
                        <Box
                            sx={{
                                display: 'flex',
                                flexDirection: 'column',
                                gap: 0.15,
                                opacity: stale ? 0.55 : 1,
                                transition: 'opacity .15s',
                            }}
                        >
                            {candLines.map((m) => (
                                <LineRow
                                    key={m.uci}
                                    move={m}
                                    fen={dataFen || fen}
                                    stm={displayStm}
                                    onPlay={() => onPlayLine(m.pv)}
                                    onHover={onHoverMove}
                                />
                            ))}
                        </Box>
                    )}
                </Box>
            </Box>
        </Box>
    )
}

// One ranked candidate line: "2  +0.34  1.e4 e5 2.Nf3 Nc6 …" — rank + eval + PV.
function LineRow({
    move,
    fen,
    stm,
    onPlay,
    onHover,
    highlighted,
}: {
    move: CandidateMove
    fen: string
    stm: 'w' | 'b'
    onPlay: () => void
    onHover?: (uci: string | null) => void
    highlighted?: boolean
}) {
    const white = stm === 'w' ? move.eval.value : -move.eval.value
    const text = evalText(move.eval.type, white)
    const whiteBetter = white > 0

    const fields = fen.split(' ')
    let full = parseInt(fields[5] || '1', 10) || 1
    let whiteToMove = fields[1] !== 'b'
    const tokens: { text: string; num: boolean; firstMove?: boolean }[] = []
    let firstMoveSeen = false
    pvToSan(fen, move.pv).forEach((mv, i) => {
        // Skip the leading "1." / "1…" — every line is an alternative first move.
        if (i === 0) {
            const isFirst = !firstMoveSeen
            tokens.push({ text: mv.san, num: false, firstMove: isFirst })
            firstMoveSeen = true
        } else {
            if (whiteToMove) tokens.push({ text: `${full}.`, num: true })
            tokens.push({ text: mv.san, num: false })
        }
        if (!whiteToMove) full += 1
        whiteToMove = !whiteToMove
    })

    return (
        <Box
            role="button"
            onClick={onPlay}
            onMouseEnter={() => onHover?.(move.uci)}
            onMouseLeave={() => onHover?.(null)}
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
                        : white === 0
                            ? 'var(--surface-2)'
                            : '#15171c',
                    boxShadow: '0 1px 2px rgba(0,0,0,0.25)',
                    textAlign: 'center',
                }}
            >
                {text}
            </Box>
        </Box>
    )
}
