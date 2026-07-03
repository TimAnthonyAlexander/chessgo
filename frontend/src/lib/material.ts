// Captured material derived from a bare FEN. Shared by the analysis aside and the
// spectator info card so both read material the same way. It's an approximation
// once pawns promote (like most board UIs) — we compare on-board counts to the
// starting set rather than replaying the move history.

const VALUE: Record<string, number> = { P: 1, N: 3, B: 3, R: 5, Q: 9 }
const START_COUNT: Record<string, number> = { P: 8, N: 2, B: 2, R: 2, Q: 1 }
const ORDER = ['Q', 'R', 'B', 'N', 'P'] as const

export interface Material {
    capturedByWhite: string[] // black pieces removed from the board
    capturedByBlack: string[] // white pieces removed from the board
    diff: number // White material minus Black material
}

export function computeMaterial(fen: string): Material {
    const board = fen.split(' ')[0]
    const w: Record<string, number> = {}
    const b: Record<string, number> = {}
    for (const ch of board) {
        if (!/[pnbrq]/i.test(ch)) continue
        const t = ch.toUpperCase()
        if (ch === t) w[t] = (w[t] ?? 0) + 1
        else b[t] = (b[t] ?? 0) + 1
    }
    const capturedByWhite: string[] = []
    const capturedByBlack: string[] = []
    let whiteVal = 0
    let blackVal = 0
    for (const t of ORDER) {
        whiteVal += (w[t] ?? 0) * VALUE[t]
        blackVal += (b[t] ?? 0) * VALUE[t]
        for (let i = 0; i < START_COUNT[t] - (b[t] ?? 0); i++) capturedByWhite.push(t)
        for (let i = 0; i < START_COUNT[t] - (w[t] ?? 0); i++) capturedByBlack.push(t)
    }
    return { capturedByWhite, capturedByBlack, diff: whiteVal - blackVal }
}
