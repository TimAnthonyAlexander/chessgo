// Runs under `bun test` (zero-config; no vitest, no new dependency — see
// bun-test.d.ts for why an ambient module declaration exists instead of
// @types/bun). Everything here goes through the injectable factory
// (createBigFileStore) with fakes — never the real OPFS/IndexedDB/XHR backends —
// so these tests need no browser and no network.
import { beforeEach, describe, expect, test } from 'bun:test'
import {
    type BigFileBackend,
    type Transport,
    type U8,
    createBigFileStore,
    createNoopBackend,
    selectBackend,
} from '../bigFileStorage'

const URL = 'https://cdn.example.com/nnue/kb-mirror-abcd1234.bin'

function createFakeBackend(): BigFileBackend & { readonly data: Map<string, U8> } {
    const data = new Map<string, U8>()
    return {
        data,
        async get(key) {
            return data.get(key) ?? null
        },
        async set(key, value) {
            data.set(key, value)
        },
        async delete(key) {
            data.delete(key)
        },
        async list() {
            return [...data.keys()]
        },
        async clear() {
            data.clear()
        },
    }
}

interface FakeTransport extends Transport {
    calls: number
}

// `total: 0` simulates a server that omits Content-Length (xhr's e.total is 0 when
// !lengthComputable — see xhrTransport). `fail: true` simulates a non-2xx/network
// error: it rejects before ever "sending" bytes, so nothing should get persisted.
function createFakeTransport(bytes: U8, options: { total?: number; fail?: boolean } = {}): FakeTransport {
    const transport: FakeTransport = {
        calls: 0,
        async download(_url, onProgress) {
            transport.calls++
            if (options.fail) throw new Error('simulated download failure: HTTP 500')
            if (onProgress) {
                const total = options.total ?? bytes.length
                onProgress(Math.floor(bytes.length / 2), total)
                onProgress(bytes.length, total)
            }
            return bytes
        },
    }
    return transport
}

const SOME_BYTES = Uint8Array.from([1, 2, 3, 4, 5, 6, 7, 8])

describe('createBigFileStore', () => {
    test('get() on a cache hit returns the bytes without touching the transport', async () => {
        const backend = createFakeBackend()
        backend.data.set(URL, SOME_BYTES)
        const transport = createFakeTransport(SOME_BYTES)
        const store = createBigFileStore(async () => backend, transport)

        const result = await store.get(URL)

        expect(result).toEqual(SOME_BYTES)
        expect(transport.calls).toBe(0)
    })

    test('get() on a miss downloads, persists, then a second get() hits storage', async () => {
        const backend = createFakeBackend()
        const transport = createFakeTransport(SOME_BYTES)
        const store = createBigFileStore(async () => backend, transport)

        const first = await store.get(URL)
        const second = await store.get(URL)

        expect(first).toEqual(SOME_BYTES)
        expect(second).toEqual(SOME_BYTES)
        expect(transport.calls).toBe(1) // second get() was a storage hit, not a re-download
        expect(backend.data.get(URL)).toEqual(SOME_BYTES)
    })

    test('progress callback fires with increasing loaded values and the correct total', async () => {
        const backend = createFakeBackend()
        const transport = createFakeTransport(SOME_BYTES) // total defaults to bytes.length
        const store = createBigFileStore(async () => backend, transport)

        const samples: Array<{ loaded: number; total: number }> = []
        await store.get(URL, (loaded, total) => samples.push({ loaded, total }))

        expect(samples.length).toBe(2)
        expect(samples[0].loaded < samples[1].loaded).toBeTrue()
        expect(samples[1].loaded).toBe(SOME_BYTES.length)
        for (const s of samples) expect(s.total).toBe(SOME_BYTES.length)
    })

    test('missing Content-Length (total=0) does not crash and still returns the bytes', async () => {
        const backend = createFakeBackend()
        const transport = createFakeTransport(SOME_BYTES, { total: 0 })
        const store = createBigFileStore(async () => backend, transport)

        const samples: number[] = []
        const result = await store.get(URL, (_loaded, total) => samples.push(total))

        expect(result).toEqual(SOME_BYTES)
        expect(samples).toEqual([0, 0])
    })

    test('a failed download rejects and persists nothing', async () => {
        const backend = createFakeBackend()
        const transport = createFakeTransport(SOME_BYTES, { fail: true })
        const store = createBigFileStore(async () => backend, transport)

        await expect(store.get(URL)).rejects.toThrow()
        expect(await store.has(URL)).toBeFalse()
        expect(backend.data.size).toBe(0)
    })

    test('delete() removes one entry; clear() empties everything; list() reflects contents', async () => {
        const backend = createFakeBackend()
        const store = createBigFileStore(async () => backend)
        const urlA = `${URL}#a`
        const urlB = `${URL}#b`
        backend.data.set(urlA, SOME_BYTES)
        backend.data.set(urlB, SOME_BYTES)

        expect((await store.list()).sort()).toEqual([urlA, urlB].sort())

        await store.delete(urlA)
        expect(await store.list()).toEqual([urlB])
        expect(await store.has(urlA)).toBeFalse()

        await store.clear()
        expect(await store.list()).toEqual([])
    })

    test('no-persistence fallback backend still returns correct bytes on every call', async () => {
        const backend = createNoopBackend()
        const transport = createFakeTransport(SOME_BYTES)
        const store = createBigFileStore(async () => backend, transport)

        const first = await store.get(URL)
        const second = await store.get(URL)

        expect(first).toEqual(SOME_BYTES)
        expect(second).toEqual(SOME_BYTES)
        // Nothing persists, so both calls had to go through the transport.
        expect(transport.calls).toBe(2)
        expect(await store.has(URL)).toBeFalse()
        expect(await store.list()).toEqual([])
    })
})

describe('selectBackend() in a non-browser (bun test) environment', () => {
    beforeEach(() => {
        // Nothing to reset: selectBackend has no shared cache of its own (only the
        // OPFS probe result is memoized module-wide, and it degrades to null here
        // regardless since bun has no navigator.storage).
    })

    test('degrades to a working no-persistence backend without throwing', async () => {
        const backend = await selectBackend()
        expect(await backend.get(URL)).toBeNull()
        await backend.set(URL, SOME_BYTES) // must not throw even though it's a no-op
        expect(await backend.get(URL)).toBeNull()
        expect(await backend.list()).toEqual([])
    })
})
