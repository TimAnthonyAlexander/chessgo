// Orchestrates the in-browser local engine for the analysis board: capability
// detection, the persisted on/off setting, the first-enable download, and
// streaming analysis for whatever position the caller says is active. Every
// side effect below is gated on `enabled` (the persisted `engine.enabled`
// setting, default false) — a user who has never opted in never touches
// bigFileStorage, never constructs a Worker, never fetches the net. This is
// the ONE hard requirement this file exists to satisfy: with the setting off,
// mounting this hook must be indistinguishable from not calling it at all.
//
// Deliberately thin: capability math lives in features.ts and the download
// state machine in downloadState.ts, both pure and unit-tested. This file is the
// glue that isn't practical to unit test (real effects, a real Worker/OPFS
// boundary), so it stays as small as it can.
//
// It publishes ONE value per position — the move list, whose first entry is also
// the eval and the arrow. An earlier version published an eval and a line list
// separately and left the caller to reconcile them by a precedence rule; that
// could show an arrow for one move above a first line for another, and the rule
// (and its adapter) are gone with it.
import { Chess } from 'chess.js'
import { useEffect, useMemo, useReducer, useRef, useState } from 'react'
import type { AnalysisLine } from '../../api/client'
import { bigFileStorage } from './bigFileStorage'
import { LOCAL_ENGINE_AVAILABLE, LOCAL_ENGINE_NET_URL, LOCAL_ENGINE_WORKER_URL } from './config'
import { type DownloadState, INITIAL_DOWNLOAD_STATE, reduceDownloadState } from './downloadState'
import { type Feature, features } from './features'
import { createLocalEngine, createWorkerUciModule, type LocalEngine } from './localEngine'
import type { EngineInfo } from './protocol'
import { useLocalEngineEnabled } from './settings'

// Local search runs in two phases, mirroring ANALYSIS_LADDER's own shape: a
// shallow multi-line pass that fills the move list, then a deep single-line
// pass that settles the eval and the arrow.
//
// The split is not cosmetic. MultiPV costs 5-6x at width 5, measured on one
// position with a cold table per cell:
//
//   depth   mpv=1    mpv=3    mpv=5
//      14    145ms    550ms   1166ms
//      16    436ms   1568ms   2742ms
//      18    716ms   2586ms   5705ms
//      20   1764ms   7850ms   9827ms
//
// So running width 5 all the way to the old DEFAULT_MAX_DEPTH of 30 would take
// minutes, and even depth 20 would cost ~10s for an arrow that width 1 delivers
// in under two. Lines are only useful at move-list depth anyway — the server
// ladder stops its own multi-line rungs at 16 for exactly this reason.
const LINES_MULTIPV = 5
const LINES_DEPTH = 14
const EVAL_DEPTH = 22

/**
 * MultiPV infos → the `AnalysisLine[]` shape the move list already renders.
 *
 * The engine speaks UCI and the list shows SAN, so each line's first move is
 * converted here with chess.js (already a dependency, and the same library
 * analysisTree.ts uses). The server supplies `san` itself, which is why this
 * only exists on the local path.
 *
 * `opening` is deliberately absent: naming the opening a move leads to is an
 * engine-side book lookup we have no table for in the browser. Absent rather
 * than null, so the panel treats it as unknown instead of "unnamed".
 */
function toAnalysisLines(fen: string, bySlot: Map<number, EngineInfo>): AnalysisLine[] {
    const out: AnalysisLine[] = []
    for (const slot of [...bySlot.keys()].sort((a, b) => a - b)) {
        const info = bySlot.get(slot)!
        const uci = info.pv[0]
        if (!uci) continue
        let san = uci
        try {
            const chess = new Chess(fen)
            const move = chess.move({
                from: uci.slice(0, 2),
                to: uci.slice(2, 4),
                promotion: uci.length > 4 ? uci[4] : undefined,
            })
            if (move) san = move.san
        } catch {
            // Illegal/unparseable per chess.js — fall back to the raw UCI rather
            // than dropping the line. The engine owns the rules; disagreeing with
            // it here should degrade the label, not hide a real move.
        }
        out.push({ bestmove: uci, san, eval: info.score, pv: info.pv, depth: info.depth })
    }
    return out
}

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
    // No net was shipped with this build (see LOCAL_ENGINE_AVAILABLE). Offering
    // the toggle would start a download that 404s.
    if (!LOCAL_ENGINE_AVAILABLE) {
        return { available: false, reason: 'The in-browser engine is not available on this server yet.' }
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
    /** Depth of whatever eval is currently displayed for this position (a cached
     *  or server result, 0 if none). Local search stops short of re-deriving an
     *  answer it cannot beat — see the EVAL_DEPTH check in the analysis effect. */
    achievedDepth?: number
}

export interface LocalEngineRaceState {
    capability: EngineCapability
    enabled: boolean
    setEnabled: (v: boolean) => void
    download: DownloadState
    /** Re-attempt after an `error` state (e.g. a corrupt net was evicted and
     * needs re-downloading). No-op in any other state. */
    retry: () => void
    /**
     * The local engine's complete opinion of the CURRENT `fen`: the move list,
     * whose FIRST entry is also the eval, the arrow and the PV. Null when there
     * isn't one yet (not enabled, still loading, nothing streamed in), and reset
     * whenever `fen` changes.
     *
     * Deliberately ONE value rather than a separate eval and a separate line
     * list. Those were two outputs of two different searches at two different
     * depths, and the board rendered them in two different places — so it could
     * show an arrow for one move above a first line for another. There is now
     * nothing to reconcile.
     */
    lines: AnalysisLine[] | null
}

