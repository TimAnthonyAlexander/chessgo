import { memo } from 'react'
import { parseFen, pieceImageUrl, squareAt } from '../lib/chess'
import { usePieceSet } from '../lib/boardTheme'
import type { Color } from '../api/client'

/** A small, non-interactive board rendered from a FEN — for Watch previews.
 * Always drawn from White's perspective with an optional last-move highlight.
 *
 * Memoized (React.memo): consumers re-render it on a ~250ms tick, but its
 * fen/lastMove props are stable between ticks, so the 64-cell grid only rebuilds
 * when the position actually changes. Squares are plain <div>s + static CSS
 * classes (see styles.css) rather than emotion-styled MUI Boxes. */
function MiniBoard({
    fen,
    lastMove,
    orientation = 'w',
}: {
    fen: string
    lastMove?: string // UCI; the from/to squares are tinted
    orientation?: Color
}) {
    const board = parseFen(fen)
    const pieceSet = usePieceSet() // repaint when the piece theme changes
    const from = lastMove && lastMove.length >= 4 ? lastMove.slice(0, 2) : null
    const to = lastMove && lastMove.length >= 4 ? lastMove.slice(2, 4) : null
    const ranks = orientation === 'w' ? [7, 6, 5, 4, 3, 2, 1, 0] : [0, 1, 2, 3, 4, 5, 6, 7]
    const files = orientation === 'w' ? [0, 1, 2, 3, 4, 5, 6, 7] : [7, 6, 5, 4, 3, 2, 1, 0]

    return (
        <div className="mini-board">
            {ranks.map((rank) =>
                files.map((file) => {
                    const sq = squareAt(file, rank)
                    const piece = board[sq]
                    const light = (file + rank) % 2 === 1
                    const highlight = sq === from || sq === to
                    return (
                        <div key={sq} className={`mini-sq ${light ? 'light' : 'dark'}`}>
                            {/* Piece + highlight are overlays so they never replace
                             * the square's own background (texture must survive). */}
                            {highlight && <div className="mini-highlight" />}
                            {piece && (
                                <div
                                    className="mini-piece"
                                    style={{
                                        backgroundImage: `url(${pieceImageUrl(piece, pieceSet)})`,
                                    }}
                                />
                            )}
                        </div>
                    )
                }),
            )}
        </div>
    )
}

export default memo(MiniBoard)
