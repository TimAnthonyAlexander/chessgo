// Browser capability detection for the in-browser WASM chess engine. Modeled on
// Lichess's ui/lib/src/device.ts `features()`: probe the real capability, never a
// UA/version guess, and memoize since a probe never changes mid-session.
//
// wasm/simd/relaxedSimd are detected by handing WebAssembly.validate() a tiny,
// hand-assembled module containing exactly one instruction from that proposal.
// validate() only returns true if every byte decodes to a legal module AND every
// opcode is one the engine actually implements, so this is a real capability
// check, not a sniff. The SIMD/relaxed-SIMD byte arrays below are copied verbatim
// from Lichess's device.ts (github.com/lichess-org/lila, ui/lib/src/device.ts, as
// fetched 2026-07-30) rather than hand-encoded here. Verified locally with
// `bun -e` (JavaScriptCore's WASM validator, same engine `bun test` runs under):
//   - SIMD_WASM (i32x4.dot_i16x8_s) validates TRUE, and flipping a single opcode
//     byte inside it makes validate() return FALSE — proof the module actually
//     encodes that instruction rather than being "any bytes validate true".
//   - RELAXED_SIMD_WASM (i32x4.dot_i8x16_i7x16_add_s) validates FALSE here, which
//     matches JavaScriptCore not shipping the relaxed-SIMD proposal — the expected
//     negative case, not a bug in the byte sequence.
// Re-verify by pasting the arrays into a SIMD-capable browser console if the
// engine ever needs relaxedSimd for real.

export type Feature = 'wasm' | 'simd' | 'relaxedSimd' | 'sharedMem'

// Exported (not just module-local) so the test suite can validate them directly
// against WebAssembly.validate() itself, rather than only through features() —
// see __tests__/features.test.ts.

// Header-only module (no sections): validates true iff the engine can parse a
// WASM module at all.
export const MINIMAL_WASM = Uint8Array.from([0, 97, 115, 109, 1, 0, 0, 0])

// Exercises `i32x4.dot_i16x8_s` and `i32x4.trunc_sat_f64x2_u_zero` (fixed-width SIMD).
export const SIMD_WASM = Uint8Array.from([
    0, 97, 115, 109, 1, 0, 0, 0, 1, 12, 2, 96, 2, 123, 123, 1, 123, 96, 1, 123, 1, 123, 3, 3, 2, 0, 1, 7, 9,
    2, 1, 97, 0, 0, 1, 98, 0, 1, 10, 19, 2, 9, 0, 32, 0, 32, 1, 253, 186, 1, 11, 7, 0, 32, 0, 253, 253, 1,
    11,
])

// Exercises `i32x4.dot_i8x16_i7x16_add_s` (relaxed-SIMD proposal).
export const RELAXED_SIMD_WASM = Uint8Array.from([
    0, 97, 115, 109, 1, 0, 0, 0, 1, 8, 1, 96, 3, 123, 123, 123, 1, 123, 3, 2, 1, 0, 7, 5, 1, 1, 99, 0, 0, 10,
    13, 1, 11, 0, 32, 0, 32, 1, 32, 2, 253, 147, 2, 11,
])

function canValidate(): boolean {
    return typeof WebAssembly === 'object' && typeof WebAssembly.validate === 'function'
}

// SharedArrayBuffer-backed WASM memory requires the page to be cross-origin
// isolated (COOP/COEP), which we don't set yet — so this is expected to be false
// in our app today. The engine's first version is single-threaded; sharedMem
// becomes relevant once we opt into COOP/COEP for a threaded build.
function detectSharedMem(): boolean {
    if (typeof Atomics !== 'object' || typeof SharedArrayBuffer !== 'function') return false
    try {
        const mem = new WebAssembly.Memory({ shared: true, initial: 1, maximum: 2 })
        return mem.buffer instanceof SharedArrayBuffer
    } catch {
        return false
    }
}

function detect(): ReadonlySet<Feature> {
    const set = new Set<Feature>()
    if (canValidate() && WebAssembly.validate(MINIMAL_WASM)) {
        set.add('wasm')
        if (WebAssembly.validate(SIMD_WASM)) set.add('simd')
        if (WebAssembly.validate(RELAXED_SIMD_WASM)) set.add('relaxedSimd')
    }
    if (detectSharedMem()) set.add('sharedMem')
    return set
}

/** Build a memoized feature probe. Exported (rather than only the default
 * singleton below) so tests can wrap a fake/counting probe and verify memoization
 * without touching global state. */
export function createFeatureDetector(probe: () => ReadonlySet<Feature> = detect): () => ReadonlySet<Feature> {
    let cached: ReadonlySet<Feature> | null = null
    return () => {
        if (!cached) cached = probe()
        return cached
    }
}

/** Memoized capability probe for app code. Safe in any environment — every check
 * is feature-detected first, so this never throws under SSR/build or `bun test`,
 * where `WebAssembly`/`Atomics`/`SharedArrayBuffer` may be absent or partial. */
export const features: () => ReadonlySet<Feature> = createFeatureDetector()

/** True once COOP/COEP make the page cross-origin isolated — the prerequisite for
 * `sharedMem` / threaded WASM. False today since we don't set those headers. */
export function isCrossOriginIsolated(): boolean {
    return typeof self !== 'undefined' && self.crossOriginIsolated === true
}

/** Storage quota/usage estimate, when the browser exposes it. Lichess doesn't
 * surface this and their users hit opaque engine errors when Safari evicts
 * storage under pressure — we want the number on hand so callers can warn before
 * the ~94 MB net gets silently evicted. */
export async function storageEstimate(): Promise<{ usage: number; quota: number } | null> {
    if (typeof navigator === 'undefined' || typeof navigator.storage?.estimate !== 'function') return null
    try {
        const { usage, quota } = await navigator.storage.estimate()
        if (usage === undefined || quota === undefined) return null
        return { usage, quota }
    } catch {
        return null
    }
}
