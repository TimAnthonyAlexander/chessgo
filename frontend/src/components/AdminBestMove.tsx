import { Fragment, useEffect, useRef, useState } from 'react'
import { Box, Switch, Typography } from '@mui/material'
import { analyze, duckEval, antichessEval, type Analysis, type Color } from '../api/client'
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
    // The next couple of PV moves (SAN) AFTER the best move — the continuation the
    // engine expects. Shown only when the row has room; [] for Duck (no PV line).
    pv: string[]
}

// The engine reports its eval from the side-to-move's perspective; convert to
// White-relative so the sign matches every other bar/pill (+ = White, − = Black)
// instead of flipping with whose turn it is.
function formatEval(e: Analysis['eval'], stm: Color): string {
    if (!e) return '—'
    const white = stm === 'w' ? e.value : -e.value
    if (e.type === 'mate') return `${white < 0 ? '-' : ''}#${Math.abs(white)}`
    // Rounded to the nearest half-pawn — this is a quick admin glance, not analysis.
    const pawns = Math.round((white / 100) * 2) / 2
    return `${pawns >= 0 ? '+' : ''}${pawns.toFixed(1)}`
}

// The active-color field of a FEN ('w' unless it's explicitly Black to move).
function fenSideToMove(fen: string): Color {
    return fen.split(' ')[1] === 'b' ? 'b' : 'w'
}

const LS_KEY = 'admin-best-move'

// Progressive movetime ladder (ms): show a near-instant guess, then refine it twice.
// The engine keeps its transposition table warm across these stateless calls, so
// each deeper rung is cheap — and every rung calls setBest, so the board hint (fed
// off `best.hint`) updates in lockstep as the opinion sharpens.
const LADDER = [20, 100, 1000]

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
//
// Antichess: captures are compulsory and material is inverted, so the standard
// engine's "best move" is frequently ILLEGAL here (and points the wrong way). In
// antichess mode we query the ANTICHESS engine (`/antichess/analyze`) instead, which
// returns a full-strength best LEGAL move + eval.
export default function AdminBestMove({
    fen,
    myTurn,
    isDuck = false,
    isAntichess = false,
    duck = null,
    onHint,
}: {
    fen: string
    myTurn: boolean
    isDuck?: boolean
    isAntichess?: boolean
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

    // Report the current best-move squares up to the page (which feeds them to the
    // board). The board itself owns the hold-to-reveal gating — nothing is drawn until
    // the admin peeks (keyboard on desktop, the touch pad on mobile). Never report a
    // stale hint: cleared on error, and on off-turn/disabled via `best` below.
    useEffect(() => {
        onHintRef.current?.(error ? null : (best?.hint ?? null))
    }, [best, error])

    useEffect(() => {
        // Only compute the best move for the player's own side — no point spending
        // engine time on the opponent's reply.
        if (!enabled || !fen || !myTurn) {
            setBest(null)
            setError(null)
            return
        }
        let cancelled = false
        const controller = new AbortController()
        setLoading(true)
        setError(null)

        // One rung of the ladder: a fixed-movetime best move, normalized to BestDisplay.
        const fetchAt = (movetime: number): Promise<BestDisplay> =>
            isDuck
                ? duckEval(fen, duck ?? '', { movetime, signal: controller.signal }).then((d) => ({
                      san: d.bestSan ?? d.bestmove ?? '—',
                      eval: d.eval,
                      depth: null,
                      hint: hintFromUci(d.bestmove),
                      pv: [],
                  }))
                : isAntichess
                ? antichessEval(fen, { movetime, signal: controller.signal }).then((a) => ({
                      san: a.bestSan ?? a.bestmove ?? '—',
                      eval: a.eval,
                      depth: null,
                      // Antichess best move is a plain UCI (with a `k` king-promo suffix);
                      // hintFromUci reads from/to off the first 4 chars either way.
                      hint: hintFromUci(a.bestmove),
                      pv: [],
                  }))
                : analyze(fen, { movetime, signal: controller.signal }).then((a) => ({
                      san: bestMoveSan(fen, a.bestmove),
                      eval: a.eval,
                      depth: a.depth,
                      hint: hintFromUci(a.bestmove),
                      // pvToSan yields the whole line best-move-first; the next two
                      // moves are the continuation after it.
                      pv: pvToSan(fen, a.pv ?? [])
                          .slice(1, 3)
                          .map((m) => m.san),
                  }))

        // Climb the ladder in sequence, publishing each rung as it lands so the readout
        // (and the board hint) refine from a 20ms guess to a 1000ms verdict. A deeper
        // rung failing never wipes a good shallower result — we only surface an error
        // when nothing has landed yet, and stop climbing.
        void (async () => {
            let haveResult = false
            for (const movetime of LADDER) {
                try {
                    const b = await fetchAt(movetime)
                    if (cancelled) return
                    haveResult = true
                    setBest(b)
                    setError(null)
                    setLoading(false)
                } catch (e) {
                    if (cancelled || controller.signal.aborted) return
                    if (!haveResult) {
                        setError(e instanceof Error ? e.message : 'Analysis failed')
                        setLoading(false)
                    }
                    return
                }
            }
        })()

        return () => {
            cancelled = true
            controller.abort()
        }
    }, [enabled, fen, myTurn, isDuck, isAntichess, duck])

    return (
        <Box sx={{ display: 'flex', alignItems: 'center', gap: 0.75, minWidth: 0 }}>
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
                                    flexShrink: 0,
                                }}
                                noWrap
                            >
                                <MoveSan san={best.san} />
                            </Typography>
                            {/* Continuation (next two PV moves), between the move and its
                                eval. Lowest priority in the row: flexShrink lets it
                                clip/vanish FIRST when space is tight, so the move + eval
                                are never crowded out. */}
                            {best.pv.length > 0 && (
                                <Typography
                                    component="span"
                                    sx={{
                                        fontFamily: 'var(--font-mono)',
                                        fontSize: 11.5,
                                        color: 'var(--muted)',
                                        flexShrink: 1,
                                        minWidth: 0,
                                        overflow: 'hidden',
                                        whiteSpace: 'nowrap',
                                    }}
                                    noWrap
                                >
                                    {best.pv.map((san, i) => (
                                        <Fragment key={i}>
                                            {i > 0 ? ' ' : ''}
                                            <MoveSan san={san} />
                                        </Fragment>
                                    ))}
                                </Typography>
                            )}
                            <Typography
                                sx={{
                                    fontFamily: 'var(--font-mono)',
                                    fontSize: 11.5,
                                    color: 'var(--text-dim)',
                                    flexShrink: 0,
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
