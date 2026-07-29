// Site theme store — the single source of truth for the WEBSITE chrome:
// the page background, the light/dark mode, and the accent/neutral palette.
//
// This is deliberately SEPARATE from the chess board theme (lib/boardTheme.ts):
// the board palette owns the `--board-*` variables; this store owns the site
// chrome variables (`--bg`, `--surface`, `--line`, `--text`, `--accent`, …) plus
// the page backdrop. The two never touch each other's variables, so picking a
// board theme never changes the site chrome and vice-versa.
//
// Three independent axes, each its own localStorage key so they compose freely:
//   • mode     — 'light' | 'dark' | 'system'   (system follows the OS)
//   • palette  — an accent+neutral family (Brass, Evergreen, Claret, …)
//   • backdrop — how the page background is painted (Flat, Atmosphere, Grid)
//
// Everything is applied as CSS custom properties on <html>, exactly like
// boardTheme, so every component that reads a `var(--…)` token repaints for free.
// initSiteTheme() runs synchronously in main.tsx BEFORE first paint, so there is
// no theme flash. The default (dark + brass + atmosphere) reproduces the original
// hand-authored look byte-for-byte, so existing users see zero change.
import { useSyncExternalStore } from 'react'

export type ThemeMode = 'light' | 'dark' | 'system'
export type ResolvedMode = 'light' | 'dark'
export type SitePaletteId =
    | 'brass'
    | 'evergreen'
    | 'claret'
    | 'harbor'
    | 'ember'
    | 'graphite'
export type BackdropId = 'flat' | 'atmosphere' | 'grid'

// --- Color helpers ----------------------------------------------------------

/** Parse #rgb / #rrggbb into [r,g,b] (0–255). */
function parseHex(hex: string): [number, number, number] {
    let h = hex.replace('#', '').trim()
    if (h.length === 3) h = h[0] + h[0] + h[1] + h[1] + h[2] + h[2]
    const n = parseInt(h, 16)
    return [(n >> 16) & 255, (n >> 8) & 255, n & 255]
}

/** `rgba(...)` string from a hex + alpha. */
function rgba(hex: string, a: number): string {
    const [r, g, b] = parseHex(hex)
    return `rgba(${r}, ${g}, ${b}, ${a})`
}

/** Mix a hex toward white (amt>0) or black (amt<0), amt in [-1,1]. Used to derive
 * the top of the accent gradient (a touch lighter) and its hover state. */
function shade(hex: string, amt: number): string {
    const [r, g, b] = parseHex(hex)
    const t = amt < 0 ? 0 : 255
    const p = Math.abs(amt)
    const mix = (c: number) => Math.round((t - c) * p + c)
    const to2 = (c: number) => c.toString(16).padStart(2, '0')
    return `#${to2(mix(r))}${to2(mix(g))}${to2(mix(b))}`
}

// --- Palette seeds ----------------------------------------------------------
// A seed is the minimal set of colors that DEFINE a palette in one mode; expand()
// derives the full variable map from it (accent-soft/line/gradient, premove, …) so
// every palette is structurally identical and can't drift. Values are hand-picked
// per (palette, mode) for legibility — in particular the accent doubles as button
// background (with `onAccent` ink) AND as small text on a surface, so light-mode
// accents are deepened to clear ~4.5:1 contrast on their light backgrounds.

interface Seed {
    bg: string
    bg2: string
    surface: string
    surface2: string
    line: string
    lineSoft: string
    text: string
    textDim: string
    muted: string
    accent: string
    /** Ink drawn ON the accent (button labels over the accent gradient). */
    onAccent: string
    /** Eval-bar shares (white/black material split); track the mode's contrast. */
    evalWhite: string
    evalBlack: string
    /** Status colors — tuned per mode so they stay legible on the mode's canvas. */
    live: string
    warn: string
    danger: string
}

interface SitePalette {
    id: SitePaletteId
    label: string
    /** One-line character note shown in the picker. */
    note: string
    dark: Seed
    light: Seed
}

// Shared dark/light status colors — most palettes reuse these; a palette may
// override in its seed (none currently need to).
const DARK_STATUS = { live: '#7bb661', warn: '#e9c46a', danger: '#e07a5f' }
const LIGHT_STATUS = { live: '#3f9d59', warn: '#b07d1e', danger: '#c85a42' }

