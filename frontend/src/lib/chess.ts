// Lightweight, display-only chess helpers. The gomachine engine remains the
// rules authority; these utilities only parse FEN for rendering and apply a
// move visually for instant feedback before the server response arrives.

import { themeStore } from './boardTheme'

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

// Classify a KING move (from, to already known to be the king's own squares)
// as castling, returning which side it castles toward, or null for an
// ordinary king step. A king only ever moves more than one square when
// castling (FIDE rule), so:
//   - a two-file jump is always a castle (works for standard chess and any
//     Chess960 start where the king happens to sit exactly 2 files from its
//     landing square — e.g. the standard e-file start).
//   - otherwise (Chess960, king starting elsewhere), a same-rank landing on
//     the back rank's g/c file that ISN'T a plain one-square step is also a
//     castle — the engine's move_to_uci always encodes castling as (king
//     origin, king destination on g/c-file), even letting to === from when
//     the king already sits on its own destination file.
// Known gap (shared with applyUciVisually's castling case below, not new
// here): if the king starts exactly ONE file from its own castling
// destination (e.g. king on f1 castling kingside to g1), the resulting UCI
// ("f1g1") is byte-identical to an ordinary one-square king step — the wire
// format itself can't disambiguate, since move_to_uci drops the CASTLING
// type flag. That configuration is classified as a normal move (no rook
// side-effect assumed), matching this codebase's existing accepted
// limitation rather than inventing a new one.
function castleSideForKingMove(from: Square, to: Square): 'k' | 'q' | null {
    const fileDiff = Math.abs(fileOf(to) - fileOf(from))
    if (fileDiff === 2) return fileOf(to) > fileOf(from) ? 'k' : 'q'
    const toFile = to[0]
    if (to[1] === from[1] && fileDiff !== 1 && (toFile === 'g' || toFile === 'c')) {
        return toFile === 'g' ? 'k' : 'q'
    }
    return null
}

// Resolve the physical rook square for one side of a castle. Chess960-safe:
// picks the OUTERMOST rook on that side of the king (highest file to the
// right for kingside, lowest file to the left for queenside) — the
// unambiguous "castling rook" per Chess960 rules, since a king/rook pair
// can't have another rook between them and still legally castle.
function castlingRookSquare(
    board: BoardMap,
    king: Square,
    side: 'k' | 'q',
    white: boolean,
): Square | null {
    const rook = white ? 'R' : 'r'
    const kf = fileOf(king)
    const kr = rankOf(king)
    if (side === 'k') {
        for (let f = 7; f > kf; f--) {
            const sq = squareAt(f, kr)
            if (board[sq] === rook) return sq
        }
    } else {
        for (let f = 0; f < kf; f++) {
            const sq = squareAt(f, kr)
            if (board[sq] === rook) return sq
        }
    }
    return null
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

    // Castling (display-only, best-effort — the engine's authoritative FEN is the
    // real source of truth). Side + the physical rook come from the two shared
    // helpers above (also used by rookCastleMoves for the rookCastle input
    // mapping); the rook is relocated to f-file (kingside) or d-file (queenside),
    // or left in place if none is found (fallback).
    if (lower === 'k') {
        const backRank = white ? '1' : '8'
        const side = castleSideForKingMove(from, to)
        if (side) {
            const rookSq = castlingRookSquare(board, from, side, white)
            if (rookSq) {
                delete next[rookSq]
                next[`${side === 'k' ? 'f' : 'd'}${backRank}`] = white ? 'R' : 'r'
            }
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
 * `rookCastle` pref support: a rook-square → king-castling-UCI map for
 * `color`'s king, built ONLY from the engine's legal-move list (never
 * inferred) — for every castling-shaped move already legal for the king (see
 * castleSideForKingMove), resolves which physical rook belongs to that side
 * (Chess960-safe outermost-rook heuristic, castlingRookSquare — the same one
 * applyUciVisually uses to relocate the rook visually) and maps that rook's
 * square to the king's OWN move (e.g. "e1g1"), not to a g/c-file square.
 *
 * Mapping onto the king's square (rather than its landing file) is the point:
 * a piece can never legally move onto its own king, so this can never collide
 * with — and so can never strand — a real legal rook move. A g/c-file mapping
 * would collide constantly (whenever kingside castling is legal, the h-file
 * rook can almost always also slide onto g-file as a perfectly ordinary
 * non-castling move), which is exactly the "don't strand a legal rook move"
 * failure the caller (Board.tsx) must avoid.
 */
export function rookCastleMoves(
    board: BoardMap,
    legalMoves: string[],
    color: 'w' | 'b',
): Map<Square, string> {
    const out = new Map<Square, string>()
    const king = kingSquare(board, color === 'w')
    if (!king) return out
    for (const to of targetsFrom(legalMoves, king)) {
        const side = castleSideForKingMove(king, to)
        if (!side) continue
        const rookSq = castlingRookSquare(board, king, side, color === 'w')
        if (rookSq) out.set(rookSq, king + to)
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

// Vector piece SVGs served from /public/piece/<set>/. The set defaults to the
// user's chosen piece theme (appearance store); callers that need a SPECIFIC set
// regardless of the current preference (e.g. the theme picker previews) pass it
// explicitly. Board/MiniBoard subscribe to the store (usePieceSet) so a change
// re-renders them with the new URLs.
export function pieceImageUrl(piece: string, set: string = themeStore.getPieceSet()): string {
    const color = isWhitePiece(piece) ? 'w' : 'b'
    return `/piece/${set}/${color}${piece.toUpperCase()}.svg`
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
    // Duck Chess flavor by default (king capture is Duck's win condition). Antichess
    // reuses these same statuses but wins the opposite way — see statusLabel below.
    white_win: 'White wins — king captured',
    black_win: 'Black wins — king captured',
    draw: 'Draw',
}

// Does `color` ('w'|'b') still have any piece on the board? White pieces are the
// uppercase letters in the board field of a FEN, black the lowercase ones.
function fenSideHasPieces(fen: string, color: 'w' | 'b'): boolean {
    const board = fen.split(' ')[0] ?? ''
    return (color === 'w' ? /[A-Z]/ : /[a-z]/).test(board)
}

// Antichess reuses the generic white_win/black_win statuses, but you WIN by
// shedding all your pieces (or being stalemated), NOT by capturing a king — so the
// Duck-flavored "king captured" copy is wrong. Derive the real reason from the final
// position: the winner has either no pieces left (the common ending — e.g. you were
// forced to capture their last piece) or is stalemated (has pieces but no move).
function antichessWinLabel(status: 'white_win' | 'black_win', fen?: string): string {
    const winner = status === 'white_win' ? 'White' : 'Black'
    const winnerColor = status === 'white_win' ? 'w' : 'b'
    // Without the FEN we can't tell no-pieces from stalemate; "lost all pieces" is the
    // overwhelmingly common antichess ending, so it's the safe default.
    const reason = fen && fenSideHasPieces(fen, winnerColor) ? 'stalemate' : 'lost all pieces'
    return `${winner} wins — ${reason}`
}

/** Human-readable label for a game status. Pass `variant`/`fen` so antichess (which
 * reuses white_win/black_win but wins by losing material) renders correctly instead
 * of Duck's "king captured". */
export function statusLabel(status: string, opts?: { variant?: string; fen?: string }): string {
    if (opts?.variant === 'antichess' && (status === 'white_win' || status === 'black_win')) {
        return antichessWinLabel(status, opts.fen)
    }
    return STATUS_LABEL[status] ?? status
}
