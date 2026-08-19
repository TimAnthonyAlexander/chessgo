import { useEffect, useMemo, useState } from 'react'
import { Box, Tooltip, Typography } from '@mui/material'
import { BookOpen } from 'lucide-react'
import {
    candidates,
    type AnalysisLine,
    type Candidates,
    type CandidateMove,
    type Opening,
} from '../api/client'
import { gameOverAt, pathToNode, START_FEN, type Tree } from '../lib/analysisTree'
import { MoveSan } from './MoveSan'
import { tbLabel, tbWhite, type TbVerdict } from '../lib/engineEval'

// How many candidate rows to request/show. The engine ranks best-first.
const MAX_ROWS = 4
// Per-call search budget (ms). Short enough to feel live as you click around.
const MOVETIME = 350

// Lichess "winning chances": the same sigmoid the vertical EvalBar uses, so a
// per-move bar reads consistently with the main eval bar. Input is WHITE-relative
// centipawns; output is White's share of the bar (0..100).
function whiteWinPercent(type: 'cp' | 'mate', white: number, tb?: TbVerdict): number {
    if (tb) return tb === 'win' ? 100 : 0
    if (type === 'mate') return white > 0 ? 100 : white < 0 ? 0 : 50
    const cp = Math.max(-1000, Math.min(1000, white))
    return 50 + 50 * (2 / (1 + Math.exp(-0.00368208 * cp)) - 1)
}

// "+1.8" / "-0.5" / "#3" / "-#2" / "TB", from White's perspective.
function evalText(type: 'cp' | 'mate', white: number, tb?: TbVerdict): string {
    if (tb) return tbLabel(tb)
    if (type === 'mate') return `${white < 0 ? '-' : ''}#${Math.abs(white)}`
    const v = white / 100
    return (v > 0 ? '+' : '') + v.toFixed(1)
}

/** Fetch the opening explorer for the viewed node: opening name + ranked moves,
 * with the engine doing all the chess. Re-runs (abortably) when the position or
 * the engine toggle changes; stays quiet while the engine is off or game is over. */
