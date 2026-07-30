#!/usr/bin/env bun
// verify-local-engine-worker.mjs — end-to-end proof that the REAL production
// path works: localEngine.ts's `createWorkerUciModule` ->
// public/local-engine/engine-worker.js -> zugzwang.js/.wasm -> the real
// ~94MB net -> UCI. Nothing here is a fake/mock: it imports the actual
// `createWorkerUciModule`/`createLocalEngine` from src/lib/engine/
// localEngine.ts and hands them the actual worker script under public/.
//
// Run with bun (not plain node): bun ships a Worker implementation that's a
// genuine browser-API Worker (type:'module', self/postMessage/onmessage,
// fetch() including file: URLs) — verified separately against a throwaway
// worker+fetch(file://) probe. That means `new Worker(url, {type:'module'})`
// called from createWorkerUciModule needs ZERO shim to run engine-worker.js
// exactly as a real browser would, and localEngine.ts needs zero
// modification either — this is the actual production code path, not an
// approximation of it. (Node's Worker is node:worker_threads, a different,
// non-browser API; using it here would mean either shimming self/postMessage/
// onmessage/WorkerGlobalScope inside the worker realm, or rewriting
// engine-worker.js against a different API — bun's native Worker makes both
// unnecessary.)
//
// Usage: bun run scripts/verify-local-engine-worker.mjs
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const FRONTEND_DIR = path.resolve(__dirname, '..')
const ZUGZWANG_DIR = path.resolve(FRONTEND_DIR, '..', 'zugzwang')

const workerUrl = new URL('../public/local-engine/engine-worker.js', import.meta.url)
const netPath = path.join(ZUGZWANG_DIR, 'net.web.nnue')
const goldenPath = path.join(ZUGZWANG_DIR, 'test', 'golden_eval_web.txt')

for (const [label, p] of [
    ['engine-worker.js', fileURLToPath(workerUrl)],
    ['net.web.nnue', netPath],
    ['golden_eval_web.txt', goldenPath],
]) {
    if (!fs.existsSync(p)) {
        console.error(`missing ${label}: ${p}`)
        console.error(p.endsWith('.js') ? 'Run: bun run sync-local-engine (in frontend/)' : '')
        process.exit(2)
    }
}

const { createLocalEngine, createWorkerUciModule } = await import('../src/lib/engine/localEngine.ts')

const netBuf = fs.readFileSync(netPath)
console.log(`net.web.nnue: ${netBuf.length} bytes`)

function freshNetU8() {
    // Each UciModule consumes/transfers its buffer (postMessage with a
    // transfer list detaches it), so every fresh module load needs its own
    // ArrayBuffer copy — sharing one across multiple init() calls would
    // detach out from under a still-live module.
    return new Uint8Array(netBuf)
}

// ---------------------------------------------------------------------------
// Part 1: low-level UciModule — the exact contract createWorkerUciModule
// promises (see localEngine.ts's doc comment on it), driven directly so we
// can assert exact golden-eval equality the way zugzwang/test/wasm_verify.mjs
// does for the native/Node-embedded build.
// ---------------------------------------------------------------------------

console.log('\n=== loading module via createWorkerUciModule (real Worker, real engine-worker.js) ===')
const factory = createWorkerUciModule(workerUrl)
const t0 = Date.now()
const mod = await factory(freshNetU8())
console.log(`module ready in ${Date.now() - t0}ms`)

// Sends `cmds` in order, then `isready`, and resolves with every line seen
// up to (not including) `readyok` — using isready/readyok as a UCI
// synchronization barrier. This is the correct way to wait for a command's
// output over an inherently async transport (worker postMessage) when the
// command might legitimately produce ZERO lines (`position ...` normally
// does) — waiting on a content predicate instead would hang forever on
// exactly those commands. `go` is safe to barrier this way too: the worker's
// `zug_command` ccall is synchronous/blocking (wasm_main.cpp), so a queued
// `isready` cannot be processed — and therefore `readyok` cannot appear —
// until whatever `go` is searching has already returned its `bestmove`.
async function sendAndBarrier(cmds) {
    const collected = []
    const barrier = new Promise((resolve) => {
        const unsub = mod.onLine((line) => {
            if (line.trim() === 'readyok') {
                unsub()
                resolve()
            } else {
                collected.push(line)
            }
        })
    })
    for (const c of cmds) mod.send(c)
    mod.send('isready')
    await barrier
    return collected
}

// uci/isready handshake (same as localEngine.ts's handshake(), done manually
// here since this section talks to the UciModule directly).
const handshakeOut = await sendAndBarrier(['uci'])
const handshakeOk = handshakeOut.some((l) => l.trim() === 'uciok')
console.log(`uci/isready handshake: ${handshakeOk ? 'PASS' : 'FAIL'}`, handshakeOut)
if (!handshakeOk) process.exit(1)

