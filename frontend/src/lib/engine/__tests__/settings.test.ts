// Runs under `bun test`. Uses a plain in-memory fake for StorageLike rather
// than the real localStorage (may not exist under bun test at all — see
// bigFileStorage.test.ts's precedent) or leaking state across tests.
import { describe, expect, test } from 'bun:test'
import { ENGINE_ENABLED_KEY, type StorageLike, createLocalEngineSettingsStore } from '../settings'

function createFakeStorage(initial: Record<string, string> = {}): StorageLike & { data: Record<string, string> } {
    const data = { ...initial }
    return {
        data,
        getItem: (key) => data[key] ?? null,
        setItem: (key, value) => {
            data[key] = value
        },
    }
}

describe('createLocalEngineSettingsStore', () => {
    test('defaults to false when the key was never set', () => {
        const store = createLocalEngineSettingsStore(createFakeStorage())
        expect(store.isEnabled()).toBeFalse()
    })

    test('reads a persisted "1" as enabled', () => {
        const store = createLocalEngineSettingsStore(createFakeStorage({ [ENGINE_ENABLED_KEY]: '1' }))
        expect(store.isEnabled()).toBeTrue()
    })

    test('reads anything other than "1" (e.g. "0", garbage) as disabled', () => {
        expect(createLocalEngineSettingsStore(createFakeStorage({ [ENGINE_ENABLED_KEY]: '0' })).isEnabled()).toBeFalse()
        expect(
            createLocalEngineSettingsStore(createFakeStorage({ [ENGINE_ENABLED_KEY]: 'garbage' })).isEnabled(),
        ).toBeFalse()
    })

    test('setEnabled(true) persists "1" under the documented key', () => {
        const storage = createFakeStorage()
        const store = createLocalEngineSettingsStore(storage)
        store.setEnabled(true)
        expect(store.isEnabled()).toBeTrue()
        expect(storage.data[ENGINE_ENABLED_KEY]).toBe('1')
    })

    test('setEnabled(false) persists "0"', () => {
        const storage = createFakeStorage({ [ENGINE_ENABLED_KEY]: '1' })
        const store = createLocalEngineSettingsStore(storage)
        store.setEnabled(false)
        expect(store.isEnabled()).toBeFalse()
        expect(storage.data[ENGINE_ENABLED_KEY]).toBe('0')
    })

    test('setEnabled with the same value is a no-op: no write, no notification', () => {
        const storage = createFakeStorage()
        const store = createLocalEngineSettingsStore(storage)
        let notifications = 0
        store.subscribe(() => {
            notifications++
        })
        store.setEnabled(false) // already false — matches the default
        expect(notifications).toBe(0)
        expect(storage.data[ENGINE_ENABLED_KEY]).toBe(undefined)
    })

    test('subscribers are notified on an actual change, and unsubscribe works', () => {
        const store = createLocalEngineSettingsStore(createFakeStorage())
        let notifications = 0
        const unsubscribe = store.subscribe(() => {
            notifications++
        })
        store.setEnabled(true)
        expect(notifications).toBe(1)
        unsubscribe()
        store.setEnabled(false)
        expect(notifications).toBe(1) // no longer subscribed
    })

    test('a storage that throws on every call degrades to an in-memory (still-working) toggle', () => {
        const throwing: StorageLike = {
            getItem: () => {
                throw new Error('blocked')
            },
            setItem: () => {
                throw new Error('blocked')
            },
        }
        const store = createLocalEngineSettingsStore(throwing)
        expect(store.isEnabled()).toBeFalse() // construction-time read failure -> default false
        store.setEnabled(true) // must not throw despite setItem failing
        expect(store.isEnabled()).toBeTrue() // in-memory state still updated
    })
})
