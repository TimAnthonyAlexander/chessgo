// Runs under `bun test`. Pure comparison logic — no engine, no DOM.
import { describe, expect, test } from 'bun:test'
import { type EvalCandidate, isFirstEvalBetter, shouldReplaceDisplayedEval } from '../precedence'

function ev(partial: Partial<EvalCandidate>): EvalCandidate {
    return { depth: 10, nodes: 1000, pvCount: 1, source: 'local', ...partial }
}

describe('isFirstEvalBetter', () => {
    test('deeper replaces shallower regardless of source', () => {
        const deeper = ev({ depth: 20, nodes: 1, pvCount: 1, source: 'local' })
        const shallow = ev({ depth: 10, nodes: 999999, pvCount: 1, source: 'server' })
        expect(isFirstEvalBetter(deeper, shallow, 1)).toBeTrue()
        expect(isFirstEvalBetter(shallow, deeper, 1)).toBeFalse()
    })

    test('equal depth, more nodes wins', () => {
        const moreNodes = ev({ depth: 15, nodes: 500000, pvCount: 1 })
        const fewerNodes = ev({ depth: 15, nodes: 100000, pvCount: 1 })
        expect(isFirstEvalBetter(moreNodes, fewerNodes, 1)).toBeTrue()
        expect(isFirstEvalBetter(fewerNodes, moreNodes, 1)).toBeFalse()
    })

    test('equal depth and equal nodes: neither is better', () => {
        const a = ev({ depth: 15, nodes: 100000 })
        const b = ev({ depth: 15, nodes: 100000 })
        expect(isFirstEvalBetter(a, b, 1)).toBeFalse()
        expect(isFirstEvalBetter(b, a, 1)).toBeFalse()
    })

    test('a result with enough PV lines beats one without, even at lower depth/nodes', () => {
        const enoughLines = ev({ depth: 6, nodes: 100, pvCount: 5 })
        const tooFewLines = ev({ depth: 20, nodes: 999999, pvCount: 1 })
        // desiredPvs = 5: `enoughLines` clears the bar, `tooFewLines` doesn't —
        // PV sufficiency wins outright, ignoring the depth/node gap.
        expect(isFirstEvalBetter(enoughLines, tooFewLines, 5)).toBeTrue()
        expect(isFirstEvalBetter(tooFewLines, enoughLines, 5)).toBeFalse()
    })

    test('when both sides clear (or both miss) the PV bar, it falls back to depth/nodes', () => {
        // Both have >= desiredPvs (2) — PV sufficiency is a wash, so depth decides.
        const a = ev({ depth: 12, nodes: 1, pvCount: 3 })
        const b = ev({ depth: 8, nodes: 999999, pvCount: 2 })
        expect(isFirstEvalBetter(a, b, 2)).toBeTrue()

        // Both fall short of desiredPvs (5) — still a wash, depth decides again.
        const c = ev({ depth: 12, nodes: 1, pvCount: 1 })
        const d = ev({ depth: 8, nodes: 999999, pvCount: 1 })
        expect(isFirstEvalBetter(c, d, 5)).toBeTrue()
    })
})

describe('shouldReplaceDisplayedEval', () => {
    test('nothing displayed yet: any incoming eval is accepted', () => {
        expect(shouldReplaceDisplayedEval(null, ev({ depth: 1, nodes: 1, pvCount: 1 }), 1)).toBeTrue()
    })

    test('a local result does NOT replace a deeper cached/server result — the case that matters most', () => {
        const displayed = ev({ depth: 22, nodes: 5_000_000, pvCount: 1, source: 'cache' })
        const incomingLocal = ev({ depth: 10, nodes: 50_000, pvCount: 1, source: 'local' })
        expect(shouldReplaceDisplayedEval(displayed, incomingLocal, 1)).toBeFalse()

        const displayedServer = ev({ depth: 18, nodes: 2_000_000, pvCount: 1, source: 'server' })
        expect(shouldReplaceDisplayedEval(displayedServer, incomingLocal, 1)).toBeFalse()
    })

    test('a deeper local result DOES replace a shallower cached/server result', () => {
        const displayed = ev({ depth: 8, nodes: 10_000, pvCount: 1, source: 'cache' })
        const incomingLocal = ev({ depth: 16, nodes: 20_000, pvCount: 1, source: 'local' })
        expect(shouldReplaceDisplayedEval(displayed, incomingLocal, 1)).toBeTrue()
    })
})
