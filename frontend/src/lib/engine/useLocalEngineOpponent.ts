// A local (in-browser) engine as a MOVE SOURCE — one bestmove for one position,
// on demand. This is the Engine-vs-Engine page's need, and it is deliberately not
// useLocalEngineRace: that hook streams a live evaluation of whatever position the
// user is looking at and races it against the server. Here nobody is racing
// anything; the engine is a player, asked for exactly one move per ply.
//
// Sharing the download/lifecycle machinery matters though — the net is ~36 MB over
// the wire and is keyed in bigFileStorage by URL, so an EvE match reuses whatever
// the analysis board already downloaded, and vice versa.
import { useCallback, useEffect, useRef, useState } from 'react'
import { bigFileStorage } from './bigFileStorage'
import { LOCAL_ENGINE_AVAILABLE, LOCAL_ENGINE_NET_URL, LOCAL_ENGINE_WORKER_URL } from './config'
import { type DownloadState, INITIAL_DOWNLOAD_STATE, reduceDownloadState } from './downloadState'
import { features } from './features'
import { createLocalEngine, createWorkerUciModule, type LocalEngine } from './localEngine'

/** Depth ceiling when the caller pins MOVETIME instead of depth. The search is
 *  cut off by the clock well before this on any normal budget; it exists only so
 *  the iteration terminates on a position the engine solves instantly. */
const MOVETIME_DEPTH_CEILING = 30

export interface MoveLimit {
    /** Wall-clock budget in ms. Honoured by stopping between the engine's own
     *  deepening chunks, so the real spend overshoots by at most one chunk. */
    movetime?: number
    /** Fixed depth. Takes precedence over movetime when both are set, matching
     *  the server side of this page. */
    depth?: number
}

export interface LocalEngineOpponent {
    /** Whether this browser can run it at all (wasm + a net shipped with the build). */
    supported: boolean
    /** Net download / module boot progress. 'ready' means bestMove() will answer. */
    download: DownloadState
    /** Start loading. Safe to call repeatedly; only the first call does work. */
    load: () => void
    /** Search `fen` and resolve the chosen move in UCI, or null if the engine has
     *  none (mate/stalemate), isn't ready, or errored. */
    bestMove: (fen: string, limit: MoveLimit) => Promise<string | null>
}

export function useLocalEngineOpponent(): LocalEngineOpponent {
    const supported = features().has('wasm') && LOCAL_ENGINE_AVAILABLE
    const [download, setDownload] = useState<DownloadState>(INITIAL_DOWNLOAD_STATE)
    const engineRef = useRef<LocalEngine | null>(null)
    const loadingRef = useRef(false)

    const dispatch = useCallback((event: Parameters<typeof reduceDownloadState>[1]) => {
        setDownload((prev) => reduceDownloadState(prev, event))
    }, [])

    const load = useCallback(() => {
        if (!supported || loadingRef.current || engineRef.current) return
        loadingRef.current = true
        dispatch({ type: 'start' })

        void (async () => {
            const engine = createLocalEngine({
                netUrl: LOCAL_ENGINE_NET_URL,
                createModule: createWorkerUciModule(LOCAL_ENGINE_WORKER_URL),
                fetchNet: (url) =>
                    bigFileStorage.get(url, (loaded, total) => dispatch({ type: 'progress', loaded, total })),
            })
            const result = await engine.init()
            if (result.ok) {
                engineRef.current = engine
                dispatch({ type: 'complete' })
                return
            }
            // A corrupt cached net will never fix itself on the next get() — evict it
            // so a retry actually re-downloads. Same handling as the analysis board's,
            // and the same precedent as Lichess's BAD_NNUE path.
            if (result.error.kind === 'bad_net') {
                await bigFileStorage.delete(LOCAL_ENGINE_NET_URL).catch(() => {})
            }
            loadingRef.current = false
            dispatch({ type: 'fail', message: result.error.message })
        })()
    }, [supported, dispatch])

    useEffect(
        () => () => {
            engineRef.current?.dispose()
            engineRef.current = null
        },
        [],
    )

    const bestMove = useCallback(async (fen: string, limit: MoveLimit): Promise<string | null> => {
        const engine = engineRef.current
        if (!engine) return null

        const depthLimited = typeof limit.depth === 'number' && limit.depth > 0
        const deadline = depthLimited ? Infinity : Date.now() + (limit.movetime ?? 300)
        const targetDepth = depthLimited ? limit.depth! : MOVETIME_DEPTH_CEILING

        // Take the first move of the DEEPEST line seen. analyze() streams `info` per
        // deepening step, so this is the engine's latest opinion whether the search
        // ran to its depth target or was cut off by the clock.
        let deepest = -1
        let best: string | null = null
        try {
            for await (const info of engine.analyze(fen, { multipv: 1, depth: targetDepth })) {
                if (info.pv.length > 0 && info.depth > deepest) {
                    deepest = info.depth
                    best = info.pv[0]
                }
                // Between chunks only — a single-threaded wasm search cannot be
                // interrupted mid-flight, so the budget overshoots by at most one
                // chunk. Same contract analyze() documents for its abort signal.
                if (Date.now() >= deadline) break
            }
        } catch {
            return null
        }
        return best
    }, [])

    return { supported, download, load, bestMove }
}