const PALETTES: SitePalette[] = [
    {
        id: 'brass',
        label: 'Brass',
        note: 'Warm amber on cool near-black — the house style',
        // Dark seed is the original styles.css palette verbatim (zero regression).
        dark: {
            bg: '#131419',
            bg2: '#181a21',
            surface: '#1d2029',
            surface2: '#242834',
            line: '#2c313d',
            lineSoft: '#23262f',
            text: '#ece9e1',
            textDim: '#9fa1ac',
            muted: '#8a8d99',
            accent: '#d8a657',
            onAccent: '#15171c',
            evalWhite: '#f3eee2',
            evalBlack: '#191c22',
            ...DARK_STATUS,
        },
        light: {
            bg: '#f4f1e8',
            bg2: '#efeae0',
            surface: '#fffdf8',
            surface2: '#f6f2e9',
            line: '#e2dccd',
            lineSoft: '#ece7db',
            text: '#26221a',
            textDim: '#6d6759',
            muted: '#7c7566',
            accent: '#976c1a',
            onAccent: '#fffaf0',
            evalWhite: '#f5f1e6',
            evalBlack: '#2b2720',
            ...LIGHT_STATUS,
        },
    },
    {
        id: 'evergreen',
        label: 'Evergreen',
        note: 'Deep pine green on a cool forest charcoal',
        dark: {
            bg: '#101613',
            bg2: '#151d19',
            surface: '#19231e',
            surface2: '#1f2c26',
            line: '#293a32',
            lineSoft: '#202d27',
            text: '#e7ece6',
            textDim: '#9aa89f',
            muted: '#869388',
            accent: '#5cae82',
            onAccent: '#0d1712',
            evalWhite: '#eef2ec',
            evalBlack: '#16201b',
            ...DARK_STATUS,
        },
        light: {
            bg: '#f0f4ef',
            bg2: '#e8eee7',
            surface: '#fbfdfa',
            surface2: '#eef3ec',
            line: '#d6e0d6',
            lineSoft: '#e3ebe2',
            text: '#1c261f',
            textDim: '#5f6b62',
            muted: '#6e7a70',
            accent: '#2f7f56',
            onAccent: '#f4fbf6',
            evalWhite: '#f1f5ef',
            evalBlack: '#212a24',
            ...LIGHT_STATUS,
        },
    },
    {
        id: 'claret',
        label: 'Claret',
        note: 'Wine red on a warm oxblood-charcoal',
        dark: {
            bg: '#171112',
            bg2: '#1d1617',
            surface: '#231a1b',
            surface2: '#2c2122',
            line: '#3a2b2d',
            lineSoft: '#2a2021',
            text: '#efe7e5',
            textDim: '#ab9d9c',
            muted: '#968887',
            accent: '#c95d67',
            onAccent: '#1a1011',
            evalWhite: '#f3ece9',
            evalBlack: '#211819',
            ...DARK_STATUS,
        },
        light: {
            bg: '#f5f0ee',
            bg2: '#efe8e6',
            surface: '#fffbfa',
            surface2: '#f6efed',
            line: '#e4d6d4',
            lineSoft: '#ede2e0',
            text: '#271d1d',
            textDim: '#6f6160',
            muted: '#7e6f6e',
            accent: '#a83744',
            onAccent: '#fff4f3',
            evalWhite: '#f4efec',
            evalBlack: '#2b2121',
            ...LIGHT_STATUS,
        },
    },
    {
        id: 'harbor',
        label: 'Harbor',
        note: 'Deep teal on a cool slate-blue night',
        dark: {
            bg: '#0f151a',
            bg2: '#141c22',
            surface: '#18222a',
            surface2: '#1e2b34',
            line: '#293945',
            lineSoft: '#202d36',
            text: '#e6ecf0',
            textDim: '#96a4b0',
            muted: '#82909c',
            accent: '#3ea9b0',
            onAccent: '#0b1518',
            evalWhite: '#eef3f5',
            evalBlack: '#151f26',
            ...DARK_STATUS,
        },
        light: {
            bg: '#eef3f5',
            bg2: '#e6edf0',
            surface: '#f9fcfd',
            surface2: '#eaf1f3',
            line: '#d3dfe4',
            lineSoft: '#e0e9ed',
            text: '#1a2429',
            textDim: '#5c6a72',
            muted: '#6c7981',
            accent: '#0f7d86',
            onAccent: '#f1fbfc',
            evalWhite: '#f0f5f6',
            evalBlack: '#20292f',
            ...LIGHT_STATUS,
        },
    },
    {
        id: 'ember',
        label: 'Ember',
        note: 'Burnt orange on a warm smoked charcoal',
        dark: {
            bg: '#17130f',
            bg2: '#1c1713',
            surface: '#221c16',
            surface2: '#2b231c',
            line: '#392e25',
            lineSoft: '#282019',
            text: '#efe8df',
            textDim: '#a99e92',
            muted: '#94897d',
            accent: '#e07d4c',
            onAccent: '#1a1009',
            evalWhite: '#f4ede3',
            evalBlack: '#211a13',
            ...DARK_STATUS,
        },
        light: {
            bg: '#f5f1ea',
            bg2: '#efe9df',
            surface: '#fffcf6',
            surface2: '#f6f1e7',
            line: '#e5dccb',
            lineSoft: '#ede6d8',
            text: '#271f16',
            textDim: '#6e6455',
            muted: '#7d7263',
            accent: '#b45623',
            onAccent: '#fff6ee',
            evalWhite: '#f5efe4',
            evalBlack: '#2a2318',
            ...LIGHT_STATUS,
        },
    },
    {
        id: 'graphite',
        label: 'Graphite',
        note: 'Restrained steel-blue — accent almost neutral',
        dark: {
            bg: '#131519',
            bg2: '#181b20',
            surface: '#1c2027',
            surface2: '#232833',
            line: '#2c313b',
            lineSoft: '#22262e',
            text: '#e9eaee',
            textDim: '#9a9fa8',
            muted: '#868b94',
            accent: '#8298ac',
            onAccent: '#101318',
            evalWhite: '#eef0f3',
            evalBlack: '#181b21',
            ...DARK_STATUS,
        },
        light: {
            bg: '#f1f2f4',
            bg2: '#e9ebee',
            surface: '#fbfcfd',
            surface2: '#eef0f2',
            line: '#dbdee3',
            lineSoft: '#e6e8ec',
            text: '#20242a',
            textDim: '#616772',
            muted: '#707680',
            accent: '#4a6072',
            onAccent: '#f4f7fa',
            evalWhite: '#f0f2f4',
            evalBlack: '#242830',
            ...LIGHT_STATUS,
        },
    },
]

