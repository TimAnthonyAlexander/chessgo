// Chess variant metadata + helpers shared by the lobby, the board, and the duck
// controller. The gomachine engine is the rules authority for every variant;
// these are display / setup helpers only (a random 960 start, duck-placement
// targets, human-readable labels).

import { applyUciVisually, type BoardMap, type Square } from './chess'

export type Variant = 'standard' | 'chess960' | 'duck' | 'crazyhouse' | 'antichess'

/** The standard chess start position. */
export const START_FEN = 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1'

export const VARIANT_LABEL: Record<Variant, string> = {
    standard: 'Standard',
    chess960: 'Chess960',
    duck: 'Duck Chess',
    crazyhouse: 'Crazyhouse',
    antichess: 'Antichess',
}

export const VARIANT_BLURB: Record<Variant, string> = {
    standard: 'Classic chess — the normal starting position and rules.',
    chess960: 'Fischer Random — the back rank is shuffled at the start.',
    duck: 'Move a piece, then drop the duck. Capture the king to win.',
    crazyhouse: 'Captured pieces switch sides — drop them back on the board.',
    antichess:
        'Räuberschach — captures are compulsory and the king is just a piece. Lose all your men (or get stalemated) to win.',
}

/** Pocket piece letters (always uppercase; color is by context). */
export type PocketPiece = 'P' | 'N' | 'B' | 'R' | 'Q'

/** A Crazyhouse pocket: the pieces each side holds in hand. */
export interface Pockets {
    w: PocketPiece[]
    b: PocketPiece[]
}

/**
 * Extract the pocket string ("PPNq" — white uppercase, black lowercase) from a
 * Crazyhouse FEN's "[...]" field, or "" if absent.
 */
export function pocketFromFen(fen: string): string {
    const m = fen.match(/\[([^\]]*)\]/)
    return m ? m[1] : ''
}

/**
 * Parse a Crazyhouse pocket string ("PPNq") into each side's held pieces.
 * Uppercase letters are White's pocket, lowercase Black's.
 */
export function parsePocket(pocket: string): Pockets {
    const w: PocketPiece[] = []
    const b: PocketPiece[] = []
    for (const ch of pocket) {
        const up = ch.toUpperCase()
        if (!'PNBRQ'.includes(up)) continue
        ;(ch === up ? w : b).push(up as PocketPiece)
    }
    return { w, b }
}

/**
 * Strip Crazyhouse-only markup (the "[pocket]" suffix and "~" promotion marks)
 * from a FEN, leaving a standard FEN the board renderer understands.
 */
export function stripCrazyhouseFen(fen: string): string {
    return fen.replace(/\[[^\]]*\]/, '').replace(/~/g, '')
}

/**
 * The empty squares a pocketed `piece` may be dropped on — every legal move of the
 * form "<PIECE>@<square>" for the side to move. Display-only; the engine validates.
 */
export function dropTargets(legalMoves: string[], piece: PocketPiece): Set<Square> {
    const out = new Set<Square>()
    const prefix = `${piece}@`
    for (const mv of legalMoves) {
        if (mv.startsWith(prefix)) out.add(mv.slice(2) as Square)
    }
    return out
}

const FILES = 'abcdefgh'

/**
 * A random legal Chess960 (Fischer Random) start FEN. The back rank is shuffled
 * per FRC rules — bishops on opposite colors, the king between the two rooks —
 * and mirrored for both sides. Castling is "KQkq" and White moves first.
 */
export function random960(): string {
    const rank: (string | null)[] = Array(8).fill(null)
    const pickFrom = (cells: number[]) => cells[Math.floor(Math.random() * cells.length)]
    // Bishops on opposite-colored squares.
    rank[pickFrom([1, 3, 5, 7])] = 'B'
    rank[pickFrom([0, 2, 4, 6])] = 'B'
    const empties = () => rank.map((p, i) => (p === null ? i : -1)).filter((i) => i >= 0)
    rank[pickFrom(empties())] = 'Q'
    rank[pickFrom(empties())] = 'N'
    rank[pickFrom(empties())] = 'N'
    // Remaining three squares get rook, king, rook (king always between the rooks).
    const [r1, k, r2] = empties()
    rank[r1] = 'R'
    rank[k] = 'K'
    rank[r2] = 'R'
    const white = rank.join('')
    const black = white.toLowerCase()
    return `${black}/pppppppp/8/8/8/8/PPPPPPPP/${white} w KQkq - 0 1`
}

/**
 * The empty squares on which the duck may be placed AFTER applying `pieceUci` to
 * `board`: every empty square of the resulting position, minus the duck's current
 * square (the duck must move each turn). `currentDuck` is null before the first
 * placement. Display-only — the engine validates the composite move.
 */
export function duckTargets(
    board: BoardMap,
    pieceUci: string,
    currentDuck: Square | null,
): Set<Square> {
    const after = applyUciVisually(board, pieceUci)
    const out = new Set<Square>()
    for (let f = 0; f < 8; f++) {
        for (let r = 1; r <= 8; r++) {
            const sq = FILES[f] + String(r)
            if (!after[sq]) out.add(sq)
        }
    }
    if (currentDuck) out.delete(currentDuck)
    return out
}
