import { type PointerEvent as ReactPointerEvent, useRef, useState } from 'react'
import './Board.css'
import type { Color } from '../api/client'
import {
  type BoardMap,
  type Square,
  fileOf,
  isWhitePiece,
  kingSquare,
  parseFen,
  pieceImageUrl,
  premoveTargets,
  promotionsFor,
  rankOf,
  squareAt,
  targetsFrom,
} from '../lib/chess'

function PieceGlyph({ piece, hidden }: { piece: string; hidden?: boolean }) {
  return (
    <span
      className="piece"
      style={{ backgroundImage: `url(${pieceImageUrl(piece)})`, ...(hidden ? { opacity: 0 } : {}) }}
    />
  )
}

interface BoardProps {
  fen: string
  orientation: Color
  sideToMove: Color
  legalMoves: string[]
  lastMove: { from: Square; to: Square } | null
  inCheck: boolean
  interactive: boolean
  onMove: (uci: string) => void
  /** Optional display-only board override for optimistic move feedback. */
  overrideBoard?: BoardMap
  /** Optional move arrow (e.g. the engine's best move) drawn over the board. */
  arrow?: { from: Square; to: Square } | null
  /** The local player's own color — enables premove input while it isn't their
   * turn (i.e. while `interactive` is false). Omit/null to disable premoves. */
  premoveColor?: Color | null
  /** A queued premove to highlight (from + to). */
  premove?: { from: Square; to: Square } | null
  /** Discard the queued premove (user clicked an empty / invalid square). */
  onCancelPremove?: () => void
}

const PROMO_ORDER = ['q', 'r', 'b', 'n']
const DRAG_THRESHOLD = 5 // px before a press becomes a drag

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
  reselect: boolean
}

