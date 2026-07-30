// Runs under `bun test`. Pure comparison logic — no engine, no DOM, no network.
import { describe, expect, test } from 'bun:test'
import type { AnalysisLine } from '../../../api/client'
import { pickDeeper } from '../ownership'

function line(depth: number, bestmove: string): AnalysisLine {
    return { bestmove, san: bestmove, eval: { type: 'cp', value: 20 }, pv: [bestmove], depth }
}

describe('pickDeeper', () => {
    test('a deeper cached row beats local outright', () => {
        // The case that matters most: an imported Lichess row at depth 80 against
        // local's depth-22 ceiling. Local must not displace it.
        const winner = pickDeeper([line(80, 'e2e4')], [line(22, 'g1f3')])
        expect(winner?.source).toBe('cache')
        expect(winner?.lines[0].bestmove).toBe('e2e4')
    })

    test('a deeper local search beats a shallow cached row', () => {
        const winner = pickDeeper([line(12, 'e2e4')], [line(22, 'g1f3')])
        expect(winner?.source).toBe('local')
        expect(winner?.lines[0].bestmove).toBe('g1f3')
    })

    test('ties go to the cache — a stored Stockfish result outranks ours at equal depth', () => {
        const winner = pickDeeper([line(22, 'e2e4')], [line(22, 'g1f3')])
        expect(winner?.source).toBe('cache')
    })

    test('either side alone wins by default', () => {
        expect(pickDeeper([line(22, 'e2e4')], null)?.source).toBe('cache')
        expect(pickDeeper(null, [line(6, 'g1f3')])?.source).toBe('local')
        expect(pickDeeper([], [line(6, 'g1f3')])?.source).toBe('local')
    })

    test('no answer at all is null, not an empty winner', () => {
        expect(pickDeeper(null, null)).toBeNull()
        expect(pickDeeper([], [])).toBeNull()
    })

    test('the winner is returned WHOLE — never a mix of both', () => {
        // The arrow, the eval and every line must come from one search. Merging
        // per-slot is what put an arrow for one move above a first line for
        // another.
        const cached = [line(80, 'e2e4')]
        const local = [line(22, 'g1f3'), line(22, 'b1c3'), line(22, 'd2d4')]
        const winner = pickDeeper(cached, local)
        expect(winner?.lines).toBe(cached)
        expect(winner?.lines).not.toContain(local[1])
    })
})
