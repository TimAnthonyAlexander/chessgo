// URL-keyed storage for very large binary assets — specifically the ~94 MB NNUE
// weights file the in-browser (WASM) engine needs. Modeled on Lichess's
// ui/lib/src/bigFileStorage.ts: OPFS (Origin Private File System) as primary,
// IndexedDB as fallback, keyed by the full asset URL. Net URLs are content-hash
// named, so a new net is a new key — cache invalidation is automatic, nothing to
// version by hand.
//
// Everything here is a plain factory (createBigFileStore) over an injectable
// BigFileBackend + Transport, deliberately not a module-level store singleton that
// holds state a unit test can't reset. `bigFileStorage` at the bottom wires the
// factory to the real OPFS/IndexedDB/XHR implementations for app code; tests build
// their own store with fakes instead.

// Pinned to a real (non-shared) ArrayBuffer. Plain `Uint8Array` defaults to
// `Uint8Array<ArrayBufferLike>`, which also admits a SharedArrayBuffer-backed
// view — OPFS's FileSystemWritableFileStream.write() rejects those at the type
// level, and we never want shared-memory views ending up in the cache anyway.
export type U8 = Uint8Array<ArrayBuffer>

export interface BigFileBackend {
    /** Bytes for `key`, or null if not present. */
    get(key: string): Promise<U8 | null>
    set(key: string, data: U8): Promise<void>
    delete(key: string): Promise<void>
    list(): Promise<string[]>
    clear(): Promise<void>
}

export interface Transport {
    download(url: string, onProgress?: (loaded: number, total: number) => void): Promise<U8>
}

export interface BigFileStore {
    /** Local copy if we have one; otherwise downloads, persists, and returns it. */
    get(url: string, onProgress?: (loaded: number, total: number) => void): Promise<U8>
    /** Is `url` already local (i.e. would `get` avoid a download)? */
    has(url: string): Promise<boolean>
    /** Evict one entry — used when the engine reports a corrupt net so we can drop
     * it and re-fetch. */
    delete(url: string): Promise<void>
    list(): Promise<string[]>
    clear(): Promise<void>
}

// ---------------------------------------------------------------------------
// Transport: XMLHttpRequest, not fetch(). fetch() progress requires reading the
// body as a stream and summing chunk lengths yourself; XHR gives onprogress for
// free. This is also what Lichess uses for the same reason.
// ---------------------------------------------------------------------------

export const xhrTransport: Transport = {
    download(url, onProgress) {
        return new Promise<U8>((resolve, reject) => {
            const xhr = new XMLHttpRequest()
            xhr.open('GET', url, true)
            xhr.responseType = 'arraybuffer'

            if (onProgress) {
                // lengthComputable is false when the server omits Content-Length
                // (e.g. chunked transfer); e.total is 0 in that case per spec, so
                // callers see total=0 rather than a crash or a bogus percentage.
                xhr.onprogress = (e) => onProgress(e.loaded, e.lengthComputable ? e.total : 0)
            }

            xhr.onerror = () => reject(new Error(`download '${url}' failed: network error`))
            xhr.onload = () => {
                if (Math.floor(xhr.status / 100) === 2) {
                    resolve(new Uint8Array(xhr.response as ArrayBuffer))
                } else {
                    reject(new Error(`download '${url}' failed: HTTP ${xhr.status}`))
                }
            }

            xhr.send()
        })
    },
}

// ---------------------------------------------------------------------------
// OPFS backend
// ---------------------------------------------------------------------------

// OPFS file names can't contain '/', and we'd rather not maintain a separate
// manifest mapping safe names back to URLs — encodeURIComponent is a reversible,
// filesystem-safe encoding of the key, so the file name IS the key.
function opfsFileName(url: string): string {
    return encodeURIComponent(url)
}

async function readFile(file: File): Promise<U8> {
    return new Uint8Array(await file.arrayBuffer())
}

function createOpfsBackend(root: FileSystemDirectoryHandle): BigFileBackend {
    return {
        async get(key) {
            try {
                const handle = await root.getFileHandle(opfsFileName(key), { create: false })
                return await readFile(await handle.getFile())
            } catch {
                return null // NotFoundError (or any other read failure) == cache miss
            }
        },
        async set(key, data) {
            const handle = await root.getFileHandle(opfsFileName(key), { create: true })
            const writable = await handle.createWritable()
            await writable.write(data)
            await writable.close()
        },
        async delete(key) {
            await root.removeEntry(opfsFileName(key)).catch(() => {})
        },
        async list() {
            const keys: string[] = []
            for await (const name of root.keys()) keys.push(decodeURIComponent(name))
            return keys
        },
        async clear() {
            for await (const name of root.keys()) await root.removeEntry(name).catch(() => {})
        },
    }
}

// Real capability check, not feature detection: `navigator.storage.getDirectory`
// can exist and still fail (some browsers ship it half-working), so we write and
// delete a throwaway file before trusting OPFS as the backend — same probe
// Lichess runs in directoryHandleIfAvailable(). Memoized: one probe per page load.
let opfsProbe: Promise<FileSystemDirectoryHandle | null> | null = null

