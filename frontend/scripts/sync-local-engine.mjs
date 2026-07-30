#!/usr/bin/env node
// sync-local-engine.mjs — pulls the zugzwang WASM build outputs (gitignored,
// built by `make -f Makefile.wasm` in ../zugzwang) into frontend/public/
// local-engine/, where Vite serves them verbatim (dev passthrough, and
// copied into dist/ on `vite build`). Runs as `predev`/`prebuild` (see
// package.json) so the app never silently ships with a 404ing engine.
//
// Also handles the NNUE net specifically:
//   - content-hash names it (net.<hash>.nnue) — bigFileStorage.ts uses the
//     URL as its cache key, so a new net MUST get a new filename or every
//     user with an old net cached in OPFS/IndexedDB keeps it forever.
//   - precompresses it with brotli + gzip (Node's built-in zlib, no new
//     deps) so nginx can serve the compressed body statically in prod
//     instead of compressing a 94MB file per request (see the nginx notes
//     printed at the end, and docs/ARCHITECTURE.md-adjacent config below).
//   - writes VITE_LOCAL_ENGINE_NET_URL into frontend/.env (gitignored, not
//     committed) so `bun run dev`/`bun run build` picks up the real net
//     with zero manual steps for local work. Prod deploys should set the
//     same env var explicitly (see printed instructions) rather than rely
//     on this script running on the deploy box.
//
// Fails loudly (non-zero exit, clear message) if the wasm build or the net
// haven't been generated yet — never lets a build silently ship without them.
import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import zlib from 'node:zlib'
import { fileURLToPath } from 'node:url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const FRONTEND_DIR = path.resolve(__dirname, '..')
const ZUGZWANG_DIR = path.resolve(FRONTEND_DIR, '..', 'zugzwang')
const PUBLIC_LOCAL_ENGINE_DIR = path.join(FRONTEND_DIR, 'public', 'local-engine')
const PUBLIC_NET_DIR = path.join(PUBLIC_LOCAL_ENGINE_DIR, 'net')
const ENV_FILE = path.join(FRONTEND_DIR, '.env')

const WASM_ARTIFACTS = ['zugzwang.js', 'zugzwang.wasm', 'zugzwang-relaxed.js', 'zugzwang-relaxed.wasm']
const NET_SRC = path.join(ZUGZWANG_DIR, 'net.web.nnue')

function fail(message) {
    console.error(`\n[sync-local-engine] ${message}\n`)
    process.exit(1)
}

function log(message) {
    console.log(`[sync-local-engine] ${message}`)
}

// --- 1. wasm build artifacts: zugzwang.js/.wasm + relaxed variant ----------

const missingWasm = WASM_ARTIFACTS.filter((name) => !fs.existsSync(path.join(ZUGZWANG_DIR, name)))
if (missingWasm.length > 0) {
    fail(
        `missing wasm build output(s): ${missingWasm.join(', ')}\n` +
            `Build them first:\n` +
            `  source ~/emsdk/emsdk_env.sh && cd zugzwang && make -f Makefile.wasm all`,
    )
}

fs.mkdirSync(PUBLIC_LOCAL_ENGINE_DIR, { recursive: true })
for (const name of WASM_ARTIFACTS) {
    fs.copyFileSync(path.join(ZUGZWANG_DIR, name), path.join(PUBLIC_LOCAL_ENGINE_DIR, name))
}
log(`copied ${WASM_ARTIFACTS.join(', ')} -> public/local-engine/`)

// --- 2. the net: content-hash name it, copy, precompress -------------------

if (!fs.existsSync(NET_SRC)) {
    fail(
        `missing ${NET_SRC}\n` +
            `Generate it:\n` +
            `  cd zugzwang && make netweb && ./tools/netweb_writer net.nnue net.web.nnue`,
    )
}

const netBuf = fs.readFileSync(NET_SRC)
const hash = crypto.createHash('sha256').update(netBuf).digest('hex').slice(0, 12)
const netFileName = `net.${hash}.nnue`
const netDest = path.join(PUBLIC_NET_DIR, netFileName)
const netUrlPath = `/local-engine/net/${netFileName}`

fs.mkdirSync(PUBLIC_NET_DIR, { recursive: true })

// Content-addressed: if the hash-named file already exists, its bytes are
// guaranteed identical to netBuf (that's what the hash means), so skip the
// (slow: ~90MB copy + brotli -q11) work on repeat dev-server boots.
if (fs.existsSync(netDest) && fs.statSync(netDest).size === netBuf.length) {
    log(`net.web.nnue unchanged (${netFileName} already present) — skipping copy/compress`)
} else {
    fs.writeFileSync(netDest, netBuf)
    log(`wrote ${netFileName} (${netBuf.length} bytes)`)

    log('brotli -q 11 (this takes a while on ~90MB, one-time per net)...')
    const br = zlib.brotliCompressSync(netBuf, {
        params: {
            [zlib.constants.BROTLI_PARAM_QUALITY]: 11,
            [zlib.constants.BROTLI_PARAM_SIZE_HINT]: netBuf.length,
        },
    })
    fs.writeFileSync(`${netDest}.br`, br)
    log(`wrote ${netFileName}.br (${br.length} bytes, ${((1 - br.length / netBuf.length) * 100).toFixed(1)}% smaller)`)

    log('gzip -9...')
    const gz = zlib.gzipSync(netBuf, { level: 9 })
    fs.writeFileSync(`${netDest}.gz`, gz)
    log(`wrote ${netFileName}.gz (${gz.length} bytes)`)
}

// Sweep stale hash-named nets (previous versions) out of public/ so the repo
// checkout doesn't accumulate multiple 90MB copies across net updates.
for (const entry of fs.readdirSync(PUBLIC_NET_DIR)) {
    if (entry.startsWith('net.') && entry.includes('.nnue') && !entry.startsWith(netFileName)) {
        fs.rmSync(path.join(PUBLIC_NET_DIR, entry))
        log(`removed stale ${entry}`)
    }
}

// --- 3. wire VITE_LOCAL_ENGINE_NET_URL into frontend/.env (gitignored) -----

const envLine = `VITE_LOCAL_ENGINE_NET_URL=${netUrlPath}`
let envContent = fs.existsSync(ENV_FILE) ? fs.readFileSync(ENV_FILE, 'utf8') : ''
if (envContent.length > 0 && !envContent.endsWith('\n')) envContent += '\n'
if (/^VITE_LOCAL_ENGINE_NET_URL=.*$/m.test(envContent)) {
    envContent = envContent.replace(/^VITE_LOCAL_ENGINE_NET_URL=.*$/m, envLine)
} else {
    envContent += `${envLine}\n`
}
fs.writeFileSync(ENV_FILE, envContent)
log(`frontend/.env: ${envLine}`)

log(
    `\ndone. net URL: ${netUrlPath}\n` +
        `Prod deploys: set VITE_LOCAL_ENGINE_NET_URL=${netUrlPath} in the deploy env (or re-run this\n` +
        `script on the build box) BEFORE \`vite build\` — the value gets baked into the built JS.\n` +
        `Serve the net precompressed in prod (nginx brotli_static/gzip_static — see\n` +
        `frontend/docs/local-engine-serving.md).`,
)
