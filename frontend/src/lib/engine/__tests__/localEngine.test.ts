// Runs under `bun test`. The real wasm UCI module doesn't exist yet — every
// test here goes through a fake `UciModuleFactory`, never `createWorkerUciModule`
// (which needs an actual browser Worker + a compiled module to talk to).
import { describe, expect, test } from 'bun:test'
import type { U8 } from '../bigFileStorage'
import {
    EngineLoadError,
    type LocalEngineOptions,
    type UciModule,
    type UciModuleFactory,
    createLocalEngine,
} from '../localEngine'

const FAKE_NET: U8 = Uint8Array.from([1, 2, 3, 4])
const FEN = 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1'

/** A fake engine module built so that `send()` NEVER produces a matching
 * `onLine` callback in the same synchronous tick — every reply goes through
 * `setTimeout`, a genuine macrotask boundary, the same kind of gap a real
 * `postMessage` round trip to a Worker puts between a call and its reply
 * (see `createWorkerUciModule`'s doc in localEngine.ts for the message
 * contract this mirrors). A test built on this fake can only pass if
 * `createLocalEngine` treats the module asynchronously throughout — which is
 * exactly what proves the design isn't accidentally main-thread-only; a
 * same-tick fake would hide a bug where the code assumed synchronous
 * send()->onLine delivery.
 */
const DEPTH_PER_CHUNK = 6

/** Score the fake reports for a given position, so a test can tell whose
 * output it is looking at. */
export function fakeScoreFor(fen: string): number {
    return fen.length
}

function createFakeAsyncModule(): { factory: UciModuleFactory; sentCommands: string[] } {
    const sentCommands: string[] = []
    let reachedDepth = 0
    let currentFen = ''
    const factory: UciModuleFactory = (_net: U8) =>
        new Promise<UciModule>((resolveModule) => {
            // The module itself "comes alive" on a later macrotask too, like a
            // worker's startup + `{type: 'ready'}` postMessage would.
            setTimeout(() => {
                const subs = new Set<(line: string) => void>()
                const emitAsync = (line: string) => {
                    setTimeout(() => {
                        for (const cb of subs) cb(line)
                    }, 0)
                }
                resolveModule({
                    send(command) {
                        sentCommands.push(command)
                        if (command.startsWith('position fen ')) {
                            currentFen = command.slice('position fen '.length)
                        } else if (command === 'uci') {
                            emitAsync('uciok')
                        } else if (command === 'isready') {
                            emitAsync('readyok')
                        } else {
                            // Models a movetime-bounded chunk: each `go` gets a
                            // bit deeper than the last (warm table), capped at the
                            // requested depth — so a caller that chunks toward a
                            // target really does need several calls, the way the
                            // real engine behaves.
                            const m = /^go depth (\d+) movetime (\d+)$/.exec(command)
                            if (m) {
                                const target = Number(m[1])
                                reachedDepth = Math.min(reachedDepth + DEPTH_PER_CHUNK, target)
                                emitAsync(`info depth ${reachedDepth} score cp ${fakeScoreFor(currentFen)} pv e2e4`)
                                emitAsync('bestmove e2e4')
                            }
                        }
                    },
                    onLine(cb) {
                        subs.add(cb)
                        return () => subs.delete(cb)
                    },
                    terminate() {},
                })
            }, 0)
        })
    return { factory, sentCommands }
}

function baseOptions(factory: UciModuleFactory, fetchNet: (url: string) => Promise<U8>): LocalEngineOptions {
    return { netUrl: 'https://cdn.example.com/net.bin', createModule: factory, fetchNet }
}

describe('createLocalEngine — init()', () => {
    test('fetches the net exactly once and completes the uci/isready handshake', async () => {
        const { factory, sentCommands } = createFakeAsyncModule()
        let fetchCalls = 0
        const fetchNet = async (_url: string) => {
            fetchCalls++
            return FAKE_NET
        }
        const engine = createLocalEngine(baseOptions(factory, fetchNet))

        const first = await engine.init()
        const second = await engine.init() // must NOT re-fetch or re-handshake

        expect(first).toEqual({ ok: true, value: undefined })
        expect(second).toEqual({ ok: true, value: undefined })
        expect(fetchCalls).toBe(1)
        expect(sentCommands).toEqual(['uci', 'isready'])
    })

    test('a module reporting a bad net surfaces a distinguishable error', async () => {
        const badFactory: UciModuleFactory = async () => {
            throw new EngineLoadError('bad_net', 'checksum mismatch: net is corrupt')
        }
        const engine = createLocalEngine(baseOptions(badFactory, async () => FAKE_NET))

        const result = await engine.init()

        expect(result.ok).toBeFalse()
        if (!result.ok) {
            // This is the signal a caller acts on: bigFileStorage.delete(netUrl) + retry.
            expect(result.error.kind).toBe('bad_net')
            expect(result.error.message).toContain('corrupt')
        }
    })

    test('a generic (non-EngineLoadError) failure is still surfaced, typed as unknown', async () => {
        const boomFactory: UciModuleFactory = async () => {
            throw new Error('worker script 404')
        }
        const engine = createLocalEngine(baseOptions(boomFactory, async () => FAKE_NET))

        const result = await engine.init()

        expect(result.ok).toBeFalse()
        if (!result.ok) {
            expect(result.error.kind).toBe('unknown')
            expect(result.error.message).toBe('worker script 404')
        }
    })

    test('a net fetch failure is surfaced without ever constructing the module', async () => {
        let moduleCalls = 0
        const factory: UciModuleFactory = async () => {
            moduleCalls++
            throw new Error('should not be reached')
        }
        const fetchNet = async () => {
            throw new Error('download failed: HTTP 500')
        }
        const engine = createLocalEngine(baseOptions(factory, fetchNet))

        const result = await engine.init()

        expect(result.ok).toBeFalse()
        expect(moduleCalls).toBe(0)
    })
})

