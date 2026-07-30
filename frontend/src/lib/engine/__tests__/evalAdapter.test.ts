// Runs under `bun test`. Pure conversion + comparison logic — no engine, no
// DOM, no network. This is the adapter flagged as the awkward seam between
// chessgo's own response shapes and precedence.ts's neutral EvalCandidate —
// gets thorough coverage rather than a token test.
import { describe, expect, test } from 'bun:test'
import type { Analysis } from '../../../api/client'
import { fromAnalysis, fromEngineInfo, isRaceCandidateBetter, pickDisplayed } from '../evalAdapter'
import type { EngineInfo } from '../protocol'

function analysis(partial: Partial<Analysis>): Analysis {
    return { eval: { type: 'cp', value: 25 }, bestmove: 'e2e4', pv: ['e2e4'], depth: 18, ...partial }
}

function info(partial: Partial<EngineInfo>): EngineInfo {
    return { depth: 18, score: { type: 'cp', value: 25 }, pv: ['e2e4'], ...partial }
}

describe('fromAnalysis', () => {
    test('source "cache" on the response maps to candidate source "cache"', () => {
        const rc = fromAnalysis(analysis({ source: 'cache' }))
        expect(rc.candidate.source).toBe('cache')
        expect(rc.display.source).toBe('cache')
    })

    test('source "engine" on the response maps to candidate source "server"', () => {
        const rc = fromAnalysis(analysis({ source: 'engine' }))
        expect(rc.candidate.source).toBe('server')
    })

    test('a missing `source` (older/mocked response) defaults to "server", not a crash', () => {
        const { source: _drop, ...noSource } = analysis({ source: 'cache' })
        void _drop
        const rc = fromAnalysis(noSource as Analysis)
        expect(rc.candidate.source).toBe('server')
    })

    test('pvCount reflects the multi-PV line count when present', () => {
        const rc = fromAnalysis(
            analysis({
                lines: [
                    { bestmove: 'e2e4', san: 'e4', eval: { type: 'cp', value: 25 }, pv: ['e2e4'], depth: 18 },
                    { bestmove: 'd2d4', san: 'd4', eval: { type: 'cp', value: 20 }, pv: ['d2d4'], depth: 18 },
                ],
            }),
        )
        expect(rc.candidate.pvCount).toBe(2)
    })

    test('pvCount falls back to 1 when there is a bestmove but no `lines` array', () => {
        const rc = fromAnalysis(analysis({ lines: undefined }))
        expect(rc.candidate.pvCount).toBe(1)
    })

    test('pvCount is 0 when there is neither a bestmove nor lines (e.g. a terminal position)', () => {
        const rc = fromAnalysis(analysis({ bestmove: null, lines: undefined }))
        expect(rc.candidate.pvCount).toBe(0)
    })

    test('a null depth reads as candidate depth 0, not NaN/undefined', () => {
        const rc = fromAnalysis(analysis({ depth: null }))
        expect(rc.candidate.depth).toBe(0)
    })

    test('display carries the eval/bestmove/pv through unchanged (identity conversion)', () => {
        const rc = fromAnalysis(analysis({ eval: { type: 'mate', value: 3 }, bestmove: 'g1f3', pv: ['g1f3', 'g8f6'] }))
        expect(rc.display.eval).toEqual({ type: 'mate', value: 3 })
        expect(rc.display.bestmove).toBe('g1f3')
        expect(rc.display.pv).toEqual(['g1f3', 'g8f6'])
    })

    test('nodes saturates high — /analyze carries no node count, so it must hold depth ties', () => {
        // Scoring the server as 0 nodes made the local engine win every depth tie
        // (isFirstEvalBetter breaks ties on nodes), so local's shallow early results
        // overwrote equally-deep server ones and pinned the displayed depth.
        expect(fromAnalysis(analysis({})).candidate.nodes).toBe(Number.MAX_SAFE_INTEGER)
    })
})

describe('fromEngineInfo', () => {
    test('source is always "local"', () => {
        expect(fromEngineInfo(info({})).candidate.source).toBe('local')
    })

    test('pvCount is always 1, regardless of the multipv field (a line INDEX, not a count)', () => {
        expect(fromEngineInfo(info({ multipv: 3 })).candidate.pvCount).toBe(1)
    })

    test('nodes defaults to 0 when the engine did not report it', () => {
        expect(fromEngineInfo(info({ nodes: undefined })).candidate.nodes).toBe(0)
    })

    test('nodes passes through when present', () => {
        expect(fromEngineInfo(info({ nodes: 123456 })).candidate.nodes).toBe(123456)
    })

    test('bestmove is the PV\'s first move; empty pv -> null bestmove', () => {
        expect(fromEngineInfo(info({ pv: ['d2d4', 'g8f6'] })).display.bestmove).toBe('d2d4')
        expect(fromEngineInfo(info({ pv: [] })).display.bestmove).toBeNull()
    })

    test('score converts with no sign flip (protocol.ts\'s documented identity conversion)', () => {
        const rc = fromEngineInfo(info({ score: { type: 'cp', value: -140 } }))
        expect(rc.display.eval).toEqual({ type: 'cp', value: -140 })
    })
})

describe('isRaceCandidateBetter / pickDisplayed', () => {
    test('null current always loses to any incoming candidate', () => {
        const incoming = fromEngineInfo(info({ depth: 1 }))
        expect(isRaceCandidateBetter(null, incoming, 1)).toBeTrue()
        expect(pickDisplayed(null, incoming, 1)).toBe(incoming)
    })

    test('the practical consequence from the task: a deep cached result displays first, then a local result overtakes it once it goes deeper', () => {
        const cached = fromAnalysis(analysis({ source: 'cache', depth: 24 }))
        const shallowLocal = fromEngineInfo(info({ depth: 10 }))
        const deepLocal = fromEngineInfo(info({ depth: 30 }))

        // Deep cache beats shallow local — stays on screen.
        expect(isRaceCandidateBetter(cached, shallowLocal, 1)).toBeFalse()
        expect(pickDisplayed(cached, shallowLocal, 1)).toBe(cached)

        // Once local exceeds the cached depth, it takes over.
        expect(isRaceCandidateBetter(cached, deepLocal, 1)).toBeTrue()
        expect(pickDisplayed(cached, deepLocal, 1)).toBe(deepLocal)
    })

    test('a server result at equal depth holds the display against local, whatever local searched', () => {
        const server = fromAnalysis(analysis({ source: 'engine', depth: 20, bestmove: 'e2e4' }))
        const localMoreNodes = fromEngineInfo(info({ depth: 20, nodes: 999_999 }))
        // Local must be STRICTLY deeper to take over. The node counts are not
        // comparable across the two sources anyway — /analyze reports none — so
        // letting them decide a tie was arbitrary, and in practice always handed
        // the display to whichever local result arrived at the same depth.
        expect(isRaceCandidateBetter(server, localMoreNodes, 1)).toBeFalse()
        expect(isRaceCandidateBetter(server, fromEngineInfo(info({ depth: 21 })), 1)).toBeTrue()
    })

    test('source never affects the decision on its own — depth and pvCount do', () => {
        const local = fromEngineInfo(info({ depth: 15 }))
        const cache = fromAnalysis(analysis({ source: 'cache', depth: 15, bestmove: 'e2e4' }))
        // Equal depth: local does not displace the server-side result...
        expect(isRaceCandidateBetter(cache, local, 1)).toBeFalse()
        // ...and a deeper local one does, regardless of which side it came from.
        expect(isRaceCandidateBetter(cache, fromEngineInfo(info({ depth: 16 })), 1)).toBeTrue()
    })
})
