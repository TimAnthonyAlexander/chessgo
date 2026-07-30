// Persisted opt-in switch for the in-browser (WASM) local engine — OFF by
// default, exactly like Lichess: the local engine only ever starts because the
// user flipped this on. Nothing downloads or runs before that (see
// useLocalEngineRace.ts, the only consumer that acts on it).
//
// Deliberately its OWN localStorage key (`engine.enabled`), not folded into
// settings.ts's `chessgo.prefs` blob: that blob is Analysis/game VIEW
// preferences (board colors, arrows, sound…) read/written together as one JSON
// object on every change. This flag is read once at mount to decide whether to
// even attempt the local engine, and toggled rarely — coupling it to the
// prefs blob would mean every unrelated pref change re-serializes this too,
// for no benefit.
//
// Built as an injectable-storage factory (createLocalEngineSettingsStore),
// same DI pattern as bigFileStorage.ts's createBigFileStore and features.ts's
// createFeatureDetector, so it's fully unit-testable without touching the
// real localStorage — see __tests__/settings.test.ts.
import { useSyncExternalStore } from 'react'

export const ENGINE_ENABLED_KEY = 'engine.enabled'

/** The minimal storage surface this store needs — `Storage`-compatible so the
 * real `localStorage` satisfies it directly, but a test can hand in a plain
 * object. */
export interface StorageLike {
    getItem(key: string): string | null
    setItem(key: string, value: string): void
}

export interface LocalEngineSettingsStore {
    isEnabled(): boolean
    setEnabled(enabled: boolean): void
    subscribe(listener: () => void): () => void
}

function readEnabled(storage: StorageLike): boolean {
    try {
        // Absent key (never toggled) reads as not-'1', i.e. false — the
        // documented default.
        return storage.getItem(ENGINE_ENABLED_KEY) === '1'
    } catch {
        return false
    }
}

/** Build a store over an injectable backend. State is captured in this
 * closure (not module-level), so every instance — the real singleton below or
 * a test's throwaway store — owns its own state, same reasoning as
 * bigFileStorage.ts's createBigFileStore. */
export function createLocalEngineSettingsStore(storage: StorageLike): LocalEngineSettingsStore {
    let enabled = readEnabled(storage)
    const listeners = new Set<() => void>()

    return {
        isEnabled: () => enabled,
        setEnabled(next) {
            if (next === enabled) return
            enabled = next
            try {
                storage.setItem(ENGINE_ENABLED_KEY, next ? '1' : '0')
            } catch {
                // ignore — quota / unavailable (private mode); the toggle still
                // works for this session, it just won't persist.
            }
            for (const l of listeners) l()
        },
        subscribe(listener) {
            listeners.add(listener)
            return () => listeners.delete(listener)
        },
    }
}

// `localStorage` access can throw outright in some locked-down embeds, not
// just on write — probe once at construction rather than per-call.
function safeLocalStorage(): StorageLike {
    try {
        if (typeof localStorage === 'undefined') {
            return { getItem: () => null, setItem: () => {} }
        }
        localStorage.getItem(ENGINE_ENABLED_KEY) // throws here if access is blocked at all
        return localStorage
    } catch {
        return { getItem: () => null, setItem: () => {} }
    }
}

/** App-wide store, real localStorage. Nothing here touches `localStorage` at
 * import time beyond this one synchronous read, mirroring how settingsStore.ts
 * / usePersistentBool already read their own keys on init/mount — safe under
 * Vite SSR/build and under `bun test`. */
export const localEngineSettings: LocalEngineSettingsStore = createLocalEngineSettingsStore(safeLocalStorage())

/** React binding: `[enabled, setEnabled]`, shaped like `useState` so call
 * sites read the same as chessgo's other persisted toggles
 * (`usePersistentBool` in Analysis.tsx). */
export function useLocalEngineEnabled(): [boolean, (enabled: boolean) => void] {
    const enabled = useSyncExternalStore(localEngineSettings.subscribe, localEngineSettings.isEnabled)
    return [enabled, localEngineSettings.setEnabled]
}
