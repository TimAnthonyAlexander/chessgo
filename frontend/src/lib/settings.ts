// User preferences store — the single source of truth for every device-local
// setting exposed in the Appearance/Settings modal (chess.com/Lichess-style
// toggles). Lives outside React like the auth/socket/boardTheme stores; React
// reads it via the hooks below (useSyncExternalStore).
//
// Persistence: ONE JSON blob under `chessgo.prefs`, merged over DEFAULTS on load
// so adding a new key later never breaks an existing user (missing keys fall back
// to their default). Board color theme + piece set live in boardTheme.ts, and the
// sound master toggle + timbre live in sounds.ts/soundTheme.ts — those keep their
// own keys; this store owns everything else.
//
// A few settings are CSS-custom-property driven (animation speed, board
// brightness): they're pushed onto <html> via applyVars() on init + on change, so
// every Board/MiniBoard repaints for free — exactly like boardTheme's palette vars.
import { useSyncExternalStore } from 'react'
import { sanToGlyph } from './chess'

export type CoordMode = 'inside' | 'outside' | 'off'
export type AnimSpeed = 'none' | 'fast' | 'normal' | 'slow'
export type MoveMethod = 'both' | 'click' | 'drag'
export type ArrowColor = 'green' | 'blue' | 'red' | 'yellow'
export type Notation = 'san' | 'figurine'

export interface Prefs {
    // --- Board display ---
    showLegalMoves: boolean
    showCoordinates: CoordMode
    highlightLastMove: boolean
    highlightCheck: boolean
    highlightDragOver: boolean
    animationSpeed: AnimSpeed
    /** Board square brightness, 70–100 (%). 100 = untouched. */
    boardBrightness: number
    blindfold: boolean
    // --- Move input / behavior ---
    autoQueen: boolean
    moveMethod: MoveMethod
    premoves: boolean
    arrowColor: ArrowColor
    /** Move-list notation: plain SAN (default) or figurine piece glyphs. */
    notation: Notation
    // --- Gameplay UX (game pages) ---
    confirmResign: boolean
    autoFlip: boolean
    zenMode: boolean
    showOpponentRating: boolean
    showEvalBar: boolean
    showMoveList: boolean
    // --- Sound ---
    /** Master output volume, 0–100 (100 = the engine's full headroom). */
    soundVolume: number
    soundLowTime: boolean
}

export const DEFAULTS: Prefs = {
    showLegalMoves: true,
    showCoordinates: 'inside',
    highlightLastMove: true,
    highlightCheck: true,
    highlightDragOver: true,
    animationSpeed: 'normal',
    boardBrightness: 100,
    blindfold: false,
    autoQueen: false,
    moveMethod: 'both',
    premoves: true,
    arrowColor: 'green',
    notation: 'san',
    confirmResign: true,
    autoFlip: false,
    zenMode: false,
    showOpponentRating: true,
    showEvalBar: true,
    showMoveList: true,
    soundVolume: 100,
    soundLowTime: true,
}

const LS_KEY = 'chessgo.prefs'

// Piece-fade animation duration for each speed tier (ms). Drives --piece-anim.
const ANIM_MS: Record<AnimSpeed, number> = { none: 0, fast: 90, normal: 160, slow: 280 }

/** Coerce a persisted blob into a valid Prefs: keep only keys we know, of the
 * right shape, else fall back to the default for that key. Never throws. */
