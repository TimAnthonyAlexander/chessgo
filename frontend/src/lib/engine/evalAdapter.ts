// The seam between chessgo's own eval-response shapes — `Analysis` from the
// server `/analyze` endpoint (api/client.ts) and `EngineInfo` streamed from
// the local WASM engine (protocol.ts) — and precedence.ts's neutral
// `EvalCandidate`, which knows nothing about either concrete type by design
// (see precedence.ts's header comment). Kept in one place and unit-tested
// (__tests__/evalAdapter.test.ts) rather than re-derived slightly differently
// at each call site — this was flagged as the awkward part of wiring the
// local engine in, so it gets its own module instead of living inline in
// Analysis.tsx.
import type { Analysis } from '../../api/client'
import { type EvalCandidate, type EvalSource, isFirstEvalBetter } from './precedence'
import { type EngineInfo, engineScoreToAnalysisEval } from './protocol'

/**
 * Everything a caller needs to actually RENDER a chosen eval, alongside the
 * `EvalCandidate` used to decide whether it wins. `eval`/`bestmove`/`pv` use
 * the side-to-move-POV convention documented on
 * `protocol.ts#engineScoreToAnalysisEval` — callers flip to White's POV
 * themselves before handing this to the eval bar, exactly like the existing
 * ANALYSIS_LADDER effect already does with a plain server `Analysis`.
 */
export interface DisplayEval {
    source: EvalSource
    depth: number
    eval: { type: 'cp' | 'mate'; value: number } | null
    bestmove: string | null
    pv: string[]
}

/** A candidate paired with the render-ready value it came from — what flows
 * through `pickDisplayed` and the racing effect in Analysis.tsx. */
export interface RaceCandidate {
    candidate: EvalCandidate
    display: DisplayEval
}

/**
 * Server `/analyze` response → RaceCandidate. `source` reads the response's
 * `source` field (added alongside this feature — see AnalyzeController.php)
 * and defaults to `'server'` when it's absent, so an older/mocked response
 * without the field still adapts correctly instead of throwing or
 * misreporting as a cache hit.
 */
export function fromAnalysis(a: Analysis): RaceCandidate {
    const depth = a.depth ?? 0
    const pvCount = a.lines && a.lines.length > 0 ? a.lines.length : a.bestmove ? 1 : 0
    const source: EvalSource = a.source === 'cache' ? 'cache' : 'server'
    return {
        candidate: { depth, nodes: 0, pvCount, source },
        display: { source, depth, eval: a.eval ?? null, bestmove: a.bestmove ?? null, pv: a.pv ?? [] },
    }
}

/**
 * Local engine `info` line → RaceCandidate. `pvCount` is always 1: the local
 * engine only ever races its single MultiPV=1 main line against the server
 * (see useLocalEngineRace.ts) — the analysis board's multi-line move list
 * stays entirely server-driven (ANALYSIS_LADDER's multipv rungs), so there is
 * never a multi-line local result to count here.
 *
 * A `bound`-flagged info (aspiration-window fail-high/low — see protocol.ts)
 * is the CALLER's job to filter out before reaching this function; it has no
 * opinion on that policy, it only converts.
 */
export function fromEngineInfo(info: EngineInfo): RaceCandidate {
    const evalValue = engineScoreToAnalysisEval(info.score)
    return {
        candidate: { depth: info.depth, nodes: info.nodes ?? 0, pvCount: 1, source: 'local' },
        display: { source: 'local', depth: info.depth, eval: evalValue, bestmove: info.pv[0] ?? null, pv: info.pv },
    }
}

/** Should `incoming` replace `current` on screen? Thin wrapper around
 * `isFirstEvalBetter` so callers compare RaceCandidates directly instead of
 * unwrapping `.candidate` at every call site. `current === null` (nothing
 * displayed yet) always loses. */
export function isRaceCandidateBetter(
    current: RaceCandidate | null,
    incoming: RaceCandidate,
    desiredPvs: number,
): boolean {
    if (!current) return true
    return isFirstEvalBetter(incoming.candidate, current.candidate, desiredPvs)
}

/** Convenience: current-or-incoming, whichever wins per `isRaceCandidateBetter`. */
export function pickDisplayed(
    current: RaceCandidate | null,
    incoming: RaceCandidate,
    desiredPvs: number,
): RaceCandidate {
    return isRaceCandidateBetter(current, incoming, desiredPvs) ? incoming : (current as RaceCandidate)
}
