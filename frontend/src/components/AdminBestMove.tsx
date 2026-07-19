import { useEffect, useRef, useState } from 'react'
import { Box, Switch, Tooltip, Typography } from '@mui/material'
import { Sparkles } from 'lucide-react'
import { analyze, duckEval, type Analysis, type Color } from '../api/client'
import type { Square } from '../lib/chess'
import { pvToSan } from '../lib/analysisTree'
import { MoveSan } from './MoveSan'

// The from/to squares to whisper onto the board as pixel dots.
type Hint = { from: Square; to: Square } | null

// Extract the from/to squares from a best-move UCI. Duck's best move is a
// composite "<pieceUci>:<duckSquare>" — we hint only the piece move (the duck
// placement is a separate glyph, not a move a from→to dot pair can express).
function hintFromUci(uci: string | null): Hint {
    if (!uci) return null
    const m = uci.split(':')[0]
    if (m.length < 4) return null
    return { from: m.slice(0, 2), to: m.slice(2, 4) }
}

// Convert the engine's UCI best move (e.g. "e2e4", "b1c3") into SAN piece
// notation ("e4", "Nc3") for display. Falls back to the raw UCI if the move
// can't be rendered (illegal/garbage — shouldn't happen for an engine reply).
function bestMoveSan(fen: string, uci: string | null): string {
    if (!uci) return '—'
    return pvToSan(fen, [uci])[0]?.san ?? uci
}

// Normalized best-move readout, so the standard (analyze) and Duck (duckEval)
// paths render through the same UI. Duck has no depth to report.
interface BestDisplay {
    san: string
    eval: Analysis['eval']
    depth: number | null
    hint: Hint
}

// The engine reports its eval from the side-to-move's perspective; convert to
// White-relative so the sign matches every other bar/pill (+ = White, − = Black)
// instead of flipping with whose turn it is.
function formatEval(e: Analysis['eval'], stm: Color): string {
    if (!e) return '—'
    const white = stm === 'w' ? e.value : -e.value
    if (e.type === 'mate') return `${white < 0 ? '-' : ''}#${Math.abs(white)}`
    const pawns = white / 100
    return `${pawns >= 0 ? '+' : ''}${pawns.toFixed(2)}`
}

// The active-color field of a FEN ('w' unless it's explicitly Black to move).
function fenSideToMove(fen: string): Color {
    return fen.split(' ')[1] === 'b' ? 'b' : 'w'
}

const LS_KEY = 'admin-best-move'

function loadEnabled(): boolean {
    try {
        return localStorage.getItem(LS_KEY) === '1'
    } catch {
        return false
    }
}

function saveEnabled(on: boolean): void {
    try {
        localStorage.setItem(LS_KEY, on ? '1' : '0')
    } catch {
        // ignore storage failures (private mode, quota)
    }
}

