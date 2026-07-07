// Blunder Rewind — turn a reviewed game's blunders into playable retry puzzles.
//
// The data is already computed by the server's per-ply game analysis: for every
// ply we have the pre-move FEN, the move played (+ its judgment), and the engine's
// best move / line / eval FROM that position. A blunder puzzle is simply a ply
// whose move was judged a 'blunder': the player retries from the pre-blunder FEN
// and we grade their move against what the engine saw.
//
// Grading reuses the existing /analyze endpoint (no new backend): a retry is
// graded by how much eval it drops versus best play from the same position.

import { Chess } from 'chess.js'
import { analyze, type AnalysisEval, type Color, type GameAnalysis } from '../api/client'

// Mate scores are folded into a single centipawn scale so best/attempt evals are
// directly comparable. A mate-in-n maps near ±MATE, closer mates being larger in
// magnitude; ordinary evals stay in their natural cp range well below the band.
const MATE = 100000
// |cp| at or above this is treated as a forced mate for display/formatting.
const MATE_BAND = 90000

// Grade thresholds (centipawns lost vs best play), tuned for a training tool: the
// exact engine move is always 'best'; a near-best alternative still "recovers".
const GOOD_MAX = 40
const INACCURACY_MAX = 120

export type Grade = 'best' | 'good' | 'inaccuracy' | 'miss'

/** A single blunder turned into a retry puzzle. */
export interface BlunderPuzzle {
    /** Half-move index of the blunder within the game (for a stable key). */
    ply: number
    /** The pre-blunder position the player retries from. */
    fen: string
    /** The side that blundered (and is to move in `fen`). */
    playerColor: Color
    /** Display name of the blundering player. */
    playerName: string
    /** The blunder actually played, in SAN (e.g. "Qxd4"). */
    playedSan: string
    /** The blunder actually played, in UCI. */
    playedUci: string
    /** The engine's best move from `fen` (UCI). */
    bestUci: string
    /** The engine's best line from `fen` (UCI, `bestUci` first). */
    bestPv: string[]
    /** Eval of the pre-blunder position (best-play, White POV). */
    bestEvalWhite: AnalysisEval | null
    /** Eval after the blunder was played (White POV) — the swing the player caused. */
    afterEvalWhite: AnalysisEval | null
    /** Centipawns the blunder itself lost (from the server analysis). */
    cpLoss: number
}

/** The graded outcome of one retry attempt. All cp values are player-POV. */
export interface Attempt {
    uci: string
    san: string
    grade: Grade
    /** Eval after the retry move, player POV (mate-folded cp scale). */
    playerCp: number
    /** Best achievable eval from the position, player POV (mate-folded cp scale). */
    bestCp: number
    /** Centipawns lost vs best play (>= 0). */
    cpLoss: number
}

/** A blunder is "recovered" when the retry was best or near-best. */
export function isRecovered(g: Grade): boolean {
    return g === 'best' || g === 'good'
}

/** Which color the named player played in this game, or null if not a participant. */
export function colorInGame(game: GameAnalysis, name: string | undefined): Color | null {
    if (!name) return null
    if (name === game.whiteName) return 'w'
    if (name === game.blackName) return 'b'
    return null
}

/**
 * Extract every blunder in a reviewed game as a retry puzzle (in game order).
 * When `onlyColor` is given, only that side's blunders are returned (the review
 * replays your own blunders, not the opponent's); omit it for both sides.
 */
export function buildBlunderPuzzles(game: GameAnalysis, onlyColor?: Color): BlunderPuzzle[] {
    const plies = game.plies
    const out: BlunderPuzzle[] = []
    for (let k = 0; k < plies.length; k++) {
        const p = plies[k]
        const mv = p.move
        // Only blunders we can actually grade (the engine gave us a best move).
        if (!mv || mv.judgment !== 'blunder' || !p.bestUci) continue
        const playerColor = mv.color
        if (onlyColor && playerColor !== onlyColor) continue
        out.push({
            ply: p.ply,
            fen: p.fen,
            playerColor,
            playerName: playerColor === 'w' ? game.whiteName : game.blackName,
            playedSan: mv.san,
            playedUci: mv.uci,
            bestUci: p.bestUci,
            bestPv: p.bestPv ?? [],
            bestEvalWhite: p.evalWhite,
            afterEvalWhite: plies[k + 1]?.evalWhite ?? null,
            cpLoss: mv.cpLoss,
        })
    }
    return out
}