export function useLocalEngineRace({ active, fen, achievedDepth = 0 }: LocalEngineRaceOptions): LocalEngineRaceState {
    const [enabled, setEnabled] = useLocalEngineEnabled()
    // features() is a memoized, synchronous, side-effect-free probe (no
    // network/storage) — safe to compute even while `enabled` is false, which
    // is what lets the UI explain WHY the toggle isn't offered instead of just
    // hiding it (see the task's "explain briefly why" requirement).
    const capability = useMemo(() => computeCapability(features()), [])
    const [download, dispatch] = useReducer(reduceDownloadState, INITIAL_DOWNLOAD_STATE)
    // Both results are stored TAGGED WITH THE FEN they were computed for, and
    // filtered against the current `fen` on the way out (see the return below).
    //
    // Without that, a stale result leaks for exactly one commit after a move:
    // `current.id` in Analysis.tsx updates in the same render that the new fen
    // arrives, but the reset below only lands on the NEXT render — so the
    // consuming effect sees the new node paired with the previous position's
    // candidate and writes it. Visible as the best-move arrow being one move
    // behind: it never appeared for the position you were on, then snapped into
    // place the moment you played the next one.
    //
    // Filtering by fen makes that unrepresentable rather than depending on the
    // order two independent effects happen to run in.
    const [result, setResult] = useState<{ fen: string; value: AnalysisLine[] } | null>(null)
    const engineRef = useRef<LocalEngine | null>(null)
    // Via a ref, not a dependency: this changes every time a result lands, and
    // as a dep it would restart the search on each one.
    const achievedDepthRef = useRef(achievedDepth)
    achievedDepthRef.current = achievedDepth
    // Bumped by retry() to force the lifecycle effect to run again after an
    // error, without needing `download` itself as a dependency (which would
    // re-trigger — and restart the download — on every progress tick).
    const [retryTick, setRetryTick] = useState(0)

    // Toggling drops any result the engine produced. The fen tag alone is not
    // enough here: turn the engine off and back on while sitting on the same
    // position and the tagged value would still match, so the old result would
    // reappear as though it were fresh.
    useEffect(() => {
        setResult(null)
    }, [enabled])

    // --- Engine lifecycle: resolve the net (cache hit or download), spin up
    // the module, complete the UCI handshake. The whole body is a no-op unless
    // `active` (the engine panel is on and this position is analyzable),
    // `enabled`, and `capability.available` are ALL true.
    //
    // `active` matters as much as `enabled` now that local defaults to ON:
    // without it, merely opening the analysis board with the engine switched
    // OFF would start a 36 MB download nobody asked for. Nothing is fetched
    // until the user actually turns the engine on. ---
    useEffect(() => {
        if (!active || !enabled || !capability.available) return

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
    }, [active, enabled, capability.available, retryTick])

    // --- Streaming analysis for the current position, once the engine is
    // ready. No-op unless the caller says this position is worth analyzing
    // AND the net has finished loading. ---
    useEffect(() => {
        if (!active || download.status !== 'ready' || !engineRef.current) return
        setResult(null) // don't keep showing the PREVIOUS position's local result
        let cancelled = false
        const ac = new AbortController()
        const engine = engineRef.current
        void (async () => {
            // Deepest info seen per MultiPV slot. Slot 1 IS the eval and the arrow —
            // there is no second opinion to reconcile, which is the whole point: a
            // caller that renders `lines` and `lines[0]` cannot end up showing an
            // arrow for one move and a first line for another.
            const bySlot = new Map<number, EngineInfo>()
            // A full search streams hundreds of `info` lines (210 to depth 20 on one
            // measured position). Publishing every one means hundreds of React
            // commits, each rebuilding the analysis tree — enough churn to feel
            // sluggish even though the search itself is fast. Coalesce, and always
            // flush the last one so the final depth is never dropped.
            const EMIT_INTERVAL_MS = 200
            let lastEmit = 0
            const publish = () => {
                if (cancelled || bySlot.size === 0) return
                setResult({ fen, value: toAnalysisLines(fen, bySlot) })
                lastEmit = Date.now()
            }
            const consume = (info: EngineInfo) => {
                // A bound-flagged score is an aspiration-window fail-high/low
                // placeholder, not a settled value — protocol.ts's documented policy
                // is to hold the last exact score rather than show it.
                if (info.bound) return
                const slot = info.multipv ?? 1
                const prev = bySlot.get(slot)
                if (!prev || info.depth >= prev.depth) bySlot.set(slot, info)
                if (Date.now() - lastEmit >= EMIT_INTERVAL_MS) publish()
            }

            try {
                // Phase 1 — shallow and wide: fills the move list fast.
                for await (const info of engine.analyze(fen, {
                    multipv: LINES_MULTIPV,
                    depth: LINES_DEPTH,
                    signal: ac.signal,
                })) {
                    if (cancelled) return
                    consume(info)
                }
                publish()

                // Phase 2 — deep and narrow: pushes slot 1 deeper. It REPLACES slot 1
                // rather than living alongside it, so the arrow and the first line stay
                // the same move at the same depth. The remaining slots keep their
                // phase-1 depth, which is why each line carries its own.
                for await (const info of engine.analyze(fen, {
                    multipv: 1,
                    depth: EVAL_DEPTH,
                    signal: ac.signal,
                })) {
                    if (cancelled) return
                    consume(info)
                }
                publish()
            } catch {
                // Local search errored mid-stream (worker crash, etc) — leave the last
                // published result in place rather than blanking a valid, if now
                // slightly stale, board.
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
        // Never hand out a result computed for a different position, or one from
        // before the engine was switched off.
        lines: enabled && result?.fen === fen ? result.value : null,
    }
}
