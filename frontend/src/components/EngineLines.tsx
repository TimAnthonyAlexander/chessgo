import { useEffect, useState } from 'react'
import { Box, Typography } from '@mui/material'
import { candidates, type CandidateMove } from '../api/client'
import { pvToSan } from '../lib/analysisTree'
import { MoveSan } from './MoveSan'

// How many ranked lines the user can choose to see (1-5), default 3.
const MIN_LINES = 1
const MAX_LINES = 5
const DEFAULT_LINES = 3

// Per-call search budget (ms). Deliberately the SAME value OpeningPanel uses —
// the engine's /candidates result is cached server-side by (position, depth,
// movetime), ignoring multipv, so sharing this constant means both panels'
// requests for the same position hit the same cache entry instead of doubling
// the engine work.
const MOVETIME = 350

// Debounce before firing a request, so rapid navigation (arrow-key scrubbing)
// doesn't fire one /candidates call per intermediate position.
const DEBOUNCE_MS = 150

const LS_KEY = 'chessgo.analysis.multipvLines'

function loadLineCount(): number {
    try {
        const v = parseInt(localStorage.getItem(LS_KEY) ?? '', 10)
        if (v >= MIN_LINES && v <= MAX_LINES) return v
    } catch {
        /* ignore — falls back to the default below */
    }
    return DEFAULT_LINES
}

function saveLineCount(n: number): void {
    try {
        localStorage.setItem(LS_KEY, String(n))
    } catch {
        /* ignore — preference just won't persist this session */
    }
}

// "+1.8" / "-0.5" / "M4" / "-M4", from White's perspective.
function evalText(type: 'cp' | 'mate', white: number): string {
    if (type === 'mate') return `${white < 0 ? '-' : ''}M${Math.abs(white)}`
    const v = white / 100
    return (v > 0 ? '+' : '') + v.toFixed(2)
}

/**
 * Multi-PV engine lines: the top N ranked continuations from the viewed position
 * (best-first), each with its eval and full line in SAN. This is a plain,
 * showcase-the-engine list — separate from OpeningPanel, which uses the same
 * `/candidates` endpoint for opening naming + a per-move eval bar. Hidden
 * entirely for Duck Chess (the caller gates that, like OpeningPanel).
 */
export default function EngineLines({
    fen,
    engineOn,
    onPlayLine,
    onHoverMove,
}: {
    fen: string
    engineOn: boolean
    /** Play an entire principal variation (UCI moves, from `fen`) onto the board,
     *  branch-aware — stops at the first illegal/unplayable move. */
    onPlayLine: (pvUci: string[]) => void
    /** Hovering a line reports its first move's UCI (null on leave) so the board
     *  can draw an arrow for it. */
    onHoverMove?: (uci: string | null) => void
}) {
    const [numLines, setNumLines] = useState(loadLineCount)
    const [lines, setLines] = useState<CandidateMove[]>([])
    // The fen `lines` was computed for, so a stale response never renders against
    // the wrong position (and so we can tell "no lines yet" from "no lines here").
    const [dataFen, setDataFen] = useState('')

    useEffect(() => {
        if (!engineOn || !fen) {
            setLines([])
            setDataFen('')
            return
        }
        let alive = true
        const ac = new AbortController()
        const t = setTimeout(() => {
            void candidates(fen, { multipv: numLines, movetime: MOVETIME, signal: ac.signal })
                .then((res) => {
                    if (!alive) return
                    setLines(res.moves)
                    setDataFen(fen)
                })
                .catch(() => {
                    /* aborted, or the engine errored — keep showing the last result */
                })
        }, DEBOUNCE_MS)
        return () => {
            alive = false
            clearTimeout(t)
            ac.abort()
        }
    }, [engineOn, fen, numLines])

    if (!engineOn) return null

    // The response can lag a fast navigation — dim the (still-correct, just
    // stale) last result rather than blanking the panel while the new one loads.
    const stale = dataFen !== fen
    const displayStm: 'w' | 'b' = dataFen ? (dataFen.split(' ')[1] === 'b' ? 'b' : 'w') : 'w'

    return (
        <Box sx={{ borderTop: '1px solid var(--line-soft)', bgcolor: 'var(--bg-2)', px: 1.5, py: 1.1 }}>
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

            {lines.length === 0 ? (
                <Typography sx={{ fontSize: 12, color: 'var(--muted)', fontStyle: 'italic' }}>
                    {dataFen ? 'No lines' : 'Analysing…'}
                </Typography>
            ) : (
                <Box
                    sx={{
                        display: 'flex',
                        flexDirection: 'column',
                        gap: 0.15,
                        opacity: stale ? 0.55 : 1,
                        transition: 'opacity .15s',
                    }}
                >
                    {lines.map((m, i) => (
                        <LineRow
                            key={m.uci}
                            rank={i + 1}
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
    )
}

// One ranked line: "1  +0.34  1.e4 e5 2.Nf3 Nc6 …" — rank + eval + the PV in SAN,
// numbered like a move list. Plain and monospace, no per-move bars/colors.
function LineRow({
    rank,
    move,
    fen,
    stm,
    onPlay,
    onHover,
}: {
    rank: number
    move: CandidateMove
    fen: string
    stm: 'w' | 'b'
    onPlay: () => void
    onHover?: (uci: string | null) => void
}) {
    const white = stm === 'w' ? move.eval.value : -move.eval.value
    const text = evalText(move.eval.type, white)
    const whiteBetter = white > 0

    // Render the PV as numbered SAN tokens, relative to this position's move
    // number and side to move (mirrors the single-line engine header above it).
    const fields = fen.split(' ')
    let full = parseInt(fields[5] || '1', 10) || 1
    let whiteToMove = fields[1] !== 'b'
    const tokens: { text: string; num: boolean }[] = []
    pvToSan(fen, move.pv).forEach((mv, i) => {
        if (whiteToMove) tokens.push({ text: `${full}.`, num: true })
        else if (i === 0) tokens.push({ text: `${full}…`, num: true })
        tokens.push({ text: mv.san, num: false })
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
                gridTemplateColumns: '16px 48px 1fr',
                alignItems: 'baseline',
                gap: 0.85,
                px: 0.5,
                py: 0.45,
                borderRadius: '6px',
                cursor: 'pointer',
                transition: 'background-color .12s',
                '&:hover': { bgcolor: 'var(--line)' },
            }}
        >
            <Typography
                sx={{ fontFamily: 'var(--font-mono)', fontSize: 11, color: 'var(--muted)' }}
            >
                {rank}
            </Typography>
            <Typography
                sx={{
                    fontFamily: 'var(--font-mono)',
                    fontSize: 12.5,
                    fontWeight: 700,
                    color: whiteBetter ? 'var(--text)' : 'var(--text-dim)',
                }}
            >
                {text}
            </Typography>
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
                            color: t.num ? 'var(--muted)' : 'var(--text)',
                            fontWeight: t.num ? 400 : 600,
                            mr: t.num ? 0.35 : 0.7,
                        }}
                    >
                        {t.num ? t.text : <MoveSan san={t.text} />}
                    </Box>
                ))}
            </Typography>
        </Box>
    )
}