/** Legal UCI moves for a FEN (chess.js is the display-side rules authority). */
export function legalUciForFen(fen: string): string[] {
    try {
        const c = new Chess(fen)
        return c.moves({ verbose: true }).map((m) => m.from + m.to + (m.promotion ?? ''))
    } catch {
        return []
    }
}

// Fold a side-to-move eval ({cp|mate}) into the shared cp scale.
function stmToCp(ev: { type: 'cp' | 'mate'; value: number } | null): number {
    if (!ev) return 0
    if (ev.type === 'mate') return ev.value >= 0 ? MATE - ev.value : -MATE - ev.value
    return ev.value
}

// Fold a White-POV eval ({cp|mate}) into the shared cp scale.
function whiteToCp(ev: AnalysisEval | null): number {
    if (!ev) return 0
    if (ev.type === 'mate') return ev.white >= 0 ? MATE - ev.white : -MATE - ev.white
    return ev.white
}

/** Best-play eval from the puzzle, expressed player-POV on the shared cp scale. */
export function bestPlayerCp(puzzle: BlunderPuzzle): number {
    const white = whiteToCp(puzzle.bestEvalWhite)
    return puzzle.playerColor === 'w' ? white : -white
}

/** A player-POV cp value as a White-POV eval, for the eval bar. */
export function playerCpToWhiteEval(playerCp: number, playerColor: Color): {
    type: 'cp' | 'mate'
    white: number
} {
    const white = playerColor === 'w' ? playerCp : -playerCp
    if (white >= MATE_BAND) return { type: 'mate', white: 1 }
    if (white <= -MATE_BAND) return { type: 'mate', white: -1 }
    return { type: 'cp', white }
}

/** Short player-POV eval label: "+1.2", "-0.3", "#3", "-#2". */
export function formatPlayerCp(cp: number): string {
    if (cp >= MATE_BAND) return `#${Math.max(1, MATE - Math.round(cp))}`
    if (cp <= -MATE_BAND) return `-#${Math.max(1, MATE + Math.round(cp))}`
    const v = cp / 100
    return (v > 0 ? '+' : '') + v.toFixed(1)
}

/**
 * Grade one retry move against the engine's best play from the puzzle position.
 * Exact-best always wins outright; otherwise we play the move (chess.js), read the
 * resulting eval via /analyze (or resolve terminals locally), and compare the
 * player-POV eval to best. Movetime is kept short — this grades a single move.
 */
export async function gradeAttempt(
    puzzle: BlunderPuzzle,
    uci: string,
    opts?: { signal?: AbortSignal; movetime?: number },
): Promise<Attempt> {
    const bestCp = bestPlayerCp(puzzle)
    const isBest = uci.slice(0, 4) === puzzle.bestUci.slice(0, 4)

    // Apply the move for its SAN + to resolve terminal positions without the engine.
    let san = uci
    let afterFen: string | null = null
    let terminalCp: number | null = null
    try {
        const c = new Chess(puzzle.fen)
        const res = c.move({
            from: uci.slice(0, 2),
            to: uci.slice(2, 4),
            promotion: uci.length > 4 ? uci[4] : undefined,
        })
        san = res.san
        if (c.isCheckmate())
            terminalCp = MATE - 1 // the retry delivers mate
        else if (c.isGameOver())
            terminalCp = 0 // stalemate / draw
        else afterFen = c.fen()
    } catch {
        // Board only emits legal moves, so this is defensive.
        return { uci, san: uci, grade: 'miss', playerCp: bestCp, bestCp, cpLoss: 0 }
    }

    let playerCp: number
    if (terminalCp !== null) {
        playerCp = terminalCp
    } else if (afterFen) {
        // /analyze returns the eval from the NEW side to move (the opponent) — negate
        // to get the retrying player's POV.
        const r = await analyze(afterFen, { movetime: opts?.movetime ?? 600, signal: opts?.signal })
        playerCp = -stmToCp(r.eval)
    } else {
        playerCp = bestCp
    }

    const cpLoss = Math.max(0, bestCp - playerCp)
    let grade: Grade
    if (isBest) grade = 'best'
    else if (cpLoss <= GOOD_MAX) grade = 'good'
    else if (cpLoss <= INACCURACY_MAX) grade = 'inaccuracy'
    else grade = 'miss'

    return { uci, san, grade, playerCp, bestCp, cpLoss }
}
