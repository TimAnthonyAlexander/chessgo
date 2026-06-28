import { type PointerEvent as ReactPointerEvent, useRef, useState } from 'react'
import { Box } from '@mui/material'
import { MousePointer2, Trash2 } from 'lucide-react'
import './Board.css'
import './BoardEditor.css'
import type { Color } from '../api/client'
import { type BoardMap, type Square, parseFen, pieceImageUrl, squareAt } from '../lib/chess'
import { withMovedPiece, withPiece } from '../lib/fenEdit'

// The active "brush": a piece to stamp, the eraser, or null (move/drag mode).
export type Brush = { kind: 'piece'; piece: string } | { kind: 'erase' } | null

const DRAG_THRESHOLD = 5

interface DragState {
    from: Square
    piece: string
    startX: number
    startY: number
    x: number
    y: number
    over: Square | null
    size: number
    moved: boolean
}

/**
 * A free-placement board editor (board only — the spare-piece palette lives in
 * the page sidebar so the board itself fits the viewport). Two interaction
 * models, Lichess-style:
 *  • pick a piece (or the eraser) brush, then left-click / drag-paint squares;
 *  • with no brush (the pointer tool), drag a piece between squares — or off the
 *    board to remove it.
 * Right-clicking any square always clears it. It owns no FEN state: every edit is
 * emitted via `onChange(newFen)`.
 */
export default function BoardEditor({
    fen,
    orientation,
    brush,
    onChange,
}: {
    fen: string
    orientation: Color
    brush: Brush
    onChange: (fen: string) => void
}) {
    const boardRef = useRef<HTMLDivElement>(null)
    const [drag, setDrag] = useState<DragState | null>(null)
    // While a paint stroke is held, remember the last square we touched so a drag
    // across the board doesn't re-stamp the same square on every pointer event.
    const painting = useRef<{ brush: Brush; last: Square | null } | null>(null)

    const board: BoardMap = parseFen(fen)
    const ranks = orientation === 'w' ? [7, 6, 5, 4, 3, 2, 1, 0] : [0, 1, 2, 3, 4, 5, 6, 7]
    const files = orientation === 'w' ? [0, 1, 2, 3, 4, 5, 6, 7] : [7, 6, 5, 4, 3, 2, 1, 0]

    function squareFromPoint(cx: number, cy: number): Square | null {
        const el = boardRef.current
        if (!el) return null
        const r = el.getBoundingClientRect()
        if (cx < r.left || cx > r.right || cy < r.top || cy > r.bottom) return null
        const col = Math.min(7, Math.max(0, Math.floor((cx - r.left) / (r.width / 8))))
        const row = Math.min(7, Math.max(0, Math.floor((cy - r.top) / (r.height / 8))))
        const file = orientation === 'w' ? col : 7 - col
        const rank = orientation === 'w' ? 7 - row : row
        return squareAt(file, rank)
    }

    // Apply the current brush to a square (place or erase), de-duped per stroke.
    function paint(sq: Square, b: Brush) {
        if (!b) return
        if (painting.current && painting.current.last === sq) return
        if (painting.current) painting.current.last = sq
        onChange(withPiece(fen, sq, b.kind === 'piece' ? b.piece : null))
    }

    function onPointerDown(e: ReactPointerEvent<HTMLDivElement>) {
        if (e.button === 2) return // right-click is handled by onContextMenu (erase)
        const sq = squareFromPoint(e.clientX, e.clientY)
        if (!sq) return
        e.preventDefault()
        try {
            boardRef.current?.setPointerCapture(e.pointerId)
        } catch {
            /* ignore */
        }

        if (brush) {
            // Brush mode: stamp/erase, and arm a paint stroke for drag-fill.
            painting.current = { brush, last: null }
            paint(sq, brush)
            return
        }
        // Pointer mode: begin dragging the piece under the cursor (if any).
        const piece = board[sq]
        if (!piece) return
        const size = (boardRef.current?.getBoundingClientRect().width ?? 0) / 8
        setDrag({
            from: sq,
            piece,
            startX: e.clientX,
            startY: e.clientY,
            x: e.clientX,
            y: e.clientY,
            over: sq,
            size,
            moved: false,
        })
    }

    function onPointerMove(e: ReactPointerEvent<HTMLDivElement>) {
        if (painting.current) {
            const sq = squareFromPoint(e.clientX, e.clientY)
            if (sq) paint(sq, painting.current.brush)
            return
        }
        if (!drag) return
        const moved =
            drag.moved ||
            Math.hypot(e.clientX - drag.startX, e.clientY - drag.startY) > DRAG_THRESHOLD
        setDrag({
            ...drag,
            x: e.clientX,
            y: e.clientY,
            over: squareFromPoint(e.clientX, e.clientY),
            moved,
        })
    }

    function onPointerUp(e: ReactPointerEvent<HTMLDivElement>) {
        try {
            boardRef.current?.releasePointerCapture(e.pointerId)
        } catch {
            /* ignore */
        }
        if (painting.current) {
            painting.current = null
            return
        }
        if (!drag) return
        const d = drag
        setDrag(null)
        if (!d.moved) return // a plain click in pointer mode — leave the piece be
        const dropSq = squareFromPoint(e.clientX, e.clientY)
        if (dropSq) onChange(withMovedPiece(fen, d.from, dropSq))
        else onChange(withPiece(fen, d.from, null)) // dropped off-board → remove
    }

    function onContextMenu(e: ReactPointerEvent<HTMLDivElement>) {
        e.preventDefault() // suppress the browser menu; right-click clears a square
        const sq = squareFromPoint(e.clientX, e.clientY)
        if (sq && board[sq]) onChange(withPiece(fen, sq, null))
    }

    return (
        <div className="board-wrap">
            <div
                ref={boardRef}
                className={`board editor${brush ? ' brushing' : ''}${drag?.moved ? ' dragging' : ''}`}
                onPointerDown={onPointerDown}
                onPointerMove={onPointerMove}
                onPointerUp={onPointerUp}
                onPointerCancel={() => {
                    painting.current = null
                    setDrag(null)
                }}
                onContextMenu={onContextMenu}
            >
                {ranks.map((rank) =>
                    files.map((file) => {
                        const sq = squareAt(file, rank)
                        const piece = board[sq]
                        const light = (file + rank) % 2 === 1
                        const isDragOrigin = drag?.moved && drag.from === sq
                        const isOver = drag?.moved && drag.over === sq
                        const showFile = orientation === 'w' ? rank === 0 : rank === 7
                        const showRank = orientation === 'w' ? file === 0 : file === 7
                        const classes = ['sq', light ? 'light' : 'dark', isOver ? 'over' : '']
                            .filter(Boolean)
                            .join(' ')
                        return (
                            <div key={sq} className={classes}>
                                {piece && (
                                    <span
                                        className="piece"
                                        style={{
                                            backgroundImage: `url(${pieceImageUrl(piece)})`,
                                            ...(isDragOrigin ? { opacity: 0 } : {}),
                                        }}
                                    />
                                )}
                                {showRank && <span className="coord rank">{rank + 1}</span>}
                                {showFile && <span className="coord file">{'abcdefgh'[file]}</span>}
                            </div>
                        )
                    }),
                )}
            </div>

            {drag?.moved && (
                <span
                    className="drag-ghost"
                    style={{
                        left: drag.x,
                        top: drag.y,
                        width: drag.size,
                        height: drag.size,
                        backgroundImage: `url(${pieceImageUrl(drag.piece)})`,
                    }}
                />
            )}
        </div>
    )
}

