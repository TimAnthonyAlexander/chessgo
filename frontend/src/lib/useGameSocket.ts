import { useSyncExternalStore } from 'react'
import { gameSocket, type SocketState } from './socket'

/** Subscribe to the realtime socket store. Re-renders on EVERY socket event —
 * GameSocket.set() replaces the whole state object on every message, so this
 * can never bail out. Fine for occasional lobby-ish reads; a page that lives
 * on the socket for a whole game (LiveGame) should use useGameSocketField
 * instead so unrelated events (chat, presence, arena/challenge noise) don't
 * force it to re-render. */
export function useGameSocket(): SocketState {
    return useSyncExternalStore(gameSocket.subscribe, gameSocket.getState)
}

/** Subscribe to exactly one top-level field of the socket store. Bails out of
 * re-rendering when a message only touches OTHER fields — e.g. a component
 * reading just `game` and `conn` won't re-render for an arena/challenge/error
 * event. Safe for useSyncExternalStore without a cache: GameSocket.set() does
 * `{ ...state, ...patch }`, so any key NOT in the patch keeps the exact same
 * reference it already had — getSnapshot here returns that same reference
 * call after call until the field actually changes, which is exactly what
 * useSyncExternalStore needs to avoid an infinite loop. */
export function useGameSocketField<K extends keyof SocketState>(key: K): SocketState[K] {
    return useSyncExternalStore(gameSocket.subscribe, () => gameSocket.getState()[key])
}
