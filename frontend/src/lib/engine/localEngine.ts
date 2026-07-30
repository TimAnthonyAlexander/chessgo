// Async wrapper over the eventual wasm UCI engine module — the piece that
// turns "send command strings, receive output lines" into `init()` /
// `analyze()` / `dispose()`. The compiled module itself doesn't exist yet (a
// separate agent is building it); everything here is written against the
// `UciModule` interface below and an injectable `UciModuleFactory`, so this
// file is fully testable today with a fake and needs no changes once the real
// module lands — only a real factory (see `createWorkerUciModule`) gets wired
// in at the app's call site.
import { type U8, bigFileStorage } from './bigFileStorage'
import { type EngineInfo, parseBestmove, parseInfo } from './protocol'

// ---------------------------------------------------------------------------
// The module boundary
// ---------------------------------------------------------------------------

/** The minimum surface we need from the compiled engine, whatever process it
 * actually runs in. Modeled as a plain command-in/line-out pipe — exactly how
 * a UCI engine talks over stdio, just replacing the pipe with `send`/`onLine`.
 * Production hands in a module that proxies to a Web Worker (see
 * `createWorkerUciModule`); tests hand in an in-process fake. Neither this
 * file nor `analyze()`'s caller can tell the difference, which is the point —
 * a worker boundary is inherently async (postMessage), so nothing here may
 * assume `send()` produces a line synchronously. */
export interface UciModule {
    /** Send one UCI command line (no trailing newline). */
    send(command: string): void
    /** Subscribe to output lines (one call per line, in order). Returns an
     * unsubscribe function. */
    onLine(cb: (line: string) => void): () => void
    /** Release any resources (worker, wasm instance, loaded net, ...). */
    terminate(): void
}

/** Builds a `UciModule` given the net's bytes. Async because loading ~90MB of
 * NNUE weights into a wasm instance is not instant, and because the real
 * factory has to spin up a worker and wait for it to come alive. Rejects with
 * an `EngineLoadError` (or any Error, normalized the same way — see
 * `toLocalEngineError`) if the module fails to come up at all, e.g. a
 * corrupt/truncated net. */
export type UciModuleFactory = (net: U8) => Promise<UciModule>

export type LocalEngineErrorKind = 'bad_net' | 'load_failed' | 'unresponsive' | 'unknown'

/** Thrown/rejected-with by a `UciModuleFactory` (or a `UciModule` internally)
 * to report a load failure in a way `createLocalEngine` can tell apart from a
 * generic error. `kind: 'bad_net'` is the one the caller acts on directly —
 * Lichess's `BAD_NNUE` handling is the precedent: on that signal, evict the
 * cached net (`bigFileStorage.delete(url)`) and retry, since a corrupt local
 * copy won't fix itself on the next `get()` otherwise. */
export class EngineLoadError extends Error {
    readonly kind: LocalEngineErrorKind
    constructor(kind: LocalEngineErrorKind, message: string) {
        super(message)
        this.name = 'EngineLoadError'
        this.kind = kind
    }
}

export interface LocalEngineError {
    kind: LocalEngineErrorKind
    message: string
}

// Errors are always returned, never thrown into the void — `init()`'s caller
// gets a typed result it must look at, not a promise it might forget to catch.
export type LocalEngineResult<T> = { ok: true; value: T } | { ok: false; error: LocalEngineError }

function toLocalEngineError(err: unknown): LocalEngineError {
    if (err instanceof EngineLoadError) return { kind: err.kind, message: err.message }
    if (err instanceof Error) return { kind: 'unknown', message: err.message }
    return { kind: 'unknown', message: String(err) }
}

// ---------------------------------------------------------------------------
// Production module factory: real Web Worker
// ---------------------------------------------------------------------------

type WorkerInboundMsg =
    | { type: 'ready' }
    | { type: 'line'; line: string }
    | { type: 'error'; kind?: LocalEngineErrorKind; message?: string }

/** Production `UciModuleFactory`: runs the compiled engine in a dedicated Web
 * Worker so a search never blocks the main thread (the wasm build is
 * single-threaded and its search loop doesn't yield back to the event loop).
 * `workerUrl` is the worker script chessgo's build emits once the wasm module
 * exists — injected so this file carries zero hard dependency on a module
 * that hasn't been built yet.
 *
 * Contract this expects from the worker (ours to define, since nothing else
 * defines it yet — whoever wires the real wasm build in matches this, or this
 * factory gets a small adapter update to match theirs):
 *   - on `{type: 'init', net: Uint8Array}` (net's buffer is transferred, not
 *     copied — it's tens of MB): load the engine, then post `{type: 'ready'}`
 *     OR `{type: 'error', kind: 'bad_net' | 'load_failed', message}` once.
 *   - on `{type: 'send', command: string}`: forward `command` to the engine's
 *     stdin-equivalent.
 *   - for every UCI output line the engine produces: post
 *     `{type: 'line', line: string}`.
 */
