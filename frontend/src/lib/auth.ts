// Singleton auth store (session-cookie based). Lives outside React so the
// current user survives navigation; components read it via useAuth
// (useSyncExternalStore). Mirrors the gameSocket store pattern.
import { useSyncExternalStore } from 'react'
import { login as apiLogin, logout as apiLogout, me, signup as apiSignup, type User } from '../api/client'
import { gameSocket } from './socket'

interface AuthState {
  user: User | null
  status: 'loading' | 'ready'
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

  /** Re-fetch the current user (e.g. after a rated game changes the rating).
   * No-op when signed out. */
  async refresh(): Promise<void> {
    if (!this.state.user) return
    try {
      const user = await me()
      this.set({ user })
    } catch {
      // keep the stale user rather than dropping the session on a transient error
    }
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