async function probeOpfs(): Promise<FileSystemDirectoryHandle | null> {
    try {
        if (typeof navigator === 'undefined' || typeof navigator.storage?.getDirectory !== 'function') {
            return null
        }
        const root = await navigator.storage.getDirectory()
        const probeName = `.opfs-probe-${Math.random().toString(36).slice(2)}`
        const handle = await root.getFileHandle(probeName, { create: true })
        const writable = await handle.createWritable()
        await writable.write(new Uint8Array([1]))
        await writable.close()
        await root.removeEntry(probeName)
        return root
    } catch {
        return null
    }
}

function opfsRoot(): Promise<FileSystemDirectoryHandle | null> {
    if (!opfsProbe) opfsProbe = probeOpfs()
    return opfsProbe
}

// ---------------------------------------------------------------------------
// IndexedDB backend (hand-rolled promise wrapper — no idb-keyval, no dependency)
// ---------------------------------------------------------------------------

const IDB_NAME = 'chessgo-big-file'
const IDB_STORE = 'big-file'

function idbRequest<T>(req: IDBRequest<T>): Promise<T> {
    return new Promise((resolve, reject) => {
        req.onsuccess = () => resolve(req.result)
        req.onerror = () => reject(req.error ?? new Error('indexedDB request failed'))
    })
}

function openIdb(): Promise<IDBDatabase> {
    return new Promise((resolve, reject) => {
        if (typeof indexedDB === 'undefined') {
            reject(new Error('indexedDB unavailable'))
            return
        }
        const req = indexedDB.open(IDB_NAME, 1)
        req.onupgradeneeded = () => {
            if (!req.result.objectStoreNames.contains(IDB_STORE)) req.result.createObjectStore(IDB_STORE)
        }
        req.onsuccess = () => resolve(req.result)
        req.onerror = () => reject(req.error ?? new Error('indexedDB open failed'))
    })
}

function createIdbBackend(db: IDBDatabase): BigFileBackend {
    function store(mode: IDBTransactionMode): IDBObjectStore {
        return db.transaction(IDB_STORE, mode).objectStore(IDB_STORE)
    }
    return {
        async get(key) {
            const value = await idbRequest<U8 | undefined>(store('readonly').get(key))
            return value ?? null
        },
        async set(key, data) {
            await idbRequest(store('readwrite').put(data, key))
        },
        async delete(key) {
            await idbRequest(store('readwrite').delete(key))
        },
        async list() {
            const keys = await idbRequest<IDBValidKey[]>(store('readonly').getAllKeys())
            return keys.map(String)
        },
        async clear() {
            await idbRequest(store('readwrite').clear())
        },
    }
}

// ---------------------------------------------------------------------------
// No-persistence fallback: every get() re-downloads. Analysis still works, just
// without the "instant on repeat visit" property — better than throwing when
// both OPFS and IndexedDB are unavailable (locked-down browsers, private mode).
// ---------------------------------------------------------------------------

// Exported for tests — see __tests__/bigFileStorage.test.ts's no-persistence-path
// coverage. Not otherwise part of the public API app code should reach for.
export function createNoopBackend(): BigFileBackend {
    return {
        async get() {
            return null
        },
        async set() {},
        async delete() {},
        async list() {
            return []
        },
        async clear() {},
    }
}

/** Resolve which backend to use: OPFS (probed for real) → IndexedDB → no-persistence.
 * This is the one function to override to change/fake backend selection — see
 * createBigFileStore. */
export async function selectBackend(): Promise<BigFileBackend> {
    const root = await opfsRoot()
    if (root) return createOpfsBackend(root)
    try {
        return createIdbBackend(await openIdb())
    } catch {
        return createNoopBackend()
    }
}

// ---------------------------------------------------------------------------
// The store factory
// ---------------------------------------------------------------------------

/** Build a BigFileStore over an injectable backend resolver + transport. Backend
 * resolution is memoized per store instance (not module-level), so every store —
 * the real singleton below or a test's throwaway instance — owns its own state. */
export function createBigFileStore(
    getBackend: () => Promise<BigFileBackend>,
    transport: Transport = xhrTransport,
): BigFileStore {
    let backendPromise: Promise<BigFileBackend> | null = null
    function backend(): Promise<BigFileBackend> {
        if (!backendPromise) backendPromise = getBackend()
        return backendPromise
    }

    return {
        async get(url, onProgress) {
            const b = await backend()
            const cached = await b.get(url)
            if (cached) return cached

            // Buffered in memory as one Uint8Array before we ever call b.set(), so a
            // failed/aborted download can never leave a partial file persisted.
            const data = await transport.download(url, onProgress)
            await b.set(url, data)
            return data
        },
        async has(url) {
            const b = await backend()
            return (await b.get(url)) !== null
        },
        async delete(url) {
            const b = await backend()
            await b.delete(url)
        },
        async list() {
            return (await backend()).list()
        },
        async clear() {
            await (await backend()).clear()
        },
    }
}

/** App-wide store: real OPFS/IndexedDB/no-persistence selection, real XHR
 * downloads. Nothing here touches navigator/indexedDB at import time — only when
 * a method is first called — so importing this module is safe under Vite
 * SSR/build and under `bun test`. */
export const bigFileStorage: BigFileStore = createBigFileStore(selectBackend)