export function createWorkerUciModule(workerUrl: string | URL): UciModuleFactory {
    return (net: U8) =>
        new Promise<UciModule>((resolve, reject) => {
            const worker = new Worker(workerUrl, { type: 'module' })
            const lineSubs = new Set<(line: string) => void>()
            let settled = false

            const fail = (err: LocalEngineError) => {
                if (settled) return
                settled = true
                worker.terminate()
                reject(new EngineLoadError(err.kind, err.message))
            }

            worker.onmessage = (e: MessageEvent<WorkerInboundMsg>) => {
                const msg = e.data
                if (msg.type === 'line') {
                    for (const cb of lineSubs) cb(msg.line)
                } else if (msg.type === 'error') {
                    fail({ kind: msg.kind ?? 'load_failed', message: msg.message ?? 'engine worker reported a load error' })
                } else if (msg.type === 'ready' && !settled) {
                    settled = true
                    resolve({
                        send(command) {
                            worker.postMessage({ type: 'send', command })
                        },
                        onLine(cb) {
                            lineSubs.add(cb)
                            return () => lineSubs.delete(cb)
                        },
                        terminate() {
                            worker.terminate()
                        },
                    })
                }
            }
            worker.onerror = (e) => fail({ kind: 'load_failed', message: e.message || 'engine worker crashed' })
            worker.postMessage({ type: 'init', net }, [net.buffer])
        })
}

// ---------------------------------------------------------------------------
// createLocalEngine
// ---------------------------------------------------------------------------

export interface LocalEngineOptions {
    /** URL of the NNUE net — both the `bigFileStorage` cache key and what gets
     * fetched on a cache miss. */
    netUrl: string
    /** Builds the module. Inject `createWorkerUciModule(...)` in production,
     * a fake in tests. */
    createModule: UciModuleFactory
    /** Resolves `netUrl` to bytes. Defaults to `bigFileStorage.get`, i.e. "use
     * the local copy if we have one, else download and persist it" — override
     * in tests to avoid real OPFS/IndexedDB/XHR. */
    fetchNet?: (url: string) => Promise<U8>
    /** How long to wait for the `uci`→`uciok`→`isready`→`readyok` handshake
     * before treating the module as unresponsive. Generous default (10s)
     * because a first-run NNUE load off a freshly-downloaded ~90MB buffer can
     * be slow, especially on a cold/throttled connection. */
    readyTimeoutMs?: number
}

export interface AnalyzeOptions {
    /** Deepest ply to search to. `analyze` streams one `EngineInfo` per depth
     * (more than one, in arrival order, when `multipv > 1`) up to this depth,
     * then completes. */
    depth?: number
    multipv?: number
    /** Stops further deepening. See file-level note in `analyzeStream` below
     * for exactly when this does and doesn't take effect — it is NOT able to
     * interrupt a search already in flight. */
    signal?: AbortSignal
}

export interface LocalEngine {
    /** Fetch the net, spin up the module, and complete the UCI handshake.
     * Idempotent — calling it again while/after a previous call is in flight
     * returns the SAME promise rather than re-fetching or re-handshaking. */
    init(): Promise<LocalEngineResult<void>>
    /** Progressively deeper `EngineInfo` results for one search on `fen`, one
     * item per `info` line that carries a score, in the order the engine
     * produced them. Terminates once `opts.depth` is reached (or the engine's
     * own budget cuts it short, or `opts.signal` is honored — see
     * `AnalyzeOptions.signal`). Must be called after a successful `init()`. */
    analyze(fen: string, opts?: AnalyzeOptions): AsyncIterable<EngineInfo>
    /** Release the module (terminates the worker) and forget init state, so a
     * later `init()` starts fresh. */
    dispose(): void
}

const DEFAULT_MAX_DEPTH = 30
const DEFAULT_READY_TIMEOUT_MS = 10_000