// Picker order.
const PALETTE_ORDER: SitePaletteId[] = [
    'brass', 'evergreen', 'harbor', 'claret', 'ember', 'graphite',
]
export const SITE_PALETTES: SitePalette[] = PALETTE_ORDER.map(
    (id) => PALETTES.find((p) => p.id === id)!,
)

/** Expand a seed into the full site CSS-variable map. */
function expand(s: Seed): Record<string, string> {
    return {
        '--bg': s.bg,
        '--bg-2': s.bg2,
        '--surface': s.surface,
        '--surface-2': s.surface2,
        '--line': s.line,
        '--line-soft': s.lineSoft,
        '--text': s.text,
        '--text-dim': s.textDim,
        '--muted': s.muted,
        '--accent': s.accent,
        '--accent-soft': rgba(s.accent, 0.14),
        '--accent-soft-strong': rgba(s.accent, 0.18),
        '--accent-line': rgba(s.accent, 0.4),
        '--accent-grad': `linear-gradient(180deg, ${shade(s.accent, 0.08)}, ${s.accent})`,
        '--accent-grad-hover': `linear-gradient(180deg, ${shade(s.accent, 0.14)}, ${shade(s.accent, 0.05)})`,
        '--on-accent': s.onAccent,
        '--live': s.live,
        '--warn': s.warn,
        '--danger': s.danger,
        '--premove': rgba(s.danger, 0.5),
        '--eval-white': s.evalWhite,
        '--eval-black': s.evalBlack,
    }
}

// --- Backdrops --------------------------------------------------------------
// The page background is `var(--bg)` painted with an optional `background-image`
// held in `--backdrop-image` (styles.css reads it on <body>). Each backdrop is
// tinted by the ACTIVE accent so the atmosphere stays cohesive with the palette.

