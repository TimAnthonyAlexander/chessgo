import { useState } from 'react'
import './Board.css'
import type { Color } from '../api/client'
import {
  type BoardMap,
  type Square,
  glyphFor,
  isWhitePiece,
  kingSquare,
  parseFen,
  promotionsFor,
  squareAt,
  targetsFrom,
} from '../lib/chess'

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
}

const PROMO_ORDER = ['q', 'r', 'b', 'n']

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
}: BoardProps) {
  const [selected, setSelected] = useState<Square | null>(null)
  const [promo, setPromo] = useState<{ from: Square; to: Square; options: string[] } | null>(null)

  const board: BoardMap = overrideBoard ?? parseFen(fen)
  const targets = selected ? targetsFrom(legalMoves, selected) : new Set<Square>()
  const checkKing = inCheck ? kingSquare(board, sideToMove === 'w') : null

  const ranks = orientation === 'w' ? [7, 6, 5, 4, 3, 2, 1, 0] : [0, 1, 2, 3, 4, 5, 6, 7]
  const files = orientation === 'w' ? [0, 1, 2, 3, 4, 5, 6, 7] : [7, 6, 5, 4, 3, 2, 1, 0]

  function commit(from: Square, to: Square) {
    const options = promotionsFor(legalMoves, from, to)
    if (options.length > 0) {
      setPromo({ from, to, options })
      return
    }
    setSelected(null)
    onMove(from + to)
  }

  function onSquareClick(sq: Square) {
    if (!interactive || promo) return
    const piece = board[sq]

    if (selected) {
      if (targets.has(sq)) {
        commit(selected, sq)
        return
      }
      // Re-select another of our own pieces, else clear.
      if (piece && (isWhitePiece(piece) ? 'w' : 'b') === sideToMove) {
        setSelected(sq)
      } else {
        setSelected(null)
      }
      return
    }

    if (piece && (isWhitePiece(piece) ? 'w' : 'b') === sideToMove) {
      setSelected(sq)
    }
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
      <div className="board">
        {ranks.map((rank) =>
          files.map((file) => {
            const sq = squareAt(file, rank)
            const piece = board[sq]
            const light = (file + rank) % 2 === 1
            const isTarget = targets.has(sq)
            const isLast = lastMove && (lastMove.from === sq || lastMove.to === sq)
            const classes = [
              'sq',
              light ? 'light' : 'dark',
              interactive ? 'interactive' : '',
              selected === sq ? 'sel' : '',
              isLast ? 'last' : '',
              checkKing === sq ? 'check' : '',
            ]
              .filter(Boolean)
              .join(' ')

            const showFile = orientation === 'w' ? rank === 0 : rank === 7
            const showRank = orientation === 'w' ? file === 0 : file === 7

            return (
              <div key={sq} className={classes} onClick={() => onSquareClick(sq)}>
                {isTarget && !piece && <span className="dot" />}
                {isTarget && piece && <span className="ring" />}
                {piece && (
                  <span className={`piece ${isWhitePiece(piece) ? 'white' : 'black'}`}>
                    {glyphFor(piece)}
                  </span>
                )}
                {showRank && <span className="coord rank">{rank + 1}</span>}
                {showFile && <span className="coord file">{'abcdefgh'[file]}</span>}
              </div>
            )
          }),
        )}

        {promo && (
          <div className="promo-backdrop" onClick={() => setPromo(null)}>
            <div className="promo" onClick={(e) => e.stopPropagation()}>
              {PROMO_ORDER.filter((p) => promo.options.includes(p)).map((p) => (
                <button key={p} onClick={() => choosePromotion(p)} aria-label={`Promote to ${p}`}>
                  {glyphFor(sideToMove === 'w' ? p.toUpperCase() : p)}
                </button>
              ))}
            </div>
          </div>
        )}
      </div>
    </div>
  )
}
