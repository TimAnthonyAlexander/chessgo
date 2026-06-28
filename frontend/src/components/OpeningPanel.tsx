import { useEffect, useMemo, useState } from 'react'
import { Box, Typography } from '@mui/material'
import { BookOpen } from 'lucide-react'
import { candidates, type Candidates, type CandidateMove } from '../api/client'
import { gameOverAt, pathToNode, turnAt, type Tree } from '../lib/analysisTree'

// How many candidate rows to request/show. The engine ranks best-first.
const MAX_ROWS = 8
// Per-call search budget (ms). Short enough to feel live as you click around.
const MOVETIME = 350

// Lichess "winning chances": the same sigmoid the vertical EvalBar uses, so a
// per-move bar reads consistently with the main eval bar. Input is WHITE-relative
// centipawns; output is White's share of the bar (0..100).
function whiteWinPercent(type: 'cp' | 'mate', white: number): number {
    if (type === 'mate') return white > 0 ? 100 : white < 0 ? 0 : 50
    const cp = Math.max(-1000, Math.min(1000, white))
    return 50 + 50 * (2 / (1 + Math.exp(-0.00368208 * cp)) - 1)
}

// "+1.8" / "-0.5" / "#3" / "-#2", from White's perspective.
function evalText(type: 'cp' | 'mate', white: number): string {
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
    }, [engineOn, over, fen, history])

    // stale = the viewed position changed but its response hasn't arrived yet.
    return { data, loading, stale: dataFen !== fen }
}

/**
 * The opening explorer panel: the line's opening name (engine-classified) over a
 * list of candidate moves, each with a per-move eval bar. Everything chess here is
 * computed by the engine (`/candidates`); this component only renders and lets you
 * click a move to play it into the tree.
 */
export default function OpeningPanel({
    tree,
    currentId,
    engineOn,
    onMove,
}: {
    tree: Tree
    currentId: number
    engineOn: boolean
    onMove: (uci: string) => void
}) {
    const { data, loading, stale } = useCandidates(tree, currentId, engineOn)
    const node = tree.nodes[currentId] ?? tree.nodes[tree.rootId]
    const stm = turnAt(node)
    // At the root (no moves played) the position simply isn't a named opening yet —
    // it's the starting position, NOT "out of book".
    const atStart = (node?.ply ?? 0) === 0

    if (!engineOn) return null

    const opening = data?.opening ?? null
    // Only render bars for the CURRENT position — never another position's evals
    // (re-flipping a stale move's score by the new side-to-move makes every bar
    // jump to a wrong value during the load gap).
    const moves = stale ? [] : (data?.moves ?? [])
    const busy = loading || stale

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
                    background:
                        'linear-gradient(180deg, rgba(216,166,87,0.05), rgba(216,166,87,0) 70%), var(--bg-2)',
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
                                borderRadius: '5px',
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
                        {atStart ? 'Starting position' : busy ? 'Exploring…' : 'Out of book'}
                    </Typography>
                )}
            </Box>

            {/* Candidate moves with per-move eval bars */}
            <Box sx={{ px: 1, pb: 1, display: 'flex', flexDirection: 'column', gap: 0.25 }}>
                {moves.length === 0 ? (
                    <Typography
                        sx={{ fontSize: 12, color: 'var(--muted)', fontStyle: 'italic', px: 0.5, py: 0.75 }}
                    >
                        {busy ? 'Exploring moves…' : 'No moves'}
                    </Typography>
                ) : (
                    moves.map((m) => <MoveRow key={m.uci} move={m} stm={stm} onPlay={() => onMove(m.uci)} />)
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
}: {
    move: CandidateMove
    stm: 'w' | 'b'
    onPlay: () => void
}) {
    const white = stm === 'w' ? move.eval.value : -move.eval.value
    const whitePct = whiteWinPercent(move.eval.type, white)
    const text = evalText(move.eval.type, white)
    const whiteBetter = white > 0

    return (
        <Box
            role="button"
            onClick={onPlay}
            sx={{
                display: 'grid',
                gridTemplateColumns: '46px 1fr 48px',
                alignItems: 'center',
                gap: 1,
                px: 0.5,
                py: 0.5,
                borderRadius: '6px',
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
                {move.san}
            </Typography>

            {/* Eval bar: cream (White) grows from the left over a dark (Black) track. */}
            <Box
                sx={{
                    position: 'relative',
                    height: 10,
                    borderRadius: '3px',
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
                        background: 'linear-gradient(90deg, #f3eee2, #e4dccb)',
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
    )
}