export function createLocalEngine(opts: LocalEngineOptions): LocalEngine {
    const { netUrl, createModule, readyTimeoutMs = DEFAULT_READY_TIMEOUT_MS } = opts
    const fetchNet = opts.fetchNet ?? ((url: string) => bigFileStorage.get(url))

    let module: UciModule | null = null
    let initPromise: Promise<LocalEngineResult<void>> | null = null

    async function handshake(m: UciModule): Promise<LocalEngineResult<void>> {
        const completed = await new Promise<boolean>((resolve) => {
            let sentIsReady = false
            const timer = setTimeout(() => {
                unsub()
                resolve(false)
            }, readyTimeoutMs)
            const unsub = m.onLine((line) => {
                const t = line.trim()
                if (t === 'uciok' && !sentIsReady) {
                    sentIsReady = true
                    m.send('isready')
                } else if (t === 'readyok' && sentIsReady) {
                    clearTimeout(timer)
                    unsub()
                    resolve(true)
                }
            })
            m.send('uci')
        })

        if (!completed) {
            return {
                ok: false,
                error: { kind: 'unresponsive', message: 'engine did not complete the uci/isready handshake in time' },
            }
        }
        return { ok: true, value: undefined }
    }

    async function doInit(): Promise<LocalEngineResult<void>> {
        let net: U8
        try {
            net = await fetchNet(netUrl)
        } catch (err) {
            return { ok: false, error: toLocalEngineError(err) }
        }

        let m: UciModule
        try {
            m = await createModule(net)
        } catch (err) {
            return { ok: false, error: toLocalEngineError(err) }
        }

        const result = await handshake(m)
        if (!result.ok) {
            m.terminate()
            return result
        }
        module = m
        return result
    }

    return {
        init() {
            // Memoized so concurrent/repeated init() calls (e.g. from re-renders)
            // fetch the net and run the handshake exactly once.
            if (!initPromise) initPromise = doInit()
            return initPromise
        },

        analyze(fen, analyzeOpts = {}) {
            return analyzeStream(() => module, fen, analyzeOpts)
        },

        dispose() {
            module?.terminate()
            module = null
            initPromise = null
        },
    }
}

// ---------------------------------------------------------------------------
// analyze() streaming
// ---------------------------------------------------------------------------

// Implemented as one bounded `go depth N` UCI call per depth rung (N = 1, 2,
// 3, ... up to the requested depth), rather than a single `go depth
// <maxDepth>` and letting the engine iteratively deepen on its own. This is
// the ABORT boundary: the wasm build is single-threaded, so once a `go` is
// sent there is no way to interrupt it before its `bestmove` — sending a UCI
// `stop` command would require the worker to process an incoming message
// while its own synchronous search loop is running, which a single-threaded
// wasm instance cannot do. So `opts.signal` is checked only BETWEEN rungs,
// right before the next `go` would be sent. That is an honest contract: abort
// stops further deepening promptly (no more rungs get sent), but it does not
// — cannot — kill whichever `go` is already in flight when it fires. Each
// rung researches from ply 1, but the engine's own transposition table stays
// warm across calls on the same position (same principle as the server's
// stateless-but-TT-warm /analyze calls — see Analysis.tsx's ANALYSIS_LADDER
// comment), so this is not N independent full searches in the naive sense.
async function* analyzeStream(
    getModule: () => UciModule | null,
    fen: string,
    opts: AnalyzeOptions,
): AsyncGenerator<EngineInfo, void, unknown> {
    const module = getModule()
    if (!module) {
        throw new Error('local engine analyze() called before a successful init()')
    }

    const maxDepth = opts.depth ?? DEFAULT_MAX_DEPTH
    const multipv = opts.multipv ?? 1

    module.send(`position fen ${fen}`)
    if (multipv > 1) module.send(`setoption name MultiPV value ${multipv}`)

    for (let target = 1; target <= maxDepth; target++) {
        if (opts.signal?.aborted) return

        const infos = await runOneRung(module, target)
        for (const info of infos) yield info
    }
}

/** Send one bounded `go depth N`, collect every `info` line with a score
 * until `bestmove` arrives, then resolve with them in arrival order. */
function runOneRung(module: UciModule, targetDepth: number): Promise<EngineInfo[]> {
    return new Promise((resolve) => {
        const infos: EngineInfo[] = []
        const unsub = module.onLine((line) => {
            const info = parseInfo(line)
            if (info) {
                infos.push(info)
                return
            }
            if (parseBestmove(line)) {
                unsub()
                resolve(infos)
            }
        })
        module.send(`go depth ${targetDepth}`)
    })
}
