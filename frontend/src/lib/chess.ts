// Lightweight, display-only chess helpers. The gomachine engine remains the
// rules authority; these utilities only parse FEN for rendering and apply a
// move visually for instant feedback before the server response arrives.

export type Square = string // 'e4'
export type BoardMap = Record<Square, string> // square -> piece char (PNBRQK / pnbrqk)

const FILES = 'abcdefgh'

export function fileOf(sq: Square): number {
  return FILES.indexOf(sq[0])
}
export function rankOf(sq: Square): number {
  return Number(sq[1]) - 1
}
export function squareAt(file: number, rank: number): Square {
  return FILES[file] + String(rank + 1)
}
export function isLightSquare(sq: Square): boolean {
  return (fileOf(sq) + rankOf(sq)) % 2 === 1
}

/** Parse the placement field of a FEN into a square->piece map. */
export function parseFen(fen: string): BoardMap {
  const board: BoardMap = {}
  const placement = fen.split(' ')[0]
  const ranks = placement.split('/')
  for (let r = 0; r < 8; r++) {
    const rank = 7 - r // FEN lists rank 8 first
    let file = 0
    for (const ch of ranks[r]) {
      if (ch >= '1' && ch <= '8') {
        file += Number(ch)
      } else {
        board[squareAt(file, rank)] = ch
        file++
      }
    }
  }
  return board
}

export function isWhitePiece(piece: string): boolean {
  return piece === piece.toUpperCase()
}

/**
 * Apply a UCI move to a board map for immediate visual feedback. Handles
 * captures, castling, en passant, and promotion. Display-only — not a rules
 * engine.
 */
export function applyUciVisually(board: BoardMap, uci: string): BoardMap {
  const from = uci.slice(0, 2)
  const to = uci.slice(2, 4)
  const promo = uci[4]
  const piece = board[from]
  if (!piece) return board

  const next: BoardMap = { ...board }
  delete next[from]

  const white = isWhitePiece(piece)
  const lower = piece.toLowerCase()

  // En passant: a pawn moves diagonally onto an empty square.
  if (lower === 'p' && from[0] !== to[0] && !board[to]) {
    delete next[to[0] + from[1]] // captured pawn sits on (to-file, from-rank)
  }

  // Promotion.
  next[to] = promo ? (white ? promo.toUpperCase() : promo.toLowerCase()) : piece

  // Castling: the king travels two files; bring the rook along.
  if (lower === 'k' && Math.abs(fileOf(to) - fileOf(from)) === 2) {
    const rank = from[1]
    const rook = white ? 'R' : 'r'
    if (fileOf(to) > fileOf(from)) {
      delete next['h' + rank]
      next['f' + rank] = rook
    } else {
      delete next['a' + rank]
      next['d' + rank] = rook
    }
  }

  return next
}

/** Legal destination squares for a given origin, derived from the engine's UCI list. */
export function targetsFrom(legalMoves: string[], from: Square): Set<Square> {
  const out = new Set<Square>()
  for (const m of legalMoves) {
    if (m.slice(0, 2) === from) out.add(m.slice(2, 4))
  }
  return out
}

/** Promotion piece options for a from→to pair, if the move is a promotion. */
export function promotionsFor(legalMoves: string[], from: Square, to: Square): string[] {
  const out: string[] = []
  for (const m of legalMoves) {
    if (m.slice(0, 2) === from && m.slice(2, 4) === to && m.length === 5) out.push(m[4])
  }
  return out
}

/** Locate a color's king square (for check highlighting). */
export function kingSquare(board: BoardMap, white: boolean): Square | null {
  const target = white ? 'K' : 'k'
  for (const [sq, p] of Object.entries(board)) {
    if (p === target) return sq
  }
  return null
}

// Unicode glyphs — solid set for both colors; color comes from CSS fill.
const GLYPH: Record<string, string> = {
  k: '♚',
  q: '♛',
  r: '♜',
  b: '♝',
  n: '♞',
  p: '♟',
}
export function glyphFor(piece: string): string {
  return GLYPH[piece.toLowerCase()] ?? ''
}

const STATUS_LABEL: Record<string, string> = {
  ongoing: 'In progress',
  checkmate: 'Checkmate',
  stalemate: 'Stalemate — draw',
  'draw-fifty': 'Draw — fifty-move rule',
  'draw-seventyfive': 'Draw — seventy-five-move rule',
  'draw-threefold-claimable': 'Draw by repetition',
  'draw-fivefold': 'Draw — fivefold repetition',
  'draw-insufficient-material': 'Draw — insufficient material',
  'draw-dead-position': 'Draw — dead position',
}
export function statusLabel(status: string): string {
  return STATUS_LABEL[status] ?? status
}
