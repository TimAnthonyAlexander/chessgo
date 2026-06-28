import { useSyncExternalStore } from 'react'
import { spectateSocket, type SpectateState } from './spectate'

/** Subscribe to the spectator socket store. */
export function useSpectate(): SpectateState {
    return useSyncExternalStore(spectateSocket.subscribe, spectateSocket.getState)
}
