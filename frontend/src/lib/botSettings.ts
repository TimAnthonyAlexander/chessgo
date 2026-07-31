import type { Color } from '../api/client'
import type { Variant } from './variants'

export type ColorChoice = Color | 'random'

/** The "/bot" setup screen's time control choices. 'untimed' (the default) is
 *  the absence of a time control — createBotGame() only sends time_control
 *  when it's one of the real entries below. Mirrors BotGame::TIME_CONTROLS. */
export type TimeControl = 'untimed' | '1+0' | '3+0' | '3+2' | '5+0' | '10+0' | '15+10'

export interface BotSettings {
    rating: number
    colorChoice: ColorChoice
    variant: Variant
    timeControl: TimeControl
}

export const TIME_CONTROLS: readonly TimeControl[] = [
    'untimed',
    '1+0',
    '3+0',
    '3+2',
    '5+0',
    '10+0',
    '15+10',
]

/** Setup-screen label: "Untimed", or the time control itself (e.g. "5+0"). */
export const timeControlLabel = (tc: TimeControl): string => (tc === 'untimed' ? 'Untimed' : tc)

/**
 * Parse a real (non-'untimed') time control into { baseMs, incMs } — used to
 * size the Clock component's progress bar. Mirrors BotGame::parseTimeControl()
 * on the server, which is the actual source of truth for the clock; this is
 * display-only. Returns null for 'untimed'.
 */
export function parseTimeControl(tc: TimeControl): { baseMs: number; incMs: number } | null {
    if (tc === 'untimed') return null
    const [base, inc] = tc.split('+').map(Number)
    return { baseMs: base * 60_000, incMs: inc * 1000 }
}

const KEY = 'botgame:settings'
const RATING_MIN = 700
// Full engine strength — the engine's own ceiling (~3500 CCRL; zugzwang RatingMax).
// The engine owns the rating→strength curve; the top notch plays at full strength.
const RATING_MAX = 3500

/** Full engine strength, exported so the handicap modes (fading, glassjaw) can
 *  show how far below their starting ceiling they've fallen. Mirrors
 *  BotGameService::RATING_MAX. */
export const FULL_STRENGTH_RATING = RATING_MAX
const VARIANTS: readonly Variant[] = [
    'standard',
    'chess960',
    'duck',
    'crazyhouse',
    'antichess',
    'fading',
    'glassjaw',
    'doublemove',
]
const COLORS: readonly ColorChoice[] = ['w', 'b', 'random']

/**
 * The "Unlosable" bot's stored rating — a sentinel, deliberately NOT a real Elo
 * (0 is unambiguously below every rating, so it can never be reordered by, or
 * collide with, a future low-rated bot). It selects Standard rules with the engine
 * playing the WORST move it can find. The rating slider surfaces it as its lowest
 * stop; the backend routes any rating<=0 to the worst-move engine.
 */
export const UNLOSABLE_RATING = 0

/**
 * The slider's internal coordinate for the "Unlosable" stop — one 50-step notch
 * below the real-rating floor. This is a UI PIXEL POSITION only; it is never stored
 * or sent (coordToRating maps it back to UNLOSABLE_RATING). Keeping the slot
 * adjacent to the floor avoids a dead 0..700 gap in the track.
 */
export const UNLOSABLE_SLOT = RATING_MIN - 50
export const RATING_SLIDER_MIN = UNLOSABLE_SLOT
export const RATING_SLIDER_MAX = RATING_MAX

/** Slider coordinate → stored rating: the lowest slot is the Unlosable sentinel. */
export const coordToRating = (c: number): number => (c <= UNLOSABLE_SLOT ? UNLOSABLE_RATING : c)

/** Stored rating → slider coordinate: the sentinel snaps to the lowest slot. */
export const ratingToCoord = (r: number): number => (r <= UNLOSABLE_RATING ? UNLOSABLE_SLOT : r)

/** Human-readable opponent-strength label ("Unlosable" for the sentinel, else "~N Elo"). */
export const ratingLabel = (rating: number): string =>
    rating <= UNLOSABLE_RATING ? 'Unlosable' : `~${rating} Elo`

export const DEFAULT_BOT_SETTINGS: BotSettings = {
    rating: 1500,
    colorChoice: 'w',
    variant: 'standard',
    timeControl: 'untimed',
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
                ? p.rating <= UNLOSABLE_RATING
                    ? UNLOSABLE_RATING // preserve the "Unlosable" sentinel across refreshes
                    : Math.min(RATING_MAX, Math.max(RATING_MIN, Math.round(p.rating / 50) * 50))
                : DEFAULT_BOT_SETTINGS.rating
        const variant = VARIANTS.includes(p.variant as Variant)
            ? (p.variant as Variant)
            : DEFAULT_BOT_SETTINGS.variant
        const colorChoice = COLORS.includes(p.colorChoice as ColorChoice)
            ? (p.colorChoice as ColorChoice)
            : DEFAULT_BOT_SETTINGS.colorChoice
        const timeControl = TIME_CONTROLS.includes(p.timeControl as TimeControl)
            ? (p.timeControl as TimeControl)
            : DEFAULT_BOT_SETTINGS.timeControl
        return { rating, colorChoice, variant, timeControl }
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
