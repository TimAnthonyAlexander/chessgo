// Singleton auth store (session-cookie based). Lives outside React so the
// current user survives navigation; components read it via useAuth
// (useSyncExternalStore). Mirrors the gameSocket store pattern.
import { useSyncExternalStore } from 'react'
import {
    login as apiLogin,
    logout as apiLogout,
    me,
    signup as apiSignup,
    type User,
} from '../api/client'
import { gameSocket } from './socket'

interface AuthState {
    user: User | null
    status: 'loading' | 'ready'
}

// Sum of games played across every rated pool. A rated game/puzzle always bumps
// exactly one of these by one, so a change is the reliable signal that a finished
// result has been persisted server-side (see AuthStore.refresh).
function totalGames(u: User): number {
    return (
        u.games_bullet +
        u.games_blitz +
        u.games_rapid +
        u.games_classical +
        u.games_puzzle +
        u.games_duck
    )
}

class AuthStore {
    private state: AuthState = { user: null, status: 'loading' }
    private listeners = new Set<() => void>()
    private started = false

    getState = (): AuthState => this.state

    subscribe = (fn: () => void): (() => void) => {
        this.listeners.add(fn)
        return () => this.listeners.delete(fn)
    }

    private set(patch: Partial<AuthState>) {
        this.state = { ...this.state, ...patch }
        for (const l of this.listeners) l()
    }

    /** Resolve the current session once on app load. */
    async init(): Promise<void> {
        if (this.started) return
        this.started = true
        try {
            const user = await me()
            this.set({ user, status: 'ready' })
        } catch {
            this.set({ user: null, status: 'ready' })
        }
    }

    /** Re-fetch the current user after a rated result (game or puzzle) so the navbar
     * rating updates. BaseAPI persists a finished game + applies the new Elo
     * fire-and-forget AFTER the hub sends `end`, so a single immediate me() usually
     * races AHEAD of the rating write and reads the stale number. We poll a few times
     * (short widening backoff) until the server reflects the new game — detected by
     * the total games count incrementing — then apply it. Falls back to applying the
     * latest read if the change never lands (so nothing is worse than before).
     * No-op when signed out. */
    async refresh(): Promise<void> {
        const before = this.state.user
        if (!before) return
        const baseline = totalGames(before)
        // First read is immediate; the rest cover the persistence lag after `end`.
        const delays = [0, 500, 1000, 2000, 3500]
        let latest: User | null = null
        for (const d of delays) {
            if (d) await new Promise((r) => setTimeout(r, d))
            if (!this.state.user) return // signed out mid-poll — don't resurrect
            try {
                const user = await me()
                if (!user) return // session ended (401) — leave logout to that flow
                latest = user
                if (totalGames(user) !== baseline) {
                    this.set({ user })
                    return
                }
            } catch {
                // transient error — keep polling, then fall back below
            }
        }
        // The increment never showed (slow/failed persistence): apply the most recent
        // read anyway, or keep the stale user if every fetch failed.
        if (latest) this.set({ user: latest })
    }

    async login(email: string, password: string): Promise<void> {
        const user = await apiLogin(email, password)
        this.set({ user, status: 'ready' })
        gameSocket.reidentify() // re-mint the ws-ticket under the account identity
    }

    async signup(name: string, email: string, password: string): Promise<void> {
        const user = await apiSignup(name, email, password)
        this.set({ user, status: 'ready' })
        gameSocket.reidentify()
    }

    async logout(): Promise<void> {
        try {
            await apiLogout()
        } finally {
            this.set({ user: null })
            gameSocket.reidentify() // back to an anonymous ticket
        }
    }
}

export const authStore = new AuthStore()

export function useAuth(): AuthState {
    return useSyncExternalStore(authStore.subscribe, authStore.getState)
}
