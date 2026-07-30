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

// Deepening runs as a series of SHORT, WALL-CLOCK-BOUNDED `go` calls rather
// than one long one, because the chunk length is what sets abort latency.
//
// The wasm build is single-threaded, so once a `go` is sent there is no way to
// interrupt it before its `bestmove`: a UCI `stop` would need the worker to
// process an incoming message while its own synchronous search loop is
// running, which a single-threaded wasm instance cannot do. uci.cpp says as
// much where it runs the search inline under __EMSCRIPTEN__ — "callers must
// bound every `go` with movetime/depth/nodes".
//
// So `opts.signal` is only ever checked BETWEEN chunks, and the worst case for
// reacting to it is one chunk. With depth-bounded rungs that worst case was a
// whole depth-22 search: play a move and the engine kept grinding the position
// you had just left, for seconds, before it even looked at the new one. With
// CHUNK_MS it is a quarter second.
//
// This costs almost nothing, because the transposition table stays warm across
// calls on the same position — each chunk resumes roughly where the last one
// stopped instead of restarting the work (the same principle as the server's
// stateless-but-TT-warm /analyze calls; see Analysis.tsx's ANALYSIS_LADDER).
// Chunk length RAMPS. A flat short chunk keeps abort snappy but pays the
// restart cost over and over — every `go` re-runs iterative deepening from ply
// 1, and even with a warm table that re-derivation is not free: a flat 250ms
// chunk took 9959ms to settle at depth 22 versus 4452ms unchunked.
//
// Ramping tracks how likely the user is to move. The first chunks are short,
// because a move right after arriving at a position is common and that is
// exactly when a long uninterruptible search is most annoying. Once someone has
// sat on a position for a couple of seconds they are reading, not moving, so
// the chunks lengthen and the restart overhead falls away.
const CHUNK_START_MS = 150
const CHUNK_MAX_MS = 700
const TOTAL_BUDGET_MS = 20_000
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
    // ALWAYS sent, including for multipv 1. `setoption` is sticky for the life
    // of the module, so skipping it at width 1 left a previous wide search's
    // MultiPV in place — the deep single-line phase silently ran at width 5 and
    // took 17s instead of 2s.
    module.send(`setoption name MultiPV value ${multipv}`)

    // Deepen in short wall-clock CHUNKS toward maxDepth, rather than one long
    // `go`. Each chunk is bounded by movetime, so the longest an abort can be
    // stuck behind an uninterruptible search is one chunk — the difference
    // between the board reacting to a move in ~a quarter second and sitting
    // there finishing a depth-22 search of the position you just left.
    // The transposition table stays warm across chunks, so each one resumes
    // roughly where the last stopped instead of restarting the work.
    const deadline = Date.now() + TOTAL_BUDGET_MS
    let reached = 0
    let chunkMs = CHUNK_START_MS
    while (reached < maxDepth && Date.now() < deadline) {
        if (opts.signal?.aborted) return

        const infos = await runOneRung(module, maxDepth, chunkMs)
        chunkMs = Math.min(chunkMs * 2, CHUNK_MAX_MS)
        for (const info of infos) {
            yield info
            if (info.depth > reached) reached = info.depth
        }
        // A chunk that produced no info at all means the engine has nothing more
        // to say for this position (mate/stalemate, or an instant book answer) —
        // looping would spin.
        if (infos.length === 0) return
    }
}

/** Send one bounded `go depth N movetime M`, collect every `info` line with a
 * score until `bestmove` arrives, then resolve with them in arrival order.
 * `movetime` is what makes the call wall-clock bounded, and therefore what
 * bounds how long an abort has to wait — see analyzeStream. */
function runOneRung(module: UciModule, targetDepth: number, movetimeMs: number): Promise<EngineInfo[]> {
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
        module.send(`go depth ${targetDepth} movetime ${movetimeMs}`)
    })
}