// Admin-only inline toggle: when on, fetches the full-strength engine best move
// for the given position and shows it compactly (move · eval). Self-contained —
// pages just render it (gated on the admin role) and feed the current FEN.
//
// Duck Chess: the standard engine has no duck rules, and its "best move" is often
// exactly the square the duck now blocks — so in duck mode we query the DUCK engine
// (`/duck/analyze`) instead. Its composite best move's SAN already carries the duck
// glyph (e.g. "Nf6 🦆e2"), so the readout surfaces the best duck placement too.
export default function AdminBestMove({
    fen,
    myTurn,
    isDuck = false,
    duck = null,
    onHint,
}: {
    fen: string
    myTurn: boolean
    isDuck?: boolean
    duck?: string | null
    /** Report the current best-move squares so the page can draw board hint dots.
     * Called with null whenever there's nothing to show (disabled, off-turn, error). */
    onHint?: (hint: Hint) => void
}) {
    const [enabled, setEnabled] = useState(loadEnabled)
    const [best, setBest] = useState<BestDisplay | null>(null)
    const [loading, setLoading] = useState(false)
    const [error, setError] = useState<string | null>(null)

    // Keep the latest callback in a ref so the fetch effect doesn't re-run (and
    // re-query the engine) just because the parent handed us a new function identity.
    const onHintRef = useRef(onHint)
    useEffect(() => {
        onHintRef.current = onHint
    }, [onHint])
    // Clear the board hint when this control unmounts (e.g. admin leaves the page).
    useEffect(() => () => onHintRef.current?.(null), [])

    useEffect(() => {
        // Only compute the best move for the player's own side — no point spending
        // engine time on the opponent's reply.
        if (!enabled || !fen || !myTurn) {
            setBest(null)
            setError(null)
            onHintRef.current?.(null)
            return
        }
        let cancelled = false
        setLoading(true)
        setError(null)
        const req: Promise<BestDisplay> = isDuck
            ? duckEval(fen, duck ?? '').then((d) => ({
                  san: d.bestSan ?? d.bestmove ?? '—',
                  eval: d.eval,
                  depth: null,
                  hint: hintFromUci(d.bestmove),
              }))
            : analyze(fen).then((a) => ({
                  san: bestMoveSan(fen, a.bestmove),
                  eval: a.eval,
                  depth: a.depth,
                  hint: hintFromUci(a.bestmove),
              }))
        req
            .then((b) => {
                if (cancelled) return
                setBest(b)
                onHintRef.current?.(b.hint)
            })
            .catch((e) => {
                if (cancelled) return
                setError(e instanceof Error ? e.message : 'Analysis failed')
                onHintRef.current?.(null)
            })
            .finally(() => {
                if (!cancelled) setLoading(false)
            })
        return () => {
            cancelled = true
        }
    }, [enabled, fen, myTurn, isDuck, duck])

    return (
        <Box sx={{ display: 'flex', alignItems: 'center', gap: 0.75, minWidth: 0 }}>
            <Tooltip title="Engine best move (admin)" placement="top">
                <Box sx={{ display: 'flex', alignItems: 'center', flexShrink: 0 }}>
                    <Sparkles size={14} color={enabled ? 'var(--accent)' : 'var(--text-dim)'} />
                </Box>
            </Tooltip>
            <Switch
                size="small"
                checked={enabled}
                onChange={(e) => {
                    setEnabled(e.target.checked)
                    saveEnabled(e.target.checked)
                }}
            />
            {enabled && (
                <Box
                    sx={{
                        ml: 'auto',
                        display: 'flex',
                        alignItems: 'baseline',
                        gap: 0.75,
                        minWidth: 0,
                        overflow: 'hidden',
                        whiteSpace: 'nowrap',
                    }}
                >
                    {error ? (
                        <Typography
                            sx={{
                                fontSize: 11.5,
                                color: 'var(--danger, #e5484d)',
                                fontFamily: 'var(--font-mono)',
                            }}
                            noWrap
                        >
                            {error}
                        </Typography>
                    ) : best ? (
                        <>
                            <Typography
                                sx={{
                                    fontFamily: 'var(--font-mono)',
                                    fontSize: 13.5,
                                    fontWeight: 700,
                                    color: 'var(--accent)',
                                }}
                                noWrap
                            >
                                <MoveSan san={best.san} />
                            </Typography>
                            <Typography
                                sx={{
                                    fontFamily: 'var(--font-mono)',
                                    fontSize: 11.5,
                                    color: 'var(--text-dim)',
                                }}
                                noWrap
                            >
                                {formatEval(best.eval, fenSideToMove(fen))}
                                {best.depth != null ? ` · d${best.depth}` : ''}
                            </Typography>
                        </>
                    ) : loading ? (
                        <Typography
                            sx={{
                                fontFamily: 'var(--font-mono)',
                                fontSize: 11.5,
                                color: 'var(--text-dim)',
                            }}
                        >
                            …
                        </Typography>
                    ) : null}
                </Box>
            )}
        </Box>
    )
}
