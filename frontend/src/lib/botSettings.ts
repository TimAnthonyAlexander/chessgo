import type { Color } from '../api/client'
import type { Variant } from './variants'

export type ColorChoice = Color | 'random'

export interface BotSettings {
    rating: number
    colorChoice: ColorChoice
    variant: Variant
}

const KEY = 'botgame:settings'
const RATING_MIN = 700
const RATING_MAX = 2900
const VARIANTS: readonly Variant[] = ['standard', 'chess960', 'duck', 'crazyhouse']
const COLORS: readonly ColorChoice[] = ['w', 'b', 'random']

export const DEFAULT_BOT_SETTINGS: BotSettings = {
    rating: 1500,
    colorChoice: 'w',
    variant: 'standard',
}

// Load the player's last-used bot-game setup. Every field is validated against
// its allowed range/set and falls back to the default if missing or garbage, so
// stale or hand-edited storage can never produce an invalid setup. Never throws
// (localStorage may be unavailable, e.g. private mode).
export function loadBotSettings(): BotSettings {
    try {
        const raw = localStorage.getItem(KEY)
        if (!raw) return DEFAULT_BOT_SETTINGS
        const p = JSON.parse(raw) as Partial<BotSettings>
        const rating =
            typeof p.rating === 'number' && Number.isFinite(p.rating)
                ? Math.min(RATING_MAX, Math.max(RATING_MIN, Math.round(p.rating / 50) * 50))
                : DEFAULT_BOT_SETTINGS.rating
        const variant = VARIANTS.includes(p.variant as Variant)
            ? (p.variant as Variant)
            : DEFAULT_BOT_SETTINGS.variant
        const colorChoice = COLORS.includes(p.colorChoice as ColorChoice)
            ? (p.colorChoice as ColorChoice)
            : DEFAULT_BOT_SETTINGS.colorChoice
        return { rating, colorChoice, variant }
    } catch {
        return DEFAULT_BOT_SETTINGS
    }
}

// Persist the setup — best-effort (a full/unavailable store is a no-op).
export function saveBotSettings(s: BotSettings): void {
    try {
        localStorage.setItem(KEY, JSON.stringify(s))
    } catch {
        /* storage unavailable — persistence is optional */
    }
}
