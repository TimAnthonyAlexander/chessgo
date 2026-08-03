import { useCallback, useMemo, useState } from 'react'
import { Box, Tooltip, Typography } from '@mui/material'
import {
    ChevronFirst,
    ChevronLast,
    ChevronLeft,
    ChevronRight,
    FlipVertical2,
    Target,
} from 'lucide-react'
import type { Color, GameAnalysis, MoveEntry } from '../../../api/client'
import Board from '../../Board'
import EvalBar from '../../EvalBar'
import MoveList from '../../MoveList'
import { MoveSan } from '../../MoveSan'
import { useMoveNavKeys } from '../../../lib/useMoveNavKeys'
import { JUDGMENT_COLOR, JUDGMENT_GLYPH } from './shared'

const ARROW = '#d8a657'

/** A self-contained move-by-move reviewer built on the app's own board stack
 * (`Board` + `MoveList` + `EvalBar`), driven by a cached `GameAnalysis`. Each ply
 * shows the position, the engine's best-move arrow, the eval, and the judgment of
 * the move that reached it — the raw evidence behind an engine-correlation flag. */
export default function GameReviewBoard({
    analysis,
    flaggedColor,
}: {
    analysis: GameAnalysis
    flaggedColor?: Color | null
}) {
    const plies = analysis.plies
    const last = Math.max(0, plies.length - 1)
    const [ply, setPly] = useState(0)
    const [orientation, setOrientation] = useState<Color>(flaggedColor ?? 'w')
    const [showArrow, setShowArrow] = useState(true)

    const moves: MoveEntry[] = useMemo(() => {
        const out: MoveEntry[] = []
        for (let k = 0; k < plies.length; k++) {
            const m = plies[k].move
            if (!m) continue
            out.push({
                ply: k + 1,
                uci: m.uci,
                san: m.san,
                by: 'human',
                fen: plies[k + 1]?.fen ?? plies[k].fen,
            })
        }
        return out
    }, [plies])

    const goFirst = useCallback(() => setPly(0), [])
    const goPrev = useCallback(() => setPly((p) => Math.max(0, p - 1)), [])
    const goNext = useCallback(() => setPly((p) => Math.min(last, p + 1)), [last])
    const goLast = useCallback(() => setPly(last), [last])
    useMoveNavKeys({ onPrev: goPrev, onNext: goNext, onFirst: goFirst, onLast: goLast })

    if (plies.length === 0) {
        return (
            <Typography sx={{ fontSize: 13, color: 'var(--muted)' }}>
                {analysis.unsupported
                    ? 'Move-by-move analysis is not available for this variant.'
                    : 'No analysed positions for this game.'}
            </Typography>
        )
    }

    const cur = plies[ply]
    const prevMove = ply > 0 ? plies[ply - 1].move : undefined
    const lastMove =
        prevMove && prevMove.uci.length >= 4
            ? { from: prevMove.uci.slice(0, 2), to: prevMove.uci.slice(2, 4) }
            : null
    const arrow =
        showArrow && cur.bestUci && cur.bestUci.length >= 4
            ? {
                  from: cur.bestUci.slice(0, 2),
                  to: cur.bestUci.slice(2, 4),
                  color: ARROW,
              }
            : null

    return (
        <Box
            sx={{
                display: 'grid',
                gap: 1.5,
                gridTemplateColumns: { xs: '1fr', md: 'minmax(0, 1fr) 272px' },
                alignItems: 'start',
            }}
        >
            {/* Board + eval bar */}
            <Box sx={{ maxWidth: 460, width: '100%', mx: { xs: 'auto', md: 0 } }}>
                <Box sx={{ display: 'flex', alignItems: 'stretch', gap: 1 }}>
                    <EvalBar ev={cur.evalWhite} orientation={orientation} />
                    <Box sx={{ flex: 1, minWidth: 0 }}>
                        <Board
                            fen={cur.fen}
                            orientation={orientation}
                            sideToMove={cur.sideToMove}
                            legalMoves={[]}
                            lastMove={lastMove}
                            interactive={false}
                            onMove={() => {}}
                            arrow={arrow}
                        />
                    </Box>
                </Box>
            </Box>

            {/* Move list + judgment + controls */}
            <Box
                sx={{
                    display: 'flex',
                    flexDirection: 'column',
                    border: '1px solid var(--line-soft)',
                    borderRadius: '12px',
                    bgcolor: 'var(--surface)',
                    overflow: 'hidden',
                }}
            >
                <JudgmentBar move={prevMove ?? null} ply={ply} />
                <Box sx={{ borderTop: '1px solid var(--line-soft)' }}>
                    <MoveList moves={moves} currentPly={ply} onSelectPly={setPly} visibleRows={12} />
                </Box>
                <Box
                    sx={{
                        display: 'flex',
                        alignItems: 'center',
                        gap: 0.5,
                        p: 1,
                        borderTop: '1px solid var(--line-soft)',
                        bgcolor: 'var(--bg-2)',
                    }}
                >
                    <NavBtn label="Start" onClick={goFirst} disabled={ply === 0}>
                        <ChevronFirst size={19} />
                    </NavBtn>
                    <NavBtn label="Previous" onClick={goPrev} disabled={ply === 0}>
                        <ChevronLeft size={19} />
                    </NavBtn>
                    <NavBtn label="Next" onClick={goNext} disabled={ply === last}>
                        <ChevronRight size={19} />
                    </NavBtn>
                    <NavBtn label="End" onClick={goLast} disabled={ply === last}>
                        <ChevronLast size={19} />
                    </NavBtn>
                    <Box sx={{ width: '1px', height: 22, bgcolor: 'var(--line)', mx: 0.25 }} />
                    <NavBtn
                        label="Best-move arrow"
                        onClick={() => setShowArrow((v) => !v)}
                        active={showArrow}
                    >
                        <Target size={17} />
                    </NavBtn>
                    <NavBtn
                        label="Flip board"
                        onClick={() => setOrientation((o) => (o === 'w' ? 'b' : 'w'))}
                    >
                        <FlipVertical2 size={17} />
                    </NavBtn>
                </Box>
            </Box>
        </Box>
    )
}

