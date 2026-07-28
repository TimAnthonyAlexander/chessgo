// Global keyboard-shortcut registry — the one place every page/board feature
// declares its key bindings, so a single `?` overlay (ShortcutsDialog) can list
// whatever is active on the current page without hand-maintaining a modal per
// page (the thing lila#18855 complains about). Lives outside React like the
// settings/boardTheme stores; components read it via the hooks below
// (useSyncExternalStore) and register into it via useShortcuts.
//
// Ownership: a "scope" is one registration slot (usually one page or one
// always-on feature, e.g. 'global', 'move-nav', 'analysis'). Registering the
// same scope again — including a remount — REPLACES its entries, it never
// duplicates them, because the registry is keyed by scope in a Map.
//
// There is exactly ONE `keydown` listener for the whole app (installed by
// Layout via useGlobalShortcutListener). It walks every registered scope in
// registration order — globals first, since Layout mounts before any routed
// page — and runs the first shortcut whose combo matches and that actually has
// a `run`. Entries without `run` are display-only documentation for keys
// handled elsewhere (e.g. Board.tsx owns its own hold-H / Escape listener).
import { useEffect, useRef, useSyncExternalStore } from 'react'

export interface Shortcut {
    /** Key combo to match against KeyboardEvent.key, e.g. 'ArrowLeft', 'f',
     * 'shift+b', '?'. Modifiers are lowercase, joined with '+', in
     * ctrl/alt/shift/meta order, before the base key. Named keys keep their
     * KeyboardEvent casing ('ArrowLeft', 'Escape', 'Home', 'End'). Single
     * letters are matched case-insensitively unless 'shift+' is spelled out
     * explicitly ('b' vs 'shift+b' are different shortcuts). Punctuation
     * matches the character a keyboard actually produces, not the physical
     * key — '?' is Shift+/ on most layouts, but you write '?', not 'shift+/'. */
    keys: string
    /** Human-readable action shown in the shortcuts dialog, e.g. 'Previous move'. */
    label: string
    /** Display group in the dialog. Defaults to the registering scope name if
     * omitted — pass an explicit one so the dialog reads naturally. */
    group?: string
    /** Handler to run on match. Omit for a display-only entry that documents a
     * key some other component already listens for directly (e.g. Board.tsx). */
    run?: () => void
}

export interface ShortcutGroup {
    group: string
    shortcuts: Shortcut[]
}

type ShortcutsRef = { current: Shortcut[] }

// --- Key matching ------------------------------------------------------------

const MOD_ORDER = ['ctrl', 'alt', 'shift', 'meta'] as const

/** Normalize an authored `keys` string into the same canonical form
 * eventToKeyString() produces, so registration order/casing/spelling doesn't
 * matter as long as the combo is the same. */
function canonicalize(keys: string): string {
    const parts = keys.split('+')
    const base = parts.pop() ?? keys
    const mods = new Set(parts.map((m) => m.toLowerCase()))
    const ordered = MOD_ORDER.filter((m) => mods.has(m))
    // Named keys (length > 1, e.g. 'ArrowLeft') keep their casing; single
    // characters are lowercased so 'F' and 'f' register the same shortcut.
    const baseNorm = base.length > 1 ? base : base.toLowerCase()
    return ordered.length ? `${ordered.join('+')}+${baseNorm}` : baseNorm
}

/** Build the same canonical string from a live KeyboardEvent. */
function eventToKeyString(e: KeyboardEvent): string {
    const key = e.key
    const isNamed = key.length > 1
    const isLetter = !isNamed && /^[a-zA-Z]$/.test(key)
    const mods: string[] = []
    if (e.ctrlKey) mods.push('ctrl')
    if (e.altKey) mods.push('alt')
    // Shift only becomes part of the combo for named keys and letters. For
    // punctuation/digits it's already baked into e.key (Shift+/ → '?'), and
    // authors match that character directly rather than 'shift+/'.
    if (e.shiftKey && (isNamed || isLetter)) mods.push('shift')
    if (e.metaKey) mods.push('meta')
    const base = isNamed ? key : isLetter ? key.toLowerCase() : key
    return mods.length ? `${mods.join('+')}+${base}` : base
}

