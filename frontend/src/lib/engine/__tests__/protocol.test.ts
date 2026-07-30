// Runs under `bun test`. Pure functions, no I/O — every case here is just
// "feed a line, check the shape (or null) that comes back".
import { describe, expect, test } from 'bun:test'
import { engineScoreToAnalysisEval, parseBestmove, parseInfo } from '../protocol'

describe('parseInfo', () => {
    test('a realistic full info line parses every field', () => {
        const line =
            'info depth 12 seldepth 18 multipv 1 score cp 34 nodes 120000 nps 850000 hashfull 234 tbhits 0 time 141 pv e2e4 e7e5 g1f3'
        const info = parseInfo(line)
        expect(info).toEqual({
            depth: 12,
            seldepth: 18,
            multipv: 1,
            score: { type: 'cp', value: 34 },
            bound: undefined,
            nodes: 120000,
            nps: 850000,
            timeMs: 141,
            pv: ['e2e4', 'e7e5', 'g1f3'],
        })
    })

    test('fields in scrambled order still parse (pv stays last, per UCI convention)', () => {
        const line = 'info score cp 34 seldepth 18 nps 850000 depth 12 multipv 3 nodes 120000 time 141 pv e2e4 e7e5'
        const info = parseInfo(line)
        expect(info).toEqual({
            depth: 12,
            seldepth: 18,
            multipv: 3,
            score: { type: 'cp', value: 34 },
            bound: undefined,
            nodes: 120000,
            nps: 850000,
            timeMs: 141,
            pv: ['e2e4', 'e7e5'],
        })
    })

    test('score mate -3 and score cp -3 are distinguished by type, not just sign', () => {
        const mate = parseInfo('info depth 8 score mate -3 pv h1h8')
        const cp = parseInfo('info depth 8 score cp -3 pv h1h8')
        expect(mate?.score).toEqual({ type: 'mate', value: -3 })
        expect(cp?.score).toEqual({ type: 'cp', value: -3 })
    })

    test('lowerbound and upperbound are flagged on `bound`, and the line still parses otherwise', () => {
        // POLICY (see EngineInfo.bound doc in protocol.ts): a bound-flagged score
        // is still parsed and returned — the depth/nodes/pv on the line are real —
        // it's just marked so a caller can choose not to treat it as a settled eval.
        const lower = parseInfo('info depth 10 score cp 34 lowerbound nodes 500 pv e2e4')
        const upper = parseInfo('info depth 10 score cp 34 upperbound nodes 500 pv e2e4')
        const exact = parseInfo('info depth 10 score cp 34 nodes 500 pv e2e4')
        expect(lower?.bound).toBe('lower')
        expect(upper?.bound).toBe('upper')
        expect(exact?.bound).toBe(undefined)
        expect(lower?.score).toEqual({ type: 'cp', value: 34 })
        expect(lower?.depth).toBe(10)
        expect(lower?.nodes).toBe(500)
    })

    test('info string lines carry no evaluation and return null', () => {
        expect(parseInfo('info string NNUE evaluation using nn-abcdef.nnue')).toBeNull()
        expect(parseInfo('info string')).toBeNull()
    })

    test('info currmove/currmovenumber progress pings carry no evaluation and return null', () => {
        expect(parseInfo('info depth 5 currmove e2e4 currmovenumber 1')).toBeNull()
    })

    test('truncated or garbage lines return null, never throw', () => {
        expect(() => parseInfo('')).not.toThrow()
        expect(parseInfo('')).toBeNull()
        expect(() => parseInfo('info depth')).not.toThrow()
        expect(parseInfo('info depth')).toBeNull() // no score => null even though depth was seen
        expect(parseInfo('info depth abc score cp 5 pv e2e4')).toEqual({
            depth: 0, // unparsable depth token falls back to 0 rather than crashing
            seldepth: undefined,
            multipv: undefined,
            score: { type: 'cp', value: 5 },
            bound: undefined,
            nodes: undefined,
            nps: undefined,
            timeMs: undefined,
            pv: ['e2e4'],
        })
        expect(() => parseInfo('this is not a uci line at all')).not.toThrow()
        expect(parseInfo('this is not a uci line at all')).toBeNull()
        expect(parseInfo('bestmove e2e4')).toBeNull() // wrong command entirely
    })
})

describe('parseBestmove', () => {
    test('bestmove with a ponder move', () => {
        expect(parseBestmove('bestmove e2e4 ponder e7e5')).toEqual({ bestmove: 'e2e4', ponder: 'e7e5' })
    })

    test('bare bestmove with no ponder', () => {
        expect(parseBestmove('bestmove e2e4')).toEqual({ bestmove: 'e2e4' })
    })

    test('bestmove (none) — no legal moves — parses without a ponder', () => {
        expect(parseBestmove('bestmove (none)')).toEqual({ bestmove: '(none)' })
    })

    test('truncated/garbage lines return null, never throw', () => {
        expect(() => parseBestmove('')).not.toThrow()
        expect(parseBestmove('')).toBeNull()
        expect(parseBestmove('bestmove')).toBeNull() // missing the move token entirely
        expect(parseBestmove('info depth 5')).toBeNull() // wrong command
    })
})

describe('engineScoreToAnalysisEval', () => {
    test('is an identity conversion — UCI score and Analysis.eval share the same side-to-move POV', () => {
        expect(engineScoreToAnalysisEval({ type: 'cp', value: 34 })).toEqual({ type: 'cp', value: 34 })
        expect(engineScoreToAnalysisEval({ type: 'mate', value: -3 })).toEqual({ type: 'mate', value: -3 })
    })
})