const WHITE_PIECES = ['K', 'Q', 'R', 'B', 'N', 'P']
const BLACK_PIECES = ['k', 'q', 'r', 'b', 'n', 'p']

/**
 * Compact spare-piece palette for the sidebar: white row, black row, then the
 * eraser + pointer tools. Click a piece to arm it as the brush; click again (or
 * the pointer tool) to return to move/drag mode.
 */
export function EditorPalette({ brush, onPick }: { brush: Brush; onPick: (b: Brush) => void }) {
    const activePiece = (p: string) => brush?.kind === 'piece' && brush.piece === p
    return (
        <Box>
            <PaletteRow pieces={WHITE_PIECES} activePiece={activePiece} onPick={onPick} />
            <PaletteRow pieces={BLACK_PIECES} activePiece={activePiece} onPick={onPick} />
            <div className="editor-palette tools">
                <button
                    type="button"
                    aria-label="Eraser"
                    className={`pal-cell tool${brush?.kind === 'erase' ? ' active' : ''}`}
                    onClick={() => onPick(brush?.kind === 'erase' ? null : { kind: 'erase' })}
                >
                    <Trash2 size={16} />
                </button>
                <button
                    type="button"
                    aria-label="Move pieces"
                    className={`pal-cell tool${brush === null ? ' active' : ''}`}
                    onClick={() => onPick(null)}
                >
                    <MousePointer2 size={16} />
                </button>
            </div>
        </Box>
    )
}

function PaletteRow({
    pieces,
    activePiece,
    onPick,
}: {
    pieces: string[]
    activePiece: (p: string) => boolean
    onPick: (b: Brush) => void
}) {
    return (
        <div className="editor-palette">
            {pieces.map((p) => (
                <button
                    key={p}
                    type="button"
                    aria-label={`Place ${p}`}
                    className={`pal-cell${activePiece(p) ? ' active' : ''}`}
                    onClick={() => onPick(activePiece(p) ? null : { kind: 'piece', piece: p })}
                >
                    <span
                        className="piece"
                        style={{ backgroundImage: `url(${pieceImageUrl(p)})` }}
                    />
                </button>
            ))}
        </div>
    )
}
