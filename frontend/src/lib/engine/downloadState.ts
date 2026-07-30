// Pure state machine for the local engine's first-enable download flow (see
// useLocalEngineRace.ts, the only caller). Kept dependency-free and pure so
// the whole flow — "enabled → checking whether the net is already local →
// downloading with a %  readout → ready, or a wired-in retry on failure" — is
// testable without a browser, same spirit as bigFileStorage.ts's
// injectable-backend tests.

export type DownloadState =
    | { status: 'idle' }
    | { status: 'checking' }
    | { status: 'downloading'; loaded: number; total: number }
    | { status: 'ready' }
    | { status: 'error'; message: string }

export type DownloadEvent =
    // Enabled — begin resolving the net (bigFileStorage.get: cache hit or a
    // fresh download, caller can't tell which until progress does/doesn't fire).
    | { type: 'start' }
    // A real download is in progress. `total` is 0 when the server omitted
    // Content-Length (see xhrTransport in bigFileStorage.ts) — never fired at
    // all on a cache hit, since bigFileStorage.get() only calls onProgress
    // when it actually has to download.
    | { type: 'progress'; loaded: number; total: number }
    // The net is local (cache hit or download finished) AND the engine
    // finished its load + UCI handshake — i.e. genuinely ready to analyze.
    | { type: 'complete' }
    | { type: 'fail'; message: string }
    // User turned the feature off, or the owning component unmounted — back
    // to idle so a later re-enable starts clean.
    | { type: 'reset' }

export const INITIAL_DOWNLOAD_STATE: DownloadState = { status: 'idle' }

export function reduceDownloadState(state: DownloadState, event: DownloadEvent): DownloadState {
    switch (event.type) {
        case 'start':
            return { status: 'checking' }
        case 'progress':
            return { status: 'downloading', loaded: event.loaded, total: event.total }
        case 'complete':
            return { status: 'ready' }
        case 'fail':
            return { status: 'error', message: event.message }
        case 'reset':
            return INITIAL_DOWNLOAD_STATE
        default:
            return state
    }
}

/**
 * The Lichess-style readout: `"Downloaded X% of YMB"`. `total` is bytes and
 * may be 0 (Content-Length omitted) — falls back to `fallbackWireMb` (the
 * known wire size, see config.ts's LOCAL_ENGINE_NET_SIZE_MB.wire) so the
 * percentage is still a reasonable estimate instead of stuck reporting 0%
 * against an unknown total.
 */
export function formatDownloadProgress(loaded: number, total: number, fallbackWireMb: number): string {
    const totalBytes = total > 0 ? total : fallbackWireMb * 1024 * 1024
    const pct = totalBytes > 0 ? Math.min(100, Math.max(0, Math.round((loaded / totalBytes) * 100))) : 0
    const mb = total > 0 ? Math.max(1, Math.round(total / (1024 * 1024))) : fallbackWireMb
    return `Downloaded ${pct}% of ${mb}MB`
}
