// Orchestrates the in-browser local engine for the analysis board: capability
// detection, the persisted on/off setting, the first-enable download, and
// streaming analysis for whatever position the caller says is active. Every
// side effect below is gated on `enabled` (the persisted `engine.enabled`
// setting, default false) — a user who has never opted in never touches
// bigFileStorage, never constructs a Worker, never fetches the net. This is
// the ONE hard requirement this file exists to satisfy: with the setting off,
// mounting this hook must be indistinguishable from not calling it at all.
//
// Deliberately thin: capability math lives in features.ts, the download
// state machine in downloadState.ts, and the Analysis/EngineInfo → precedence
// adapter in evalAdapter.ts — all pure and unit-tested. This file is the glue
// that isn't practical to unit test (real effects, a real Worker/OPFS
// boundary), so it stays as small as it can.
import { useEffect, useMemo, useReducer, useRef, useState } from 'react'
import { bigFileStorage } from './bigFileStorage'
import { LOCAL_ENGINE_NET_URL, LOCAL_ENGINE_WORKER_URL } from './config'
import { type DownloadState, INITIAL_DOWNLOAD_STATE, reduceDownloadState } from './downloadState'
import { fromEngineInfo, type RaceCandidate } from './evalAdapter'
import { type Feature, features } from './features'
import { createLocalEngine, createWorkerUciModule, type LocalEngine } from './localEngine'
import { useLocalEngineEnabled } from './settings'

export interface EngineCapability {
    available: boolean
    reason?: string
}

/**
 * `wasm` is the hard requirement — nothing runs at all without it. Missing
 * `simd` is deliberately NOT treated as unavailable: Lichess ships a
 * non-SIMD fallback build for exactly this case rather than refusing to run,
 * and the (not-yet-built) chessgo wasm module is expected to do the same. If
 * the real module turns out to require SIMD unconditionally, tighten this
 * check to match — it is the one place that decision lives.
 */
function computeCapability(feat: ReadonlySet<Feature>): EngineCapability {
    if (!feat.has('wasm')) {
        return { available: false, reason: "This browser doesn't support WebAssembly, which the local engine needs." }
    }
    return { available: true }
}

export interface LocalEngineRaceOptions {
    /** Whether the CURRENT position is a valid target for local analysis right
     * now — mirrors the existing ANALYSIS_LADDER effect's own gates (not duck,
     * not game-over, not still loading a game). Local analysis only actually
     * runs once this AND the persisted setting AND a ready net are all true. */
    active: boolean
    fen: string
}

export interface LocalEngineRaceState {
    capability: EngineCapability
    enabled: boolean
    setEnabled: (v: boolean) => void
    download: DownloadState
    /** Re-attempt after an `error` state (e.g. a corrupt net was evicted and
     * needs re-downloading). No-op in any other state. */
    retry: () => void
    /** Latest local result for the CURRENT `fen`, or null if there isn't one
     * yet (not enabled, still loading, or nothing has streamed in for this
     * position). Reset to null whenever `fen` changes. */
    candidate: RaceCandidate | null
}

export function useLocalEngineRace({ active, fen }: LocalEngineRaceOptions): LocalEngineRaceState {
    const [enabled, setEnabled] = useLocalEngineEnabled()
    // features() is a memoized, synchronous, side-effect-free probe (no
    // network/storage) — safe to compute even while `enabled` is false, which
    // is what lets the UI explain WHY the toggle isn't offered instead of just
    // hiding it (see the task's "explain briefly why" requirement).
    const capability = useMemo(() => computeCapability(features()), [])
    const [download, dispatch] = useReducer(reduceDownloadState, INITIAL_DOWNLOAD_STATE)
    const [candidate, setCandidate] = useState<RaceCandidate | null>(null)
    const engineRef = useRef<LocalEngine | null>(null)
    // Bumped by retry() to force the lifecycle effect to run again after an
    // error, without needing `download` itself as a dependency (which would
    // re-trigger — and restart the download — on every progress tick).
    const [retryTick, setRetryTick] = useState(0)

    // --- Engine lifecycle: resolve the net (cache hit or download), spin up
    // the module, complete the UCI handshake. The whole body is a no-op
    // unless BOTH `enabled` and `capability.available` are true. ---
    useEffect(() => {
        if (!enabled || !capability.available) return

        let cancelled = false
        dispatch({ type: 'start' })

        void (async () => {
            const engine = createLocalEngine({
                netUrl: LOCAL_ENGINE_NET_URL,
                createModule: createWorkerUciModule(LOCAL_ENGINE_WORKER_URL),
                // Progress only ever fires for a REAL download — bigFileStorage.get()
                // resolves an existing local copy without calling onProgress at all,
                // so a cache hit goes straight from 'checking' to 'complete' below.
                fetchNet: (url) =>
                    bigFileStorage.get(url, (loaded, total) => {
                        if (!cancelled) dispatch({ type: 'progress', loaded, total })
                    }),
            })
            engineRef.current = engine
            const result = await engine.init()
            if (cancelled) return
            if (!result.ok) {
                if (result.error.kind === 'bad_net') {
                    // Corrupt local copy — evict so a later retry re-downloads
                    // instead of loading the same broken bytes again (Lichess's
                    // BAD_NNUE handling — see localEngine.ts's EngineLoadError doc).
                    await bigFileStorage.delete(LOCAL_ENGINE_NET_URL).catch(() => {})
                }
                dispatch({ type: 'fail', message: result.error.message })
                engine.dispose()
                engineRef.current = null
                return
            }
            dispatch({ type: 'complete' })
        })()

        return () => {
            cancelled = true
            engineRef.current?.dispose()
            engineRef.current = null
            dispatch({ type: 'reset' })
        }
    }, [enabled, capability.available, retryTick])

    // --- Streaming analysis for the current position, once the engine is
    // ready. No-op unless the caller says this position is worth analyzing
    // AND the net has finished loading. ---
    useEffect(() => {
        if (!active || download.status !== 'ready' || !engineRef.current) return
        setCandidate(null) // don't keep showing the PREVIOUS position's local eval
        let cancelled = false
        const ac = new AbortController()
        const engine = engineRef.current
        void (async () => {
            try {
                for await (const info of engine.analyze(fen, { multipv: 1, signal: ac.signal })) {
                    if (cancelled) return
                    // A bound-flagged score is an aspiration-window fail-high/low
                    // placeholder, not a settled value — protocol.ts's documented
                    // policy is to hold the last exact score rather than show it.
                    if (info.bound) continue
                    setCandidate(fromEngineInfo(info))
                }
            } catch {
                // Local search errored mid-stream (worker crash, etc). The server
                // ladder keeps going regardless — leave the last local result (if
                // any) in place rather than clearing a valid, if now-stale, eval.
            }
        })()
        return () => {
            cancelled = true
            ac.abort()
        }
    }, [active, download.status, fen])

    return {
        capability,
        enabled,
        setEnabled,
        download,
        retry: () => setRetryTick((t) => t + 1),
        candidate,
    }
}