const BACKDROPS: { id: BackdropId; label: string; note: string }[] = [
    { id: 'atmosphere', label: 'Atmosphere', note: 'Two soft accent glows' },
    { id: 'flat', label: 'Flat', note: 'Solid — no gradient' },
    { id: 'grid', label: 'Grid', note: 'Faint hairline lattice' },
]
export const SITE_BACKDROPS = BACKDROPS

/** A backdrop resolves to a `background-image` + matching `background-size` pair
 * (grid needs an explicit tile size; the radials size themselves). */
function backdrop(
    id: BackdropId,
    accent: string,
    line: string,
    mode: ResolvedMode,
): { image: string; size: string } {
    if (id === 'flat') return { image: 'none', size: 'auto' }
    if (id === 'grid') {
        // A near-invisible lattice using the line color; hairlines on a 54px tile.
        const c = line
        return {
            image: `linear-gradient(${c} 1px, transparent 1px), linear-gradient(90deg, ${c} 1px, transparent 1px)`,
            size: '54px 54px',
        }
    }
    // atmosphere: one warm glow top-center, one cooler glow bottom-right. Alpha is
    // kept lower in light mode so the wash never muddies white surfaces.
    const a1 = mode === 'dark' ? 0.07 : 0.05
    const a2 = mode === 'dark' ? 0.06 : 0.04
    return {
        image:
            `radial-gradient(1100px 620px at 50% -8%, ${rgba(accent, a1)}, transparent 70%),` +
            `radial-gradient(900px 600px at 88% 110%, ${rgba(shade(accent, -0.15), a2)}, transparent 70%)`,
        size: 'auto',
    }
}

// --- Store ------------------------------------------------------------------

const DEFAULT_MODE: ThemeMode = 'dark'
const DEFAULT_PALETTE: SitePaletteId = 'brass'
const DEFAULT_BACKDROP: BackdropId = 'atmosphere'
const LS_MODE = 'chessgo.site.mode'
const LS_PALETTE = 'chessgo.site.palette'
const LS_BACKDROP = 'chessgo.site.backdrop'

const paletteById = (id: string | null): SitePalette =>
    PALETTES.find((p) => p.id === id) ?? PALETTES.find((p) => p.id === DEFAULT_PALETTE)!
const asBackdrop = (v: string | null): BackdropId =>
    BACKDROPS.some((b) => b.id === v) ? (v as BackdropId) : DEFAULT_BACKDROP

export interface SiteThemeState {
    mode: ThemeMode
    palette: SitePaletteId
    backdrop: BackdropId
    /** The mode actually in effect (system → resolved via matchMedia). */
    resolved: ResolvedMode
}

/** Everything buildTheme() needs to keep the MUI theme in lockstep with the CSS
 * vars. Recomputed on every change so MUI-internal colors follow the palette. */
export interface MuiSeed {
    mode: ResolvedMode
    bg: string
    paper: string
    primary: string
    onPrimary: string
    text: string
    textSecondary: string
    divider: string
}

function systemPrefersDark(): boolean {
    if (typeof window === 'undefined' || !window.matchMedia) return true
    return window.matchMedia('(prefers-color-scheme: dark)').matches
}

class SiteThemeStore {
    private mode: ThemeMode = DEFAULT_MODE
    private palette: SitePaletteId = DEFAULT_PALETTE
    private backdrop: BackdropId = DEFAULT_BACKDROP
    private resolved: ResolvedMode = 'dark'
    private snap: SiteThemeState = {
        mode: DEFAULT_MODE,
        palette: DEFAULT_PALETTE,
        backdrop: DEFAULT_BACKDROP,
        resolved: 'dark',
    }
    private listeners = new Set<() => void>()

    /** Read persisted choices and paint the site palette + backdrop onto <html>.
     * Call once, synchronously, before first render (main.tsx). */
    init(): void {
        try {
            // The mode is deliberately NOT read back from storage: the site is
            // dark-only, and the settings modal no longer offers light/system. Anyone
            // who picked one of those before would otherwise be stuck there with no
            // control left to change it. Palette and backdrop still persist.
            this.palette = paletteById(localStorage.getItem(LS_PALETTE)).id
            this.backdrop = asBackdrop(localStorage.getItem(LS_BACKDROP))
        } catch {
            // localStorage unavailable (private mode) — keep defaults.
        }
        this.apply()
    }