function useCandidates(tree: Tree, currentId: number, engineOn: boolean) {
    const [data, setData] = useState<Candidates | null>(null)
    // The fen the current `data` was computed for, so we can tell when it's stale
    // (the position changed but the new response hasn't landed yet) and avoid
    // rendering another position's evals.
    const [dataFen, setDataFen] = useState('')
    const [loading, setLoading] = useState(false)

    // The viewed node's fen + the prior-position fens (root→previous) for the
    // engine's deepest-match opening naming.
    const { fen, history, over } = useMemo(() => {
        const path = pathToNode(tree, currentId)
        const node = path[path.length - 1]
        return {
            fen: node?.fen ?? '',
            history: path.slice(0, -1).map((n) => n.fen),
            over: node ? gameOverAt(node).over : true,
        }
    }, [tree, currentId])

    // `history` is a FRESH array on every tree annotation (each /analyze ladder step
    // calls setTree → new tree object → new array), even though its CONTENT only
    // changes when the VIEWED position changes. Keying the fetch effect on the array
    // reference therefore aborts + refetches /candidates on every /analyze update —
    // the "all but the last fail" bug. Key on the stable string content instead so
    // /candidates is fetched ONCE per position.
    const historyKey = history.join(' ')

    useEffect(() => {
        if (!engineOn || over || !fen) {
            setData(null)
            setLoading(false)
            return
        }
        const ac = new AbortController()
        let alive = true
        setLoading(true)
        void candidates(fen, { history, multipv: MAX_ROWS, movetime: MOVETIME, signal: ac.signal })
            .then((res) => {
                if (alive) {
                    setData(res)
                    setDataFen(fen)
                    setLoading(false)
                }
            })
            .catch(() => {
                /* aborted or engine error — keep the last result */
            })
        return () => {
            alive = false
            ac.abort()
        }
        // `history` is consumed inside but the effect is keyed on the stable
        // `historyKey` proxy (same content ⇒ same key ⇒ no spurious refetch/abort).
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [engineOn, over, fen, historyKey])

    // We return the last loaded data AND the fen it was computed for: the panel
    // keeps showing that (frozen, with its own side-to-move) until the new call
    // lands, so making a move never blanks or reshapes the sidebar.
    return { data, loading, dataFen }
}

/** A `/candidates`-shaped row's UCI field is `uci`; a multi-PV `/analyze` line
 * calls the same thing `bestmove` (it's a root move, not literally "the
 * candidate" — see AnalysisLine). Map to the one shape the render code below
 * understands, so MoveRow never has to know which search produced its data. */
function lineToCandidateMove(l: AnalysisLine): CandidateMove {
    return {
        uci: l.bestmove,
        san: l.san,
        eval: l.eval,
        pv: l.pv,
        depth: l.depth,
        opening: l.opening ?? null,
    }
}

/** Data supplied by a caller that already runs its own MultiPV search against
 * this exact position — the Analysis board's depth ladder (`Analysis.tsx:427`,
 * `analyze(fen, { multipv: 5 })`). Passing this in makes the panel render off
 * THAT result instead of firing a second, independently-timed `/candidates`
 * search that can (and did) disagree with the eval bar. See
 * docs/tasks/open/real-multipv-root-search.md Phase 5. */
export interface OpeningPanelExternalData {
    // Multi-PV lines for the CURRENTLY VIEWED position. The caller is responsible
    // for clearing this to null the instant the viewed position changes (before
    // its own search returns) — the panel trusts a non-null value to belong to
    // `tree`/`currentId` and does no staleness check of its own.
    lines: AnalysisLine[] | null
    // The current position's opening name (a separate book lookup from `lines`).
    opening: Opening | null
    // True while the caller's search for this position hasn't produced a result
    // yet. Distinguishes "still searching" (show "Exploring…") from "search
    // finished with nothing" (show "No moves") — the latter only fires against an
    // older backend that never sends `lines` at all.
    loading: boolean
}

/**
 * The opening explorer panel: the line's opening name (engine-classified) over a
 * list of candidate moves, each with a per-move eval bar. Everything chess here is
 * computed by the engine; this component only renders and lets you click a move
 * to play it into the tree.
 *
 * By default it fetches its own `/candidates`. If `external` is supplied (the
 * Analysis board, which already runs a MultiPV ladder against this position), it
 * renders off that instead and never calls `/candidates` — see
 * {@link OpeningPanelExternalData}.
 */
export default function OpeningPanel({
    tree,
    currentId,
    engineOn,
    onMove,
    onHoverMove,
    external,
}: {
    tree: Tree
    currentId: number
    engineOn: boolean
    onMove: (uci: string) => void
    // Hovering a candidate row reports its UCI (null on leave) so the board can
    // draw an arrow for it.
    onHoverMove?: (uci: string | null) => void
    external?: OpeningPanelExternalData
}) {
    // Force the internal hook's "engine off" branch when a caller supplies its
    // own data — it becomes a no-op (no fetch, no state churn) rather than a
    // second search racing the caller's.
    const own = useCandidates(tree, currentId, engineOn && !external)

    // The viewed position's fen, needed to classify "starting position" / "out of
    // book" for the external path (own-fetch keeps using `own.dataFen`, its own
    // frozen "last computed for" value, unchanged from before).
    const viewedFen = useMemo(() => {
        const path = pathToNode(tree, currentId)
        return path[path.length - 1]?.fen ?? ''
    }, [tree, currentId])

    if (!engineOn) return null

    const usingExternal = !!external
    const data: Candidates | null = external
        ? external.lines && external.lines.length > 0
            ? { opening: external.opening, moves: external.lines.slice(0, MAX_ROWS).map(lineToCandidateMove) }
            : null
        : own.data
    const dataFen = external ? viewedFen : own.dataFen
    const isLoading = external ? external.loading : own.loading

    // Render the LAST loaded result, with the side-to-move IT was computed for —
    // so the bars stay correct and frozen while the next call is in flight (no
    // re-flip, no blanking, no layout shift). It swaps to the new data on arrival.
    const opening = data?.opening ?? null
    const moves = data?.moves ?? []
    const displayStm: 'w' | 'b' = dataFen.split(' ')[1] === 'b' ? 'b' : 'w'
    // Is the shown data the starting position? (board layout matches the start)
    const dataAtStart = dataFen.split(' ')[0] === START_FEN.split(' ')[0]
    // Out of book: we have data, no named opening, and we're past the start. Here the
    // explorer isn't classifying a line anymore — it's just the engine — so show the
    // single best move, not a whole ranked list.
    const outOfBook = !!data && !opening && !dataAtStart
    // Header fallback when there's no named opening: distinguish the genuine start
    // from a real out-of-book position, and the very first load (no data yet).
    const fallbackLabel = !data ? 'Exploring…' : dataAtStart ? 'Starting position' : 'Out of book'
    const displayMoves = outOfBook ? moves.slice(0, 1) : moves

    return (
        <Box sx={{ borderTop: '1px solid var(--line-soft)', bgcolor: 'var(--bg-2)' }}>
            {/* Opening name header */}
            <Box
                sx={{
                    display: 'flex',
                    alignItems: 'center',
                    gap: 1,
                    px: 1.5,
                    py: 1,
                    background: 'var(--bg-2)',
                }}
            >
                <BookOpen size={15} style={{ color: 'var(--accent)', flexShrink: 0 }} />
                {opening ? (
                    <>
                        <Box
                            component="span"
                            sx={{
                                fontFamily: 'var(--font-mono)',
                                fontSize: 11,
                                fontWeight: 700,
                                letterSpacing: 0.5,
                                color: 'var(--accent)',
                                bgcolor: 'var(--accent-soft)',
                                border: '1px solid var(--accent-line)',
                                borderRadius: 'var(--radius)',
                                px: 0.6,
                                py: '1px',
                                flexShrink: 0,
                            }}
                        >
                            {opening.eco}
                        </Box>
                        <Typography
                            title={opening.name}
                            sx={{
                                fontSize: 13,
                                fontWeight: 600,
                                color: 'var(--text)',
                                whiteSpace: 'nowrap',
                                overflow: 'hidden',
                                textOverflow: 'ellipsis',
                                minWidth: 0,
                            }}
                        >
                            {opening.name}
                        </Typography>
                    </>
                ) : (
                    <Typography sx={{ fontSize: 12.5, color: 'var(--muted)', fontStyle: 'italic' }}>
                        {fallbackLabel}
                    </Typography>
                )}
            </Box>

            {/* Candidate moves with per-move eval bars */}
            <Box sx={{ px: 1, pb: 1, display: 'flex', flexDirection: 'column', gap: 0.25 }}>
                {displayMoves.length === 0 ? (
                    <Typography
                        sx={{ fontSize: 12, color: 'var(--muted)', fontStyle: 'italic', px: 0.5, py: 0.75 }}
                    >
                        {/* Own-fetch path: unchanged from before (always "Exploring…" until
                            data lands). External path: "Exploring…" only while the caller's
                            search is actually still running for this position, else a plain
                            "No moves" — matters only against an older backend that never sends
                            `lines` at all (see OpeningPanelExternalData.loading). */}
                        {data
                            ? 'No moves'
                            : usingExternal
                              ? isLoading
                                  ? 'Exploring moves…'
                                  : 'No moves'
                              : 'Exploring moves…'}
                    </Typography>
                ) : (
                    displayMoves.map((m) => (
                        <MoveRow
                            key={m.uci}
                            move={m}
                            stm={displayStm}
                            onPlay={() => onMove(m.uci)}
                            onHover={onHoverMove}
                        />
                    ))
                )}
            </Box>
        </Box>
    )
}

// One candidate row: SAN, a horizontal White/Black eval bar, and the eval text.
// Eval comes side-to-move-relative; we flip to White-relative so the bar reads the
// same way as the main eval bar (cream = White better).
function MoveRow({
    move,
    stm,
    onPlay,
    onHover,
}: {
    move: CandidateMove
    stm: 'w' | 'b'
    onPlay: () => void
    onHover?: (uci: string | null) => void
}) {
    const white = stm === 'w' ? move.eval.value : -move.eval.value
    const tb = tbWhite(move.eval, stm) ?? undefined
    const whitePct = whiteWinPercent(move.eval.type, white, tb)
    const text = evalText(move.eval.type, white, tb)
    const whiteBetter = tb ? tb === 'win' : white > 0
    // Tooltip = the opening this move leads to; empty (no tooltip) when unnamed.
    const tip = move.opening ? `${move.opening.eco} · ${move.opening.name}` : ''

    return (
        <Tooltip title={tip} placement="left" arrow disableInteractive>
        <Box
            role="button"
            onClick={onPlay}
            onMouseEnter={() => onHover?.(move.uci)}
            onMouseLeave={() => onHover?.(null)}
            sx={{
                display: 'grid',
                gridTemplateColumns: '46px 1fr 48px',
                alignItems: 'center',
                gap: 1,
                px: 0.5,
                py: 0.5,
                borderRadius: 'var(--radius)',
                cursor: 'pointer',
                transition: 'background-color .12s',
                '&:hover': { bgcolor: 'var(--line)' },
            }}
        >
            <Typography
                sx={{
                    fontFamily: 'var(--font-mono)',
                    fontSize: 13,
                    fontWeight: 700,
                    color: 'var(--text)',
                }}
            >
                <MoveSan san={move.san} />
            </Typography>

            {/* Eval bar: cream (White) grows from the left over a dark (Black) track. */}
            <Box
                sx={{
                    position: 'relative',
                    height: 10,
                    borderRadius: 'var(--radius)',
                    overflow: 'hidden',
                    bgcolor: '#191c22',
                    border: '1px solid var(--line-soft)',
                }}
            >
                <Box
                    sx={{
                        position: 'absolute',
                        left: 0,
                        top: 0,
                        bottom: 0,
                        width: `${whitePct}%`,
                        background: 'var(--eval-white)',
                        transition: 'width .25s cubic-bezier(0.4,0,0.2,1)',
                    }}
                />
            </Box>

            <Typography
                sx={{
                    fontFamily: 'var(--font-mono)',
                    fontSize: 12,
                    fontWeight: 700,
                    textAlign: 'right',
                    color: whiteBetter ? 'var(--text)' : 'var(--text-dim)',
                }}
            >
                {text}
            </Typography>
        </Box>
        </Tooltip>
    )
}