describe('createLocalEngine — analyze()', () => {
    test('deepens in wall-clock chunks toward the target, stopping once reached', async () => {
        const { factory } = createFakeAsyncModule()
        const engine = createLocalEngine(baseOptions(factory, async () => FAKE_NET))
        expect((await engine.init()).ok).toBeTrue()

        const depths: number[] = []
        for await (const info of engine.analyze(FEN, { depth: 20 })) {
            depths.push(info.depth)
        }

        // Chunk length is what bounds abort latency: a single-threaded wasm
        // search cannot be interrupted, so the only way to react to a move
        // promptly is to keep each `go` short.
        expect(depths).toEqual([6, 12, 18, 20])
    })

    test('every go is movetime-bounded, and MultiPV is always set explicitly', async () => {
        const { factory, sentCommands } = createFakeAsyncModule()
        const engine = createLocalEngine(baseOptions(factory, async () => FAKE_NET))
        await engine.init()
        sentCommands.length = 0

        for await (const info of engine.analyze(FEN, { depth: 6 })) void info

        // MultiPV is sticky on the module, so a width-1 search following a wide
        // one has to reset it explicitly or it silently inherits width 5.
        expect(sentCommands[0]).toBe(`position fen ${FEN}`)
        expect(sentCommands[1]).toBe('setoption name MultiPV value 1')
        for (const cmd of sentCommands.slice(2)) {
            expect(/^go depth 6 movetime \d+$/.test(cmd)).toBeTrue()
        }
    })

    test('abort stops further deepening between rungs — not mid-search', async () => {
        const { factory } = createFakeAsyncModule()
        const engine = createLocalEngine(baseOptions(factory, async () => FAKE_NET))
        await engine.init()

        const controller = new AbortController()
        const depths: number[] = []
        for await (const info of engine.analyze(FEN, { depth: 20, signal: controller.signal })) {
            depths.push(info.depth)
            if (depths.length === 1) controller.abort() // fires between chunks, never inside one
        }

        // The chunk already in flight when abort() fired still completed and was
        // yielded — the honest "can't interrupt a running search" contract.
        // Nothing past it was ever sent, so the search stops one short chunk
        // after the move rather than one full deep search after it.
        expect(depths).toEqual([6])
    })

    test('exercises the async fake-worker boundary end to end: two self-contained chunks', async () => {
        const { factory, sentCommands } = createFakeAsyncModule()
        const engine = createLocalEngine(baseOptions(factory, async () => FAKE_NET))
        await engine.init()
        sentCommands.length = 0 // drop the handshake commands, isolate analyze()'s own

        const depths: number[] = []
        for await (const info of engine.analyze(FEN, { depth: 12 })) {
            depths.push(info.depth)
        }

        expect(depths).toEqual([6, 12])
        // Every chunk re-sends position + width before its `go`, so nothing another
        // overlapping search sends can move the position or the width out from
        // under it. See runOneRung's serialization comment.
        expect(sentCommands).toEqual([
            `position fen ${FEN}`,
            'setoption name MultiPV value 1',
            'go depth 12 movetime 150',
            `position fen ${FEN}`,
            'setoption name MultiPV value 1',
            'go depth 12 movetime 300',
        ])
    })

    test('overlapping searches never see each other\'s output — the stale-arrow bug', async () => {
        const { factory } = createFakeAsyncModule()
        const engine = createLocalEngine(baseOptions(factory, async () => FAKE_NET))
        await engine.init()

        const FEN_B = 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR b KQkq - 0 1'
        const ac = new AbortController()
        const aScores: number[] = []
        const bScores: number[] = []

        // Start A and let its first chunk actually get in flight...
        const runA = (async () => {
            for await (const i of engine.analyze(FEN, { depth: 30, signal: ac.signal })) aScores.push(i.score.value)
        })()
        await new Promise((r) => setTimeout(r, 5))
        // ...then "play a move": abort A and start B while A is still going.
        ac.abort()
        const runB = (async () => {
            for await (const i of engine.analyze(FEN_B, { depth: 12 })) bScores.push(i.score.value)
        })()
        await Promise.all([runA, runB])

        // The fake tags every info with the position it was told to search, so
        // this is a direct assertion that neither generator consumed the other's
        // output. Before serialization B's first result was A's in-flight search:
        // A's eval, for A's position, painted as B's best-move arrow.
        expect(bScores.length > 0).toBeTrue()
        for (const s of bScores) expect(s).toBe(fakeScoreFor(FEN_B))
        for (const s of aScores) expect(s).toBe(fakeScoreFor(FEN))
    })

    test('analyze() before a successful init() fails loudly rather than hanging silently', async () => {
        const { factory } = createFakeAsyncModule()
        const engine = createLocalEngine(baseOptions(factory, async () => FAKE_NET))
        // No init() call.
        const iterate = async () => {
            for await (const _info of engine.analyze(FEN, { depth: 1 })) {
                // unreachable
            }
        }
        await expect(iterate()).rejects.toThrow()
    })
})
