// Runs under `bun test`. bun itself is a good stand-in for "does this explode in
// a non-browser environment": it has no `navigator.storage`, no DOM, and (per
// probing below) only partial WebAssembly/SharedArrayBuffer support — exactly the
// kind of half-there environment features() must degrade gracefully in rather
// than throw in, since this module is imported by Vite's SSR/build pass too.
import { describe, expect, test } from 'bun:test'
import {
    type Feature,
    MINIMAL_WASM,
    RELAXED_SIMD_WASM,
    SIMD_WASM,
    createFeatureDetector,
    features,
    isCrossOriginIsolated,
    storageEstimate,
} from '../features'

describe('SIMD/relaxedSimd byte sequences', () => {
    test('minimal module validates (sanity: this engine parses a WASM module at all)', () => {
        expect(WebAssembly.validate(MINIMAL_WASM)).toBeTrue()
    })

    test('SIMD module bytes discriminate — validating true is not "any bytes true"', () => {
        // If this engine can't do WASM at all, the discrimination check is moot.
        if (!WebAssembly.validate(MINIMAL_WASM)) return

        const before = WebAssembly.validate(SIMD_WASM)
        // Flip the byte encoding the i32x4.dot_i16x8_s opcode (253, 186 — the SIMD
        // prefix + opcode pair right before the two `end` bytes). If validate()
        // still returned true after this, the module wouldn't actually be
        // exercising the opcode, and the whole detection would be worthless.
        const corrupt = Uint8Array.from(SIMD_WASM)
        corrupt[corrupt.length - 4] = 0xff
        expect(WebAssembly.validate(corrupt)).toBeFalse()
        // (We don't assert `before` either way — whether *this* engine implements
        // SIMD varies — only that corrupting the opcode can't still validate.)
        void before
    })

    test('features() SIMD flags exactly track a from-scratch WebAssembly.validate() call', () => {
        // This ties the module's own output back to the raw platform API using the
        // very same exported byte arrays, so a future edit that swaps in a
        // different (possibly wrong) byte sequence would show up as features()
        // disagreeing with WebAssembly.validate() on the same bytes.
        const supportsWasm = WebAssembly.validate(MINIMAL_WASM)
        if (!supportsWasm) {
            expect(features().has('wasm')).toBeFalse()
            return
        }
        expect(features().has('simd')).toBe(WebAssembly.validate(SIMD_WASM))
        expect(features().has('relaxedSimd')).toBe(WebAssembly.validate(RELAXED_SIMD_WASM))
    })
})

describe('createFeatureDetector (memoization)', () => {
    test('the underlying probe runs exactly once across repeated calls', () => {
        let calls = 0
        const fakeResult = new Set<Feature>(['wasm'])
        const detect = createFeatureDetector(() => {
            calls++
            return fakeResult
        })

        const a = detect()
        const b = detect()
        const c = detect()

        expect(calls).toBe(1)
        expect(a).toBe(b) // same reference: proof it's cached, not recomputed
        expect(b).toBe(c)
        expect(a).toEqual(fakeResult)
    })

    test('separate detectors have separate caches (no shared module-level state)', () => {
        let callsX = 0
        let callsY = 0
        const detectX = createFeatureDetector(() => {
            callsX++
            return new Set<Feature>()
        })
        const detectY = createFeatureDetector(() => {
            callsY++
            return new Set<Feature>()
        })

        detectX()
        detectX()
        detectY()

        expect(callsX).toBe(1)
        expect(callsY).toBe(1)
    })
})

describe('non-browser environment safety', () => {
    test('features() does not throw when WebAssembly/Atomics/SharedArrayBuffer are absent or partial', () => {
        expect(() => features()).not.toThrow()
        expect(features()).toBeTruthy()
    })

    test('isCrossOriginIsolated() does not throw and is false without COOP/COEP', () => {
        expect(() => isCrossOriginIsolated()).not.toThrow()
        expect(isCrossOriginIsolated()).toBeFalse()
    })

    test('storageEstimate() resolves to null when navigator.storage is unavailable (bun has none)', async () => {
        await expect(storageEstimate()).resolves.toBeNull()
    })
})