/** The judgment of the move that reached the current position (blunder/mistake/…),
 * with its centipawn loss — the per-move signal an engine-correlation review reads. */
function JudgmentBar({
    move,
    ply,
}: {
    move: GameAnalysis['plies'][number]['move'] | null
    ply: number
}) {
    if (!move || ply === 0) {
        return (
            <Box sx={{ px: 1.25, py: 1 }}>
                <Typography sx={{ fontSize: 11.5, color: 'var(--muted)' }}>
                    Start position
                </Typography>
            </Box>
        )
    }
    const color = JUDGMENT_COLOR[move.judgment] ?? 'var(--text)'
    const glyph = JUDGMENT_GLYPH[move.judgment] ?? ''
    return (
        <Box sx={{ display: 'flex', alignItems: 'center', gap: 1, px: 1.25, py: 1 }}>
            <Typography
                sx={{
                    fontFamily: 'var(--font-mono)',
                    fontSize: 15,
                    fontWeight: 700,
                    color,
                }}
            >
                <MoveSan san={move.san} />
                {glyph}
            </Typography>
            <Typography
                sx={{
                    fontSize: 11,
                    fontWeight: 700,
                    letterSpacing: '0.05em',
                    textTransform: 'uppercase',
                    color,
                }}
            >
                {move.judgment}
            </Typography>
            {move.cpLoss > 0 && (
                <Typography
                    sx={{
                        ml: 'auto',
                        fontFamily: 'var(--font-mono)',
                        fontSize: 11.5,
                        color: 'var(--text-dim)',
                    }}
                >
                    −{(move.cpLoss / 100).toFixed(2)}
                </Typography>
            )}
        </Box>
    )
}

function NavBtn({
    label,
    onClick,
    disabled,
    active,
    children,
}: {
    label: string
    onClick: () => void
    disabled?: boolean
    active?: boolean
    children: React.ReactNode
}) {
    return (
        <Tooltip arrow title={label}>
            <Box
                component="button"
                onClick={onClick}
                disabled={disabled}
                sx={{
                    appearance: 'none',
                    flex: 1,
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'center',
                    py: 0.75,
                    borderRadius: '7px',
                    border: '1px solid',
                    borderColor: active ? 'var(--accent-line)' : 'transparent',
                    bgcolor: active ? 'var(--accent-soft)' : 'transparent',
                    color: active ? 'var(--accent)' : 'var(--text-dim)',
                    cursor: disabled ? 'default' : 'pointer',
                    opacity: disabled ? 0.35 : 1,
                    transition: 'background .1s ease, color .1s ease',
                    '&:hover': disabled
                        ? undefined
                        : { bgcolor: active ? undefined : 'rgba(255,255,255,0.05)' },
                }}
            >
                {children}
            </Box>
        </Tooltip>
    )
}
