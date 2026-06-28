import { useSyncExternalStore } from 'react'
import { gameSocket, type SocketState } from './socket'

/** Subscribe to the realtime socket store. */
export function useGameSocket(): SocketState {
    return useSyncExternalStore(gameSocket.subscribe, gameSocket.getState)
}
