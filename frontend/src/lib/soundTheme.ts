// Sound-material store: the TIMBRE of move/capture cues. A device-local
// preference (localStorage), like the board theme / piece set — no account, and
// it survives navigation. Lives outside React (a singleton read via
// useSyncExternalStore), mirroring `boardTheme.ts`.
//
// A "material" is NOT an audio file — it's a preset of parameters fed to the
// existing modal-synthesis engine in `lib/sounds.ts` (which owns the actual audio
// params keyed by these ids). This module owns only the SELECTION + persistence +
// the picker metadata (label/description). Default is Wood — the original sound.
import { useSyncExternalStore } from 'react'

export type MaterialId = 'wood' | 'glass' | 'marble' | 'felt' | 'eightbit'

export interface SoundMaterial {
    id: MaterialId
    label: string
    /** One-phrase character description, shown under the option in the picker. */
    description: string
}

// Picker display order. Wood leads (it's the default + the classic sound); the
// rest run from hard/bright to soft to retro.
export const SOUND_MATERIALS: SoundMaterial[] = [
    { id: 'felt', label: 'Felt', description: 'Soft, muffled thud — the classic' },
    { id: 'wood', label: 'Wood', description: 'Warm inharmonic knock' },
    { id: 'glass', label: 'Glass', description: 'Bright, ringing, crystalline' },
    { id: 'marble', label: 'Marble', description: 'Hard, sharp click-clack' },
    { id: 'eightbit', label: '8-bit', description: 'Retro square-wave blip' },
]

const DEFAULT_MATERIAL: MaterialId = 'felt'
const LS_MATERIAL = 'chessgo.sound.material'

const isMaterial = (id: string | null): id is MaterialId =>
    SOUND_MATERIALS.some((m) => m.id === id)

function readMaterial(): MaterialId {
    try {
        const v = localStorage.getItem(LS_MATERIAL)
        return isMaterial(v) ? v : DEFAULT_MATERIAL
    } catch {
        // localStorage unavailable (private mode / SSR) — keep the default.
        return DEFAULT_MATERIAL
    }
}

class SoundThemeStore {
    // Read the persisted preference eagerly on construction (client-side module
    // load) so there is no init() step to wire into main.tsx — unlike the board
    // theme, a material paints nothing, so it needs no pre-render apply.
    private material: MaterialId = readMaterial()
    private listeners = new Set<() => void>()

    /** The active material id. Read by the synth at play-time. */
    get = (): MaterialId => this.material

    getSnapshot = (): MaterialId => this.material

    subscribe = (fn: () => void): (() => void) => {
        this.listeners.add(fn)
        return () => this.listeners.delete(fn)
    }

    set(id: MaterialId): void {
        if (!isMaterial(id) || this.material === id) return
        this.material = id
        try {
            localStorage.setItem(LS_MATERIAL, id)
        } catch {
            // ignore quota / unavailable
        }
        for (const l of this.listeners) l()
    }

    /** Restore the default material (used by the Settings dialog's "Reset to
     * defaults"). Same shape as set(): persist + emit; a material paints nothing,
     * so there's no vars step. */
    reset(): void {
        if (this.material === DEFAULT_MATERIAL) return
        this.material = DEFAULT_MATERIAL
        try {
            localStorage.setItem(LS_MATERIAL, DEFAULT_MATERIAL)
        } catch {
            // ignore quota / unavailable
        }
        for (const l of this.listeners) l()
    }
}

export const soundThemeStore = new SoundThemeStore()

/** Subscribe a component to the active sound material. */
export function useSoundMaterial(): MaterialId {
    return useSyncExternalStore(soundThemeStore.subscribe, soundThemeStore.getSnapshot)
}
