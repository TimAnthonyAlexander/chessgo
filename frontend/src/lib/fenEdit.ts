// Pure, immutable FEN-editing helpers for the board editor. Every function takes
// a FEN and returns a NEW FEN — the editor never mutates in place. chess.js is
// only used for final legality validation; placement/metadata edits here are
// deliberately rules-free (you can build any position before validating it).

import { Chess } from 'chess.js'
import { type BoardMap, type Square, parseFen, squareAt } from './chess'

export const START_FEN = 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1'
export const EMPTY_FEN = '8/8/8/8/8/8/8/8 w - - 0 1'

export type Active = 'w' | 'b'

interface FenFields {
    board: BoardMap
    active: Active
    castling: string // subset of 'KQkq', or '-'
    ep: string // en-passant target square, or '-'
    half: string
    full: string
}

function parseFields(fen: string): FenFields {
    const parts = fen.trim().split(/\s+/)
    return {
        board: parseFen(fen),
        active: parts[1] === 'b' ? 'b' : 'w',
        castling: parts[2] || '-',
        ep: parts[3] || '-',
        half: parts[4] || '0',
        full: parts[5] || '1',
    }
}

/** Serialize a square→piece map back into a FEN placement field. */
function boardToPlacement(board: BoardMap): string {
    const rows: string[] = []
    for (let rank = 7; rank >= 0; rank--) {
        let row = ''
        let empty = 0
        for (let file = 0; file < 8; file++) {
            const p = board[squareAt(file, rank)]
            if (p) {
                if (empty) {
                    row += empty
                    empty = 0
                }
                row += p
            } else {
                empty++
            }
        }
        if (empty) row += empty
        rows.push(row)
    }
    return rows.join('/')
}

/**
 * Which castling rights are STRUCTURALLY possible for the current placement
 * (king + the relevant rook both on their home squares). The editor uses this to
 * (a) enable/disable the castling toggles and (b) prune impossible rights so the
 * FEN it emits is always self-consistent.
 */
export function castlingAvailability(board: BoardMap): Record<string, boolean> {
    return {
        K: board.e1 === 'K' && board.h1 === 'R',
        Q: board.e1 === 'K' && board.a1 === 'R',
        k: board.e8 === 'k' && board.h8 === 'r',
        q: board.e8 === 'k' && board.a8 === 'r',
    }
}

function pruneCastling(board: BoardMap, castling: string): string {
    const avail = castlingAvailability(board)
    const out = ['K', 'Q', 'k', 'q'].filter((c) => castling.includes(c) && avail[c]).join('')
    return out || '-'
}

function build(f: FenFields): string {
    return `${boardToPlacement(f.board)} ${f.active} ${pruneCastling(f.board, f.castling)} ${f.ep} ${f.half} ${f.full}`
}

// --- Editing operations (all return a fresh FEN) ---

/** Place a piece on a square, or remove it when `piece` is null. Resets EP. */
export function withPiece(fen: string, square: Square, piece: string | null): string {
    const f = parseFields(fen)
    const board = { ...f.board }
    if (piece) board[square] = piece
    else delete board[square]
    return build({ ...f, board, ep: '-' })
}

/** Move a piece between squares (used by drag); a no-op if the source is empty. */
export function withMovedPiece(fen: string, from: Square, to: Square): string {
    const f = parseFields(fen)
    const piece = f.board[from]
    if (!piece || from === to) return fen
    const board = { ...f.board }
    delete board[from]
    board[to] = piece
    return build({ ...f, board, ep: '-' })
}

/** Strip every piece off the board (also clears castling + EP). */
export function withClearedBoard(fen: string): string {
    const f = parseFields(fen)
    return build({ ...f, board: {}, castling: '-', ep: '-' })
}

export function withActive(fen: string, active: Active): string {
    const f = parseFields(fen)
    return build({ ...f, active, ep: '-' })
}

export function withCastling(fen: string, castling: string): string {
    const f = parseFields(fen)
    return build({ ...f, castling })
}

// --- Readers ---

export function activeOf(fen: string): Active {
    return parseFields(fen).active
}

export function castlingOf(fen: string): string {
    return parseFields(fen).castling
}

// --- Validation ---

export interface SetupValidation {
    ok: boolean
    reason?: string
}

/**
 * Validate a hand-built position before it can leave the editor. Catches the
 * cases that would otherwise crash chess.js downstream (in legalUci/gameOverAt):
 * king count, pawns on the back ranks, an otherwise-illegal placement, and the
 * side-not-to-move already being in check.
 */
export function validateSetup(fen: string): SetupValidation {
    const board = parseFen(fen)
    const values = Object.values(board)
    const whiteKings = values.filter((p) => p === 'K').length
    const blackKings = values.filter((p) => p === 'k').length
    if (whiteKings !== 1 || blackKings !== 1) {
        return { ok: false, reason: 'Need exactly one king per side.' }
    }
    for (const [sq, p] of Object.entries(board)) {
        if ((p === 'P' || p === 'p') && (sq[1] === '1' || sq[1] === '8')) {
            return { ok: false, reason: 'Pawns can’t sit on the first or last rank.' }
        }
    }
    try {
        new Chess(fen)
    } catch {
        return { ok: false, reason: 'That placement isn’t a legal position.' }
    }
    // The side NOT to move must not be in check (you can't move into a position
    // where you've left the opponent able to capture your king). Detect it by
    // flipping the active color and asking chess.js whether that side is in check.
    try {
        const flipped = new Chess(withActive(fen, activeOf(fen) === 'w' ? 'b' : 'w'))
        if (flipped.isCheck()) {
            return { ok: false, reason: 'The side not to move is in check.' }
        }
    } catch {
        return { ok: false, reason: 'That placement isn’t a legal position.' }
    }
    return { ok: true }
}