function sanitize(raw: unknown): Prefs {
    const out: Prefs = { ...DEFAULTS }
    if (!raw || typeof raw !== 'object') return out
    const r = raw as Record<string, unknown>
    const bool = (k: keyof Prefs) => {
        if (typeof r[k] === 'boolean') (out[k] as boolean) = r[k] as boolean
    }
    const oneOf = <T extends string>(k: keyof Prefs, allowed: readonly T[]) => {
        if (typeof r[k] === 'string' && (allowed as readonly string[]).includes(r[k] as string))
            (out[k] as T) = r[k] as T
    }
    const clampNum = (k: keyof Prefs, lo: number, hi: number) => {
        const v = r[k]
        if (typeof v === 'number' && isFinite(v)) (out[k] as number) = Math.min(hi, Math.max(lo, v))
    }
    bool('showLegalMoves')
    oneOf('showCoordinates', ['inside', 'outside', 'off'] as const)
    bool('highlightLastMove')
    bool('highlightCheck')
    bool('highlightDragOver')
    oneOf('animationSpeed', ['none', 'fast', 'normal', 'slow'] as const)
    clampNum('boardBrightness', 70, 100)
    bool('blindfold')
    bool('autoQueen')
    oneOf('moveMethod', ['both', 'click', 'drag'] as const)
    bool('premoves')
    oneOf('arrowColor', ['green', 'blue', 'red', 'yellow'] as const)
    oneOf('notation', ['san', 'figurine'] as const)
    bool('confirmResign')
    bool('autoFlip')
    bool('zenMode')
    bool('showOpponentRating')
    bool('showEvalBar')
    bool('showMoveList')
    clampNum('soundVolume', 0, 100)
    bool('soundLowTime')
    return out
}

class SettingsStore {
    private state: Prefs = { ...DEFAULTS }
    private listeners = new Set<() => void>()

    /** Read persisted prefs and push CSS-var-driven ones onto <html>. Call once,
     * synchronously, before first render (main.tsx) to avoid a flash. */
    init(): void {
        try {
            const raw = localStorage.getItem(LS_KEY)
            this.state = raw ? sanitize(JSON.parse(raw)) : { ...DEFAULTS }
        } catch {
            this.state = { ...DEFAULTS }
        }
        this.applyVars()
    }

    getSnapshot = (): Prefs => this.state
    subscribe = (fn: () => void): (() => void) => {
        this.listeners.add(fn)
        return () => this.listeners.delete(fn)
    }

    get<K extends keyof Prefs>(key: K): Prefs[K] {
        return this.state[key]
    }

    set<K extends keyof Prefs>(key: K, value: Prefs[K]): void {
        if (this.state[key] === value) return
        this.state = { ...this.state, [key]: value }
        this.persist()
        this.applyVars()
        this.emit()
    }

    reset(): void {
        this.state = { ...DEFAULTS }
        this.persist()
        this.applyVars()
        this.emit()
    }

    // Push the CSS-var-driven settings onto <html>: piece animation duration and
    // the board dim overlay (1 - brightness). Board.css reads both.
    private applyVars(): void {
        if (typeof document === 'undefined') return
        const root = document.documentElement
        root.style.setProperty('--piece-anim', `${ANIM_MS[this.state.animationSpeed]}ms`)
        const dim = Math.min(1, Math.max(0, (100 - this.state.boardBrightness) / 100))
        root.style.setProperty('--board-dim', dim.toFixed(3))
    }

    private persist(): void {
        try {
            localStorage.setItem(LS_KEY, JSON.stringify(this.state))
        } catch {
            // ignore quota / unavailable (private mode)
        }
    }

    private emit(): void {
        for (const l of this.listeners) l()
    }
}

export const settingsStore = new SettingsStore()

/** Apply persisted prefs (+ their CSS vars) to <html>. Call once in main.tsx. */
export function initSettings(): void {
    settingsStore.init()
}

/** Subscribe to the whole prefs object. Re-renders on any change (changes are
 * user-driven and rare, so a single coarse subscription is fine). */
export function usePrefs(): Prefs {
    return useSyncExternalStore(settingsStore.subscribe, settingsStore.getSnapshot)
}

/** Subscribe to a single setting. */
export function useSetting<K extends keyof Prefs>(key: K): Prefs[K] {
    return useSyncExternalStore(settingsStore.subscribe, () => settingsStore.getSnapshot()[key])
}

// --- Notation helpers -------------------------------------------------------
// One place decides how a SAN string is displayed. Default is plain SAN; figurine
// swaps the leading piece letter (K/Q/R/B/N) for its glyph via boardTheme's
// sanToGlyph. Use formatSan() for string contexts (props, tooltips) and the
// <MoveSan> component (which also handles the Duck 🦆) for JSX move tables.

/** Format a SAN string per the active notation preference (pure, reads snapshot). */
export function formatSan(san: string, notation: Notation = settingsStore.get('notation')): string {
    return notation === 'figurine' ? sanToGlyph(san) : san
}

/** Reactive notation preference for components. */
export function useNotation(): Notation {
    return useSetting('notation')
}
