// engine-worker.js — the Web Worker that runs the zugzwang WASM UCI engine.
//
// Loaded by `createWorkerUciModule` (frontend/src/lib/engine/localEngine.ts)
// via `new Worker(LOCAL_ENGINE_WORKER_URL, { type: 'module' })`. This file
// implements EXACTLY the message contract documented there — do not change
// the shape of these messages without updating localEngine.ts to match:
//
//   in  {type:'init', net: Uint8Array}   net's ArrayBuffer arrives transferred,
//                                        not copied (see localEngine.ts's
//                                        `worker.postMessage(..., [net.buffer])`)
//   out {type:'ready'}                   once the module is up and the net loaded
//   out {type:'error', kind, message}    kind: 'bad_net' | 'load_failed'
//
//   in  {type:'send', command: string}   one UCI command line
//   out {type:'line', line: string}      one UCI output line (0..N per command,
//                                        e.g. many `info`s + one `bestmove` per `go`)
//
// Lives entirely under public/ (NOT part of the Vite module graph) because
// LOCAL_ENGINE_WORKER_URL is a plain runtime string, not a
// `new URL(..., import.meta.url)` — see config.ts's comment for why: the
// compiled wasm module doesn't exist at Vite-build analysis time, so
// bundling this as a normal app module isn't an option. zugzwang.js,
// zugzwang.wasm and zugzwang-relaxed.{js,wasm} are copied into this SAME
// directory at dev/build time by scripts/sync-local-engine.mjs (see
// package.json's predev/prebuild), so the relative imports below always
// resolve next to wherever this file itself was served from.
//
// SIMD variant selection happens HERE (not on the main thread) by
// feature-probing WebAssembly.validate() against the same relaxed-simd test
// module frontend/src/lib/engine/features.ts uses for its `relaxedSimd`
// probe — duplicated rather than imported since this script is not bundled.

// Exercises `i32x4.dot_i8x16_i7x16_add_s` (relaxed-simd proposal). Byte-identical
// to RELAXED_SIMD_WASM in features.ts.
const RELAXED_SIMD_WASM = Uint8Array.from([
    0, 97, 115, 109, 1, 0, 0, 0, 1, 8, 1, 96, 3, 123, 123, 123, 1, 123, 3, 2, 1, 0, 7, 5, 1, 1, 99, 0, 0, 10,
    13, 1, 11, 0, 32, 0, 32, 1, 32, 2, 253, 147, 2, 11,
])

function supportsRelaxedSimd() {
    try {
        return (
            typeof WebAssembly === 'object' &&
            typeof WebAssembly.validate === 'function' &&
            WebAssembly.validate(RELAXED_SIMD_WASM)
        )
    } catch {
        return false
    }
}

let engineModule = null

function postLine(line) {
    postMessage({ type: 'line', line })
}

function postError(kind, message) {
    postMessage({ type: 'error', kind, message })
}

// Loads the compiled module and instantiates its .wasm ourselves via the
// `instantiateWasm` hook, rather than letting Emscripten's generated glue
// auto-detect the host (web/worker/node) and pick its own fetch/XHR path.
// Two reasons: (1) it makes wasm loading exactly one `fetch()` call, host-
// agnostic — the same code path runs unmodified in a real browser Worker and
// under the Node test harness (test/verify-local-engine-worker.mjs), which
// only needs to shim `fetch`+`self`/`postMessage`, nothing wasm-specific;
// (2) it turns an instantiate failure into a normal rejected promise instead
// of depending on Emscripten's environment-sniffed error handling.
async function loadModule(variant) {
    const jsUrl = new URL(variant === 'relaxed' ? './zugzwang-relaxed.js' : './zugzwang.js', import.meta.url)
    const wasmUrl = new URL(variant === 'relaxed' ? './zugzwang-relaxed.wasm' : './zugzwang.wasm', import.meta.url)

    const { default: ZugzwangFactory } = await import(jsUrl.href)

    const wasmResp = await fetch(wasmUrl.href)
    if (!wasmResp.ok) {
        throw new Error(`fetch ${wasmUrl.href} failed: HTTP ${wasmResp.status}`)
    }
    const wasmBytes = await wasmResp.arrayBuffer()

    return new Promise((resolve, reject) => {
        ZugzwangFactory({
            print: postLine,
            // NNUE/book/syzygy status lines the wasm build never emits (no
            // filesystem in the browser) — nothing useful to surface, and
            // stderr output must never be mistaken for UCI protocol lines.
            printErr: () => {},
            instantiateWasm(imports, successCallback) {
                WebAssembly.instantiate(wasmBytes, imports)
                    .then(({ instance, module }) => successCallback(instance, module))
                    .catch(reject)
                return {} // signals async instantiation to Emscripten's glue
            },
        }).then(resolve, reject)
    })
}

async function handleInit(net) {
    try {
        const variant = supportsRelaxedSimd() ? 'relaxed' : 'simd128'
        const Module = await loadModule(variant)

        Module.ccall('zug_init', null, [], [])

        // The wasm module's linear memory is a separate address space from
        // this worker's JS heap — copying the net bytes in is unavoidable
        // (no way to hand wasm a JS-owned buffer directly without
        // SharedArrayBuffer, which this build doesn't use — see
        // Makefile.wasm's header comment on COOP/COEP). It's a single ~90MB
        // memcpy-equivalent, not repeated per search. NNUE::load_from_memory
        // copies the payload into its own owned structures (nnue_net.cpp),
        // so the malloc'd copy here is freed immediately after the call.
        const ptr = Module._malloc(net.length)
        Module.HEAPU8.set(net, ptr)
        const ok = Module.ccall('zug_load_net', 'number', ['number', 'number'], [ptr, net.length])
        Module._free(ptr)

        if (!ok) {
            postError('bad_net', 'zug_load_net rejected the net (bad magic/checksum/arch mismatch)')
            return
        }

        engineModule = Module
        postMessage({ type: 'ready' })
    } catch (err) {
        postError('load_failed', (err && err.message) || String(err))
    }
}

self.onmessage = (e) => {
    const msg = e.data
    if (msg.type === 'init') {
        handleInit(msg.net)
    } else if (msg.type === 'send') {
        if (!engineModule) {
            postError('load_failed', 'engine worker received a command before init completed')
            return
        }
        try {
            engineModule.ccall('zug_command', null, ['string'], [msg.command])
        } catch (err) {
            postError('unknown', (err && err.message) || String(err))
        }
    }
}
