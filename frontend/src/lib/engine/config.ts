// Configuration for the in-browser (WASM) local engine: where the NNUE net
// lives, and the worker script that runs it. Kept as plain constants (not
// hardcoded inline at call sites) so both are one-line changes.

/**
 * The NNUE net's URL — ALSO the bigFileStorage cache key (see
 * bigFileStorage.ts's header comment: the URL *is* the key, on purpose). It
 * MUST be content-hash-named: that's what makes cache invalidation automatic
 * when the net changes — a new net needs a new filename/URL here, there is no
 * other invalidation mechanism, and reusing the same URL for a different net
 * would silently keep serving every user's stale OPFS/IndexedDB copy forever.
 *
 * Configurable via `VITE_LOCAL_ENGINE_NET_URL` so a deploy can point at the
 * real hosted net without a code change. The fallback below is a PLACEHOLDER —
 * the wasm build + net hosting is being done by a separate agent; replace
 * this (filename and all) once that lands, and bump it again on every future
 * net change.
 */
export const LOCAL_ENGINE_NET_URL: string =
    (import.meta.env.VITE_LOCAL_ENGINE_NET_URL as string | undefined) ?? ''

/**
 * Whether this build actually has a net to download.
 *
 * `sync-local-engine.mjs` sets VITE_LOCAL_ENGINE_NET_URL when the wasm build
 * and the generated net are both present, and deliberately leaves it unset
 * otherwise — a deploy box without the emscripten toolchain still has to
 * produce a working site, just one where the local engine isn't on offer. The
 * toggle reads this and explains itself instead of handing the user a download
 * that 404s.
 */
export const LOCAL_ENGINE_AVAILABLE = LOCAL_ENGINE_NET_URL !== ''

/**
 * The worker script the compiled engine runs in (see localEngine.ts's
 * `createWorkerUciModule`). Deliberately a plain runtime string — NOT
 * `new URL('./worker.js', import.meta.url)`, which Vite resolves and bundles
 * at BUILD time and would fail `bun run build` today, since the compiled
 * worker doesn't exist yet. Once it's placed under this path in `public/`, no
 * code change is needed here. If it's ever missing, `new Worker(...)`
 * construction fails at runtime and localEngine.ts's `init()` surfaces that as
 * an ordinary load error the UI can show/retry — never a build break.
 */
export const LOCAL_ENGINE_WORKER_URL = '/local-engine/engine-worker.js'

/** Net size for the honest "Downloaded X% of YMB" readout (Lichess's wording,
 * matched here — see downloadState.ts's formatDownloadProgress). `wire` is
 * what's actually transferred (brotli-compressed); `disk` is what it becomes
 * once decompressed into OPFS/IndexedDB. Update both if the net changes. */
export const LOCAL_ENGINE_NET_SIZE_MB = { wire: 36, disk: 94 } as const