export default function Board({
  fen,
  orientation,
  sideToMove,
  legalMoves,
  lastMove,
  inCheck,
  interactive,
  onMove,
  overrideBoard,
  arrow,
  premoveColor,
  premove,
  onCancelPremove,
}: BoardProps) {
  const boardRef = useRef<HTMLDivElement>(null)
  const [selected, setSelected] = useState<Square | null>(null)
  const [promo, setPromo] = useState<{ from: Square; to: Square; options: string[] } | null>(null)
  const [drag, setDrag] = useState<DragState | null>(null)

  const board: BoardMap = overrideBoard ?? parseFen(fen)

  // Premove mode: while it isn't our turn but we're a player, we let the user
  // queue a move. Inputs come from the same handlers; the only differences are
  // which pieces are "ours" (our color, not the side to move) and which targets
  // are valid (piece geometry, since the real legal-move list isn't ours yet).
  const premoveActive = !interactive && premoveColor != null
  const inputEnabled = interactive || premoveActive
  const movingColor: Color = interactive ? sideToMove : (premoveColor ?? sideToMove)
  const destsFor = (from: Square): Set<Square> =>
    interactive ? targetsFrom(legalMoves, from) : premoveTargets(board, from)

  const targets = selected ? destsFor(selected) : new Set<Square>()
  const checkKing = inCheck ? kingSquare(board, sideToMove === 'w') : null

  // Arrow geometry in an 80×80 coordinate space (10 units / square), oriented.
  const arrowGeom = (() => {
    if (!arrow) return null
    const center = (sq: Square) => {
      const col = orientation === 'w' ? fileOf(sq) : 7 - fileOf(sq)
      const row = orientation === 'w' ? 7 - rankOf(sq) : rankOf(sq)
      return { x: col * 10 + 5, y: row * 10 + 5 }
    }
    return { a: center(arrow.from), b: center(arrow.to) }
  })()

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

  function ownPieceAt(sq: Square): boolean {
    const p = board[sq]
    return !!p && (isWhitePiece(p) ? 'w' : 'b') === movingColor
  }

  function commit(from: Square, to: Square) {
    if (interactive) {
      const options = promotionsFor(legalMoves, from, to)
      if (options.length > 0) {
        setPromo({ from, to, options })
        return
      }
      setSelected(null)
      onMove(from + to)
      return
    }
    // Premove: auto-queen a promoting pawn (Chess.com-style — no picker mid-premove).
    const piece = board[from]?.toLowerCase()
    const promoting = piece === 'p' && (to[1] === '8' || to[1] === '1')
    setSelected(null)
    onMove(from + to + (promoting ? 'q' : ''))
  }

  function onPointerDown(e: ReactPointerEvent<HTMLDivElement>) {
    if (!inputEnabled || promo) return
    const sq = squareFromPoint(e.clientX, e.clientY)
    if (!sq) return

    if (ownPieceAt(sq)) {
      e.preventDefault()
      const size = (boardRef.current?.getBoundingClientRect().width ?? 0) / 8
      try {
        boardRef.current?.setPointerCapture(e.pointerId)
      } catch {
        /* ignore */
      }
      setDrag({
        from: sq,
        piece: board[sq],
        startX: e.clientX,
        startY: e.clientY,
        x: e.clientX,
        y: e.clientY,
        over: sq,
        size,
        moved: false,
        reselect: selected === sq,
      })
      setSelected(sq)
    } else if (selected && targets.has(sq)) {
      commit(selected, sq)
    } else {
      setSelected(null)
      if (premoveActive) onCancelPremove?.() // tapped empty/elsewhere → drop the premove
    }
  }

  function onPointerMove(e: ReactPointerEvent<HTMLDivElement>) {
    if (!drag) return
    const moved = drag.moved || Math.hypot(e.clientX - drag.startX, e.clientY - drag.startY) > DRAG_THRESHOLD
    setDrag({ ...drag, x: e.clientX, y: e.clientY, over: squareFromPoint(e.clientX, e.clientY), moved })
  }

  function onPointerUp(e: ReactPointerEvent<HTMLDivElement>) {
    if (!drag) return
    const d = drag
    setDrag(null)
    try {
      boardRef.current?.releasePointerCapture(e.pointerId)
    } catch {
      /* ignore */
    }

    if (d.moved) {
      const dropSq = squareFromPoint(e.clientX, e.clientY)
      if (dropSq && destsFor(d.from).has(dropSq)) {
        commit(d.from, dropSq)
      } else {
        setSelected(null) // failed drag → deselect
        if (premoveActive) onCancelPremove?.()
      }
    } else if (d.reselect) {
      setSelected(null) // tapped an already-selected piece → toggle off
    }
    // else: a plain tap that selected the piece — keep it selected (dots shown)
  }

  function choosePromotion(letter: string) {
    if (!promo) return
    const { from, to } = promo
    setPromo(null)
    setSelected(null)
    onMove(from + to + letter)
  }

  return (
    <div className="board-wrap">
      <div
        ref={boardRef}
        className={`board${drag?.moved ? ' dragging' : ''}`}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerCancel={() => setDrag(null)}
      >
        {ranks.map((rank) =>
          files.map((file) => {
            const sq = squareAt(file, rank)
            const piece = board[sq]
            const light = (file + rank) % 2 === 1
            const isTarget = targets.has(sq)
            const isLast = lastMove && (lastMove.from === sq || lastMove.to === sq)
            const isPremove = premove && (premove.from === sq || premove.to === sq)
            const isDragOrigin = drag?.moved && drag.from === sq
            const isOver = drag?.moved && drag.over === sq && destsFor(drag.from).has(sq)
            const classes = [
              'sq',
              light ? 'light' : 'dark',
              inputEnabled ? 'interactive' : '',
              selected === sq ? 'sel' : '',
              isLast ? 'last' : '',
              isPremove ? 'premove' : '',
              isOver ? 'over' : '',
              checkKing === sq ? 'check' : '',
            ]
              .filter(Boolean)
              .join(' ')

            const showFile = orientation === 'w' ? rank === 0 : rank === 7
            const showRank = orientation === 'w' ? file === 0 : file === 7

            return (
              <div key={sq} className={classes}>
                {isTarget && !piece && <span className="dot" />}
                {isTarget && piece && <span className="ring" />}
                {piece && <PieceGlyph piece={piece} hidden={isDragOrigin} />}
                {showRank && <span className="coord rank">{rank + 1}</span>}
                {showFile && <span className="coord file">{'abcdefgh'[file]}</span>}
              </div>
            )
          }),
        )}

        {arrowGeom && (
          <svg
            className="board-arrow"
            viewBox="0 0 80 80"
            preserveAspectRatio="none"
            style={{ position: 'absolute', inset: 0, width: '100%', height: '100%', pointerEvents: 'none', zIndex: 5 }}
          >
            <defs>
              <marker id="bm-head" markerWidth="4" markerHeight="4" refX="2.6" refY="2" orient="auto">
                <path d="M0,0 L4,2 L0,4 z" fill="var(--accent)" />
              </marker>
            </defs>
            <line
              x1={arrowGeom.a.x}
              y1={arrowGeom.a.y}
              x2={arrowGeom.b.x}
              y2={arrowGeom.b.y}
              stroke="var(--accent)"
              strokeWidth={1.7}
              strokeLinecap="round"
              markerEnd="url(#bm-head)"
              opacity={0.7}
            />
          </svg>
        )}

        {promo && (
          <div className="promo-backdrop" onPointerDown={() => setPromo(null)}>
            <div className="promo" onPointerDown={(e) => e.stopPropagation()}>
              {PROMO_ORDER.filter((p) => promo.options.includes(p)).map((p) => (
                <button key={p} onClick={() => choosePromotion(p)} aria-label={`Promote to ${p}`}>
                  <PieceGlyph piece={sideToMove === 'w' ? p.toUpperCase() : p} />
                </button>
              ))}
            </div>
          </div>
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