    getSnapshot = (): SiteThemeState => this.snap
    subscribe = (fn: () => void): (() => void) => {
        this.listeners.add(fn)
        return () => this.listeners.delete(fn)
    }

    getMuiSeed(): MuiSeed {
        const seed = this.activeSeed()
        return {
            mode: this.resolved,
            bg: seed.bg,
            paper: seed.surface,
            primary: seed.accent,
            onPrimary: seed.onAccent,
            text: seed.text,
            textSecondary: seed.textDim,
            divider: seed.line,
        }
    }

    setMode(m: ThemeMode): void {
        if (this.mode === m) return
        this.mode = m
        this.persist(LS_MODE, m)
        this.apply()
    }

    setPalette(id: SitePaletteId): void {
        if (this.palette === id) return
        this.palette = paletteById(id).id
        this.persist(LS_PALETTE, this.palette)
        this.apply()
    }

    setBackdrop(id: BackdropId): void {
        if (this.backdrop === id) return
        this.backdrop = id
        this.persist(LS_BACKDROP, id)
        this.apply()
    }

    reset(): void {
        this.mode = DEFAULT_MODE
        this.palette = DEFAULT_PALETTE
        this.backdrop = DEFAULT_BACKDROP
        this.persist(LS_MODE, this.mode)
        this.persist(LS_PALETTE, this.palette)
        this.persist(LS_BACKDROP, this.backdrop)
        this.apply()
    }

    /** The {image,size} a backdrop would paint under the CURRENT palette+mode —
     * used to render live preview tiles for each backdrop option in the picker. */
    backdropPreview(id: BackdropId): { image: string; size: string } {
        const seed = this.activeSeed()
        return backdrop(id, seed.accent, seed.line, this.resolved)
    }

    private activeSeed(): Seed {
        const p = paletteById(this.palette)
        return this.resolved === 'light' ? p.light : p.dark
    }

    /** Resolve the mode, then push the full palette + backdrop + document
     * attributes onto <html>, and notify subscribers. */
    private apply(): void {
        this.resolved = this.mode === 'system' ? (systemPrefersDark() ? 'dark' : 'light') : this.mode
        const seed = this.activeSeed()
        if (typeof document !== 'undefined') {
            const root = document.documentElement
            const vars = expand(seed)
            for (const [k, v] of Object.entries(vars)) root.style.setProperty(k, v)
            const bd = backdrop(this.backdrop, seed.accent, seed.line, this.resolved)
            root.style.setProperty('--backdrop-image', bd.image)
            root.style.setProperty('--backdrop-size', bd.size)
            // Native form controls (scrollbars, inputs) + selection follow the mode.
            root.style.setProperty('color-scheme', this.resolved)
            root.setAttribute('data-theme', this.resolved)
            root.setAttribute('data-palette', this.palette)
            // Mobile browser chrome matches the canvas.
            const meta = document.querySelector('meta[name="theme-color"]')
            if (meta) meta.setAttribute('content', seed.bg)
        }
        this.snap = {
            mode: this.mode,
            palette: this.palette,
            backdrop: this.backdrop,
            resolved: this.resolved,
        }
        this.emit()
    }

    private persist(key: string, value: string): void {
        try {
            localStorage.setItem(key, value)
        } catch {
            // ignore quota / unavailable
        }
    }

    private emit(): void {
        for (const l of this.listeners) l()
    }
}

export const siteThemeStore = new SiteThemeStore()

/** Apply the persisted site theme to <html>. Call once in main.tsx before render. */
export function initSiteTheme(): void {
    siteThemeStore.init()
}

/** Preview swatch (accent + canvas + surface) for a palette in a given mode —
 * used by the picker so each option previews its OWN colors, not the active ones. */
export function paletteSwatch(id: SitePaletteId, mode: ResolvedMode) {
    const p = paletteById(id)
    const s = mode === 'light' ? p.light : p.dark
    return { bg: s.bg, surface: s.surface, accent: s.accent, text: s.text, line: s.line }
}

export function useSiteTheme(): SiteThemeState {
    return useSyncExternalStore(siteThemeStore.subscribe, siteThemeStore.getSnapshot)
}
