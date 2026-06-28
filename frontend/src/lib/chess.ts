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
            delete next[`h${rank}`]
            next[`f${rank}`] = rook
        } else {
            delete next[`a${rank}`]
            next[`d${rank}`] = rook
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

/**
 * Pseudo-legal destination squares for a PREMOVE — the moves a piece could make
 * by its own geometry, evaluated while it isn't your turn (so the real legal-move
 * list isn't available). Deliberately permissive, Chess.com-style: it ignores
 * check, whose turn it is, and pins; sliders may reach THROUGH a single
 * intervening piece (it could move or be captured by the time it's your turn) but
 * stop at a second, pawns include both diagonals (a capture may appear).
 * Own-occupied squares ARE included: premoving onto a friendly piece is valid
 * play (it executes only if the opponent first captures/vacates that square). The
 * queued move is still validated against the real legal moves before it's played,
 * so anything still illegal on your turn is simply discarded.
 */
export function premoveTargets(board: BoardMap, from: Square): Set<Square> {
    const out = new Set<Square>()
    const piece = board[from]
    if (!piece) return out
    const white = isWhitePiece(piece)
    const type = piece.toLowerCase()
    const f = fileOf(from)
    const r = rankOf(from)

    // Add a single on-board square (for the non-sliding knight/king hops).
    const step = (file: number, rank: number) => {
        if (file < 0 || file > 7 || rank < 0 || rank > 7) return
        out.add(squareAt(file, rank))
    }
    // Walk a slider ray, passing through AT MOST ONE occupant: the first blocker is
    // added (it may be captured/move) and we continue one stretch past it; a second
    // occupant is added then stops the ray (anything behind two pieces is out of
    // reach even if one clears).
    const ray = (df: number, dr: number) => {
        let passedBlocker = false
        for (let i = 1; i <= 7; i++) {
            const file = f + df * i
            const rank = r + dr * i
            if (file < 0 || file > 7 || rank < 0 || rank > 7) break
            const sq = squareAt(file, rank)
            out.add(sq)
            if (board[sq]) {
                if (passedBlocker) break
                passedBlocker = true
            }
        }
    }

    if (type === 'p') {
        const dir = white ? 1 : -1
        const start = white ? 1 : 6
        // Forward pushes ignore current blockers (the square ahead may clear); the
        // diagonals are always offered (a capture or en passant may materialise).
        if (r + dir >= 0 && r + dir <= 7) out.add(squareAt(f, r + dir))
        if (r === start) out.add(squareAt(f, r + 2 * dir))
        for (const df of [-1, 1]) {
            const nf = f + df
            const nr = r + dir
            if (nf >= 0 && nf <= 7 && nr >= 0 && nr <= 7) out.add(squareAt(nf, nr))
        }
    } else if (type === 'n') {
        for (const [df, dr] of [
            [1, 2],
            [2, 1],
            [2, -1],
            [1, -2],
            [-1, -2],
            [-2, -1],
            [-2, 1],
            [-1, 2],
        ]) {
            step(f + df, r + dr)
        }
    } else if (type === 'k') {
        for (let df = -1; df <= 1; df++) {
            for (let dr = -1; dr <= 1; dr++) {
                if (df || dr) step(f + df, r + dr)
            }
        }
        if (f === 4) {
            out.add(squareAt(6, r)) // king-side castle target
            out.add(squareAt(2, r)) // queen-side castle target
        }
    } else {
        if (type === 'b' || type === 'q') {
            ray(1, 1)
            ray(1, -1)
            ray(-1, 1)
            ray(-1, -1)
        }
        if (type === 'r' || type === 'q') {
            ray(1, 0)
            ray(-1, 0)
            ray(0, 1)
            ray(0, -1)
        }
    }
    out.delete(from)
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

// Real cburnett vector pieces (the Lichess set), served from /public.
export function pieceImageUrl(piece: string): string {
    const color = isWhitePiece(piece) ? 'w' : 'b'
    return `/piece/cburnett/${color}${piece.toUpperCase()}.svg`
}

// Render SAN with an outline piece glyph instead of the piece letter (Lichess
// move list style): "Nf3" → "♘f3", pawn moves and castling unchanged.
const SAN_GLYPH: Record<string, string> = { K: '♔', Q: '♕', R: '♖', B: '♗', N: '♘' }
export function sanToGlyph(san: string): string {
    const g = SAN_GLYPH[san[0]]
    return g ? g + san.slice(1) : san
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
