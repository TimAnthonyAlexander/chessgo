// Turns a before/after board snapshot into the set of piece "flights" (a
// from→to slide) a chess.com-style animation layer should play to travel
// visually between them.
//
// Deliberately position-diff-based, not move-based: it takes no UCI/SAN input,
// so it produces identical, correct results no matter WHERE the new board came
// from — the player's own move, a networked opponent move, a spectated push,
// or stepping forward/backward through move-list history (Analysis/Puzzles).
// Captures, castling, en passant and promotion all fall out of the matching
// rules below for free, in either time direction, without special-casing any
// one of them.
import { fileOf, rankOf, type BoardMap, type Square } from './chess'

export interface Flight {
    from: Square
    to: Square
    /** The DEPARTING piece's image is what slides (so a promotion visibly
     * travels as a pawn and only reveals the promoted piece on arrival, and a
     * de-promotion on undo travels as the piece it starts as). */
    piece: string
}

// A diff touching more squares than this is a position jump (new game, loaded
// puzzle, board-editor edit) rather than a single move — castling is the
// largest legal move at exactly 4 touched squares, so anything past that never
// wants an animated flight.
const MAX_TOUCHED_SQUARES = 4

function isPawn(piece: string): boolean {
    return piece.toLowerCase() === 'p'
}

// True if `pieceA`@`sqA` and `pieceB`@`sqB` read as a promotion pair — one is a
// pawn on its pre-promotion rank, the other a same-colored non-pawn on the back
// rank, on the same or an adjacent file. Symmetric on purpose: stepping a move
// forward promotes (pawn → piece), stepping back un-promotes (piece → pawn),
// and this check doesn't care which side is the "departure" vs "arrival".
function isPromotionPair(pieceA: string, sqA: Square, pieceB: string, sqB: Square): boolean {
    const [pawn, pawnSq, other, otherSq] = isPawn(pieceA)
        ? [pieceA, sqA, pieceB, sqB]
        : [pieceB, sqB, pieceA, sqA]
    if (!isPawn(pawn) || isPawn(other)) return false
    const white = pawn === pawn.toUpperCase()
    if (other === other.toUpperCase() !== white) return false // colors must match
    const pawnRank = rankOf(pawnSq)
    const otherRank = rankOf(otherSq)
    const ranksMatch = white
        ? pawnRank === 6 && otherRank === 7 // white: 7th rank pawn <-> 8th rank piece
        : pawnRank === 1 && otherRank === 0 // black: 2nd rank pawn <-> 1st rank piece
    if (!ranksMatch) return false
    return Math.abs(fileOf(pawnSq) - fileOf(otherSq)) <= 1
}

function compatible(depPiece: string, depSq: Square, arrPiece: string, arrSq: Square): boolean {
    return depPiece === arrPiece || isPromotionPair(depPiece, depSq, arrPiece, arrSq)
}

// Chebyshev (king-move) distance — the natural "how far did this piece travel"
// metric on a chessboard, used only to break ties when a square could
// plausibly be matched to more than one same-type candidate.
function distance(a: Square, b: Square): number {
    return Math.max(Math.abs(fileOf(a) - fileOf(b)), Math.abs(rankOf(a) - rankOf(b)))
}

export function diffBoardsForAnimation(prev: BoardMap, next: BoardMap): Flight[] {
    const departures: { sq: Square; piece: string }[] = []
    const arrivals: { sq: Square; piece: string }[] = []
    const touched = new Set<Square>()

    for (const sq of new Set([...Object.keys(prev), ...Object.keys(next)])) {
        const before = prev[sq]
        const after = next[sq]
        if (before === after) continue
        touched.add(sq)
        if (before) departures.push({ sq, piece: before })
        if (after) arrivals.push({ sq, piece: after })
    }
    if (touched.size === 0 || touched.size > MAX_TOUCHED_SQUARES) return []

    // Global nearest-neighbor match: every compatible (departure, arrival)
    // candidate pair, closest first, greedily claimed so each square is
    // consumed by at most one flight.
    const candidates: { d: number; dep: (typeof departures)[number]; arr: (typeof arrivals)[number] }[] =
        []
    for (const dep of departures) {
        for (const arr of arrivals) {
            if (compatible(dep.piece, dep.sq, arr.piece, arr.sq)) {
                candidates.push({ d: distance(dep.sq, arr.sq), dep, arr })
            }
        }
    }
    candidates.sort((a, b) => a.d - b.d)

    const usedDep = new Set<Square>()
    const usedArr = new Set<Square>()
    const flights: Flight[] = []
    for (const { dep, arr } of candidates) {
        if (usedDep.has(dep.sq) || usedArr.has(arr.sq)) continue
        usedDep.add(dep.sq)
        usedArr.add(arr.sq)
        flights.push({ from: dep.sq, to: arr.sq, piece: dep.piece })
    }
    return flights
}

// Sentinel Flight `piece` value for the duck (Duck Chess) — real piece chars
// are always a single letter (PNBRQKpnbrqk), so a multi-char tag can't collide.
export const DUCK_FLIGHT = 'duck-flight'
