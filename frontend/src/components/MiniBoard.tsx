import { Box } from '@mui/material'
import { parseFen, pieceImageUrl, squareAt } from '../lib/chess'
import type { Color } from '../api/client'

/** A small, non-interactive board rendered from a FEN — for Watch previews.
 * Always drawn from White's perspective with an optional last-move highlight. */
export default function MiniBoard({
    fen,
    lastMove,
    orientation = 'w',
}: {
    fen: string
    lastMove?: string // UCI; the from/to squares are tinted
    orientation?: Color
}) {
    const board = parseFen(fen)
    const from = lastMove && lastMove.length >= 4 ? lastMove.slice(0, 2) : null
    const to = lastMove && lastMove.length >= 4 ? lastMove.slice(2, 4) : null
    const ranks = orientation === 'w' ? [7, 6, 5, 4, 3, 2, 1, 0] : [0, 1, 2, 3, 4, 5, 6, 7]
    const files = orientation === 'w' ? [0, 1, 2, 3, 4, 5, 6, 7] : [7, 6, 5, 4, 3, 2, 1, 0]

    return (
        <Box
            sx={{
                display: 'grid',
                gridTemplateColumns: 'repeat(8, 1fr)',
                gridTemplateRows: 'repeat(8, 1fr)',
                aspectRatio: '1',
                width: '100%',
                borderRadius: '8px',
                overflow: 'hidden',
            }}
        >
            {ranks.map((rank) =>
                files.map((file) => {
                    const sq = squareAt(file, rank)
                    const piece = board[sq]
                    const light = (file + rank) % 2 === 1
                    const highlight = sq === from || sq === to
                    return (
                        <Box
                            key={sq}
                            sx={{
                                position: 'relative',
                                background: light ? 'var(--board-light)' : 'var(--board-dark)',
                                ...(piece
                                    ? {
                                          backgroundImage: `url(${pieceImageUrl(piece)})`,
                                          backgroundRepeat: 'no-repeat',
                                          backgroundPosition: 'center',
                                          backgroundSize: '86%',
                                      }
                                    : {}),
                                ...(highlight
                                    ? {
                                          '&::after': {
                                              content: '""',
                                              position: 'absolute',
                                              inset: 0,
                                              background: 'var(--last-move)',
                                          },
                                      }
                                    : {}),
                            }}
                        />
                    )
                }),
            )}
        </Box>
    )
}