// MUI portals every open Dialog/Modal/Drawer as a `.MuiModal-root` element,
// sibling to the app root. Checking for its presence — instead of having every
// dialog in the app tell us it opened — needs zero coordination with dialogs
// this file doesn't own (AuthDialog, ThemeDialog, MobileNavDrawer, ...).
function isModalOpen(): boolean {
    return document.querySelector('.MuiModal-root') !== null
}

// --- Registry ------------------------------------------------------------

class ShortcutRegistry {
    private entries = new Map<string, ShortcutsRef>()
    private listeners = new Set<() => void>()
    private cachedGroups: ShortcutGroup[] = []

    register(scope: string, ref: ShortcutsRef): void {
        this.entries.set(scope, ref)
        this.emit()
    }

    unregister(scope: string): void {
        this.entries.delete(scope)
        this.emit()
    }

    getSnapshot = (): ShortcutGroup[] => this.cachedGroups

    subscribe = (fn: () => void): (() => void) => {
        this.listeners.add(fn)
        return () => this.listeners.delete(fn)
    }

    /** Match a keydown against every registered shortcut, in registration
     * order (globals first), and run the first match that has a handler.
     * Never preventDefault()s unless something actually matched, so unbound
     * keys are never swallowed. */
    dispatch(e: KeyboardEvent): void {
        const pressed = eventToKeyString(e)
        // While any modal is open, only Escape (close it) and '?' (harmless —
        // may already be open) are allowed through; everything else underneath
        // stays inert until the modal closes.
        if (isModalOpen() && pressed !== 'Escape' && pressed !== '?') return

        for (const [, ref] of this.entries) {
            for (const sc of ref.current) {
                if (!sc.run) continue
                if (canonicalize(sc.keys) !== pressed) continue
                sc.run()
                e.preventDefault()
                return
            }
        }
    }

    private emit(): void {
        this.rebuild()
        for (const l of this.listeners) l()
    }

    // Flattens the registry into display groups, preserving first-seen order
    // across scopes (globals first) and within a scope's own shortcuts.
    private rebuild(): void {
        const order: string[] = []
        const byGroup = new Map<string, Shortcut[]>()
        for (const [scope, ref] of this.entries) {
            for (const sc of ref.current) {
                const label = sc.group ?? scope
                if (!byGroup.has(label)) {
                    byGroup.set(label, [])
                    order.push(label)
                }
                byGroup.get(label)!.push(sc)
            }
        }
        this.cachedGroups = order.map((group) => ({ group, shortcuts: byGroup.get(group)! }))
    }
}

const shortcutRegistry = new ShortcutRegistry()

function handleKeyDown(e: KeyboardEvent): void {
    if (e.defaultPrevented || e.isComposing) return
    const t = e.target as HTMLElement | null
    const tag = t?.tagName
    if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || t?.isContentEditable) return
    shortcutRegistry.dispatch(e)
}

// --- Hooks ------------------------------------------------------------

/** Register `shortcuts` under `scope` for as long as the calling component is
 * mounted. `shortcuts` doesn't need a stable identity across renders — it's
 * read through a ref that's refreshed every render, so passing a fresh inline
 * array/closures each time (the common case) is fine and always fires the
 * latest handlers. Only mount/unmount (or a `scope` change) touches the
 * registry itself, so re-renders never cause registration churn. */
export function useShortcuts(scope: string, shortcuts: Shortcut[]): void {
    const ref = useRef<Shortcut[]>(shortcuts)
    ref.current = shortcuts

    useEffect(() => {
        shortcutRegistry.register(scope, ref)
        return () => shortcutRegistry.unregister(scope)
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [scope])
}

/** Everything currently registered, grouped for the shortcuts dialog — globals
 * first, then the active page's own groups, in registration order. */
export function useRegisteredShortcuts(): ShortcutGroup[] {
    return useSyncExternalStore(shortcutRegistry.subscribe, shortcutRegistry.getSnapshot)
}

// Reference-counted so mounting it more than once (HMR, a stray extra call)
// never double-attaches the listener.
let listenerRefCount = 0

/** Install the single app-wide keydown listener. Call once, at the app shell
 * (Layout) — every page/feature then just calls useShortcuts, no listener of
 * its own. */
export function useGlobalShortcutListener(): void {
    useEffect(() => {
        listenerRefCount += 1
        if (listenerRefCount === 1) window.addEventListener('keydown', handleKeyDown)
        return () => {
            listenerRefCount -= 1
            if (listenerRefCount === 0) window.removeEventListener('keydown', handleKeyDown)
        }
    }, [])
}