// ---- golden eval vectors: EXACT integer equality, no tolerance ----
const golden = fs
    .readFileSync(goldenPath, 'utf8')
    .split('\n')
    .filter((l) => l.includes('|') && !l.trim().startsWith('#'))
    .map((l) => {
        const [fen, want] = l.split('|')
        return { fen: fen.trim(), want: Number.parseInt(want.trim(), 10) }
    })

console.log(`\n=== golden eval vectors (${golden.length} FENs) ===`)
let pass = 0
let fail = 0
for (const { fen, want } of golden) {
    const out = await sendAndBarrier([`position fen ${fen}`, 'eval'])
    const evalLine = out.find((l) => l.startsWith('eval '))
    const got = evalLine ? Number.parseInt(evalLine.split(/\s+/)[1], 10) : Number.NaN
    const ok = got === want
    if (ok) pass++
    else fail++
    console.log(`${ok ? 'PASS' : 'MISMATCH'} fen=${fen} got=${got} want=${want}`)
}
console.log(`=== golden: ${pass}/${golden.length} pass, ${fail} fail ===`)

// ---- go depth 8 smoke test ----
console.log('\n=== go depth 8 smoke test (startpos) ===')
const goOut = await sendAndBarrier(['position startpos', 'go depth 8'])
const bestLine = goOut.find((l) => l.startsWith('bestmove '))
const infoLines = goOut.filter((l) => l.startsWith('info depth'))
console.log(`info lines: ${infoLines.length}, last: ${infoLines[infoLines.length - 1] || '(none)'}`)
console.log(bestLine || 'NO BESTMOVE')
const bestOk = !!bestLine && /^bestmove [a-h][1-8][a-h][1-8][qrbn]?(\s|$)/.test(bestLine)

// ---- illegal FEN gate ----
console.log('\n=== illegal FEN gate ===')
const badFen = '8/5ppp/8/8/8/8/5PPP/6K1 w - - 0 50'
const rejectOut = await sendAndBarrier([`position fen ${badFen}`])
console.log('reject output:', rejectOut)
const rejected = rejectOut.some((l) => l.toLowerCase().includes('invalid fen'))

const stillAliveOut = await sendAndBarrier(['position startpos', 'eval'])
const stillAlive = stillAliveOut.some((l) => l.startsWith('eval '))
console.log('module still responsive after bad FEN:', stillAlive, stillAliveOut)

mod.terminate()

// ---------------------------------------------------------------------------
// Part 2: high-level createLocalEngine — the actual object Analysis.tsx/
// useLocalEngineRace.ts call. Proves init()'s handshake + fetchNet plumbing
// + analyze()'s streaming ladder all work through the real worker too.
// ---------------------------------------------------------------------------

console.log('\n=== createLocalEngine (high-level, app-facing API) ===')
const engine = createLocalEngine({
    netUrl: 'verify://net.web.nnue', // fetchNet below ignores the URL, this is just the cache key
    createModule: createWorkerUciModule(workerUrl),
    fetchNet: async () => freshNetU8(),
})

const initResult = await engine.init()
console.log('init():', initResult.ok ? 'PASS' : `FAIL — ${initResult.error.kind}: ${initResult.error.message}`)

let sawDepth = 0
let lastInfo = null
if (initResult.ok) {
    for await (const info of engine.analyze('rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1', { depth: 6 })) {
        sawDepth = Math.max(sawDepth, info.depth)
        lastInfo = info
    }
    console.log(`analyze() streamed up to depth ${sawDepth}, last score:`, lastInfo?.score)
}
engine.dispose()

// ---- summary ----
console.log('\n=== SUMMARY ===')
console.log(`golden vectors:  ${pass}/${golden.length} exact match ${fail === 0 ? '(PASS)' : '(FAIL)'}`)
console.log(`go depth 8:      ${bestOk ? 'PASS (legal bestmove)' : 'FAIL'}`)
console.log(`illegal FEN:     ${rejected ? 'PASS (rejected cleanly)' : 'FAIL'}`)
console.log(`post-reject:     ${stillAlive ? 'PASS (module still responsive)' : 'FAIL'}`)
console.log(`createLocalEngine.init(): ${initResult.ok ? 'PASS' : 'FAIL'}`)
console.log(`createLocalEngine.analyze() reached depth: ${sawDepth >= 6 ? 'PASS' : 'FAIL'} (${sawDepth})`)

const overallPass = fail === 0 && bestOk && rejected && stillAlive && initResult.ok && sawDepth >= 6
process.exit(overallPass ? 0 : 1)
