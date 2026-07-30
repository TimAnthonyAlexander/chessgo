// Port of Lichess's eval-precedence rule (ui/lib/src/ceval/util.ts,
// `isFirstEvalBetter`). The problem it solves: evals for the SAME position can
// arrive from multiple places — a cheap shallow local guess, a slower deeper
// local result, a server /analyze response, a server cache hit replayed
// instantly — and they can arrive out of order (a fast shallow local result
// can land AFTER a deep cached one that was already on screen). Something has
// to decide whether a newly-arrived eval is allowed to replace what's shown.
//
// Lichess's rule, verbatim:
//   isFirstEvalBetter = (a, b, desiredPvs) =>
//     a.pvs.length >= desiredPvs !== b.pvs.length >= desiredPvs
//       ? a.pvs.length >= desiredPvs
//       : a.depth > b.depth || (a.depth === b.depth && a.nodes > b.nodes)
//
// Read as: first, whichever side has "enough" PV lines (>= what the caller
// asked for) wins outright — a 5-line result beats a 1-line result even at
// lower depth, because the UI needs those extra lines to render the move
// list. Only when both sides are equally (in)sufficient on PV count does it
// fall back to "deeper wins, and equal depth is broken by node count" (more
// nodes at the same depth means a slower/more thorough search, e.g. a wider
// aspiration re-search).
//
// Deliberately NOT source-aware: the rule never looks at where an eval came
// from, only at its shape (depth/nodes/pv count) — Lichess badges the source
// (their "CLOUD" badge) purely for display, it plays no role in whether a
// result wins. We keep that: `source` rides on our eval type for the UI to
// badge with, but isFirstEvalBetter ignores it, same as upstream.

export type EvalSource = 'server' | 'local' | 'cache'

/** The subset of an eval result the precedence rule needs. Deliberately
 * narrower than `EngineInfo` — precedence only cares about "how much can I
 * prefer this one", so both a local `EngineInfo` and a server `Analysis`
 * response can be compared through this shape via a small adapter at the call
 * site, without this module needing to know either concrete type. */
export interface EvalCandidate {
    depth: number
    // 0 if unknown. An unknown node count can never win a nodes tiebreak,
    // which is the conservative default (never lets an untrustworthy count
    // bump a known one off screen).
    nodes: number
    // Number of PV lines actually present in this result — `lines.length` for
    // a multipv server response, 1 for a single-PV result.
    pvCount: number
    source: EvalSource
}

/** Lichess's `isFirstEvalBetter`, unchanged in behavior. */
export function isFirstEvalBetter(a: EvalCandidate, b: EvalCandidate, desiredPvs: number): boolean {
    const aHasEnough = a.pvCount >= desiredPvs
    const bHasEnough = b.pvCount >= desiredPvs
    if (aHasEnough !== bHasEnough) return aHasEnough
    return a.depth > b.depth || (a.depth === b.depth && a.nodes > b.nodes)
}

/** Convenience wrapper phrased the way call sites actually ask the question:
 * "should this newly-arrived eval replace what's currently on screen?" —
 * `null` current (nothing displayed yet) always accepts. Just
 * `isFirstEvalBetter` with the arguments named for that intent. */
export function shouldReplaceDisplayedEval(
    current: EvalCandidate | null,
    incoming: EvalCandidate,
    desiredPvs: number,
): boolean {
    if (!current) return true
    return isFirstEvalBetter(incoming, current, desiredPvs)
}
