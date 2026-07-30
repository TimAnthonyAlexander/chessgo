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
function createFakeAsyncModule(): { factory: UciModuleFactory; sentCommands: string[] } {
    const sentCommands: string[] = []
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
                        if (command === 'uci') {
                            emitAsync('uciok')
                        } else if (command === 'isready') {
                            emitAsync('readyok')
                        } else {
                            const m = /^go depth (\d+)$/.exec(command)
                            if (m) {
                                const depth = m[1]
                                emitAsync(`info depth ${depth} score cp ${depth} pv e2e4`)
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
    test('streams one EngineInfo per increasing depth, in order, and terminates', async () => {
        const { factory } = createFakeAsyncModule()
        const engine = createLocalEngine(baseOptions(factory, async () => FAKE_NET))
        expect((await engine.init()).ok).toBeTrue()

        const depths: number[] = []
        for await (const info of engine.analyze(FEN, { depth: 5 })) {
            depths.push(info.depth)
        }

        expect(depths).toEqual([1, 2, 3, 4, 5])
    })

    test('abort stops further deepening between rungs — not mid-search', async () => {
        const { factory } = createFakeAsyncModule()
        const engine = createLocalEngine(baseOptions(factory, async () => FAKE_NET))
        await engine.init()

        const controller = new AbortController()
        const depths: number[] = []
        for await (const info of engine.analyze(FEN, { depth: 5, signal: controller.signal })) {
            depths.push(info.depth)
            if (depths.length === 1) controller.abort() // fires between rungs, never inside one
        }

        // The rung already in flight when abort() fired (depth 1) still completed
        // and was yielded — the honest "can't interrupt a running search"
        // contract. Nothing past it was ever sent.
        expect(depths).toEqual([1])
    })

    test('exercises the async fake-worker boundary end to end: position + two bounded go calls', async () => {
        const { factory, sentCommands } = createFakeAsyncModule()
        const engine = createLocalEngine(baseOptions(factory, async () => FAKE_NET))
        await engine.init()
        sentCommands.length = 0 // drop the handshake commands, isolate analyze()'s own

        const scores: number[] = []
        for await (const info of engine.analyze(FEN, { depth: 2 })) {
            scores.push(info.score.value)
        }

        expect(scores).toEqual([1, 2])
        expect(sentCommands).toEqual([`position fen ${FEN}`, 'go depth 1', 'go depth 2'])
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
