// Who owns a position's display.
//
// The analysis board can have two answers for one position when the local engine
// is on: the server's eval_cache (a stored Stockfish result — depth 22 from the
// book, up to 90+ from an imported Lichess row) and the local engine's own
// search, which tops out at its EVAL_DEPTH ceiling.
//
// Exactly ONE of them owns the position, and it owns all of it: the eval, the
// best-move arrow, the PV, the engine lines, the depth readout, and the Cloud
// chip when it is the cache. Nothing is merged between them.
//
// That whole-winner rule exists because the alternative was tried and broke: the
// eval/arrow and the move list were written independently, by different searches
// at different depths, and reconciled per-slot afterwards. The board could show a
// best-move arrow for one move sitting above a first engine line for another.
import type { AnalysisLine } from '../../api/client'

export type EvalOwner = 'cache' | 'local'

export interface OwnedResult {
    lines: AnalysisLine[]
    source: EvalOwner
}

/**
 * The deeper of the two candidate answers, or null if neither exists.
 *
 * Depth is read off line 1, which is by construction the line the eval and the
 * arrow come from — so "deeper" means the same thing for every part of the
 * display. Ties go to the CACHE: it is a stored Stockfish result, and at equal
 * depth Stockfish is the stronger of the two engines.
 */
export function pickDeeper(
    cached: AnalysisLine[] | null | undefined,
    local: AnalysisLine[] | null | undefined,
): OwnedResult | null {
    const cachedDepth = cached && cached.length > 0 ? cached[0].depth : -1
    const localDepth = local && local.length > 0 ? local[0].depth : -1
    if (cachedDepth < 0 && localDepth < 0) return null
    if (cachedDepth >= localDepth) return { lines: cached!, source: 'cache' }
    return { lines: local!, source: 'local' }
}
