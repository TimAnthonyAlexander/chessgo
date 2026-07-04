// Shared profile helpers: result perspective, date formatting, per-category
// rating series (for the hero sparkline), and identity monograms. Kept
// framework-free so every profile widget composes on the same primitives.
import type { Profile, ProfileGame, RatingCategory } from '../../api/client'
import { CATEGORY_META, type Category } from '../../lib/timeControl'

export type Outcome = 'win' | 'loss' | 'draw'

export const OUTCOME_STYLE: Record<Outcome, { label: string; color: string }> = {
    win: { label: 'W', color: '#5b9e5b' },
    loss: { label: 'L', color: '#ca4a4a' },
    draw: { label: 'D', color: 'var(--text-dim)' },
}

// The four time-control categories, paired with the display label the rest of
// the app uses (so we can pull icon + accent colour from CATEGORY_META).
export const TC_CATEGORIES: { key: RatingCategory; label: Category }[] = [
    { key: 'bullet', label: 'Bullet' },
    { key: 'blitz', label: 'Blitz' },
    { key: 'rapid', label: 'Rapid' },
    { key: 'classical', label: 'Classical' },
]

export interface Perspective {
    outcome: Outcome
    color: 'White' | 'Black'
    opponent: string
    opponentBot: boolean
    delta: number | null
    ratingAfter: number | null
}

// The game result from the profiled player's own perspective + their rating
// swing (only meaningful on rated games, where before/after are populated).
export function perspective(g: ProfileGame, userId: string): Perspective {
    const isWhite = g.white_user_id === userId
    const color = isWhite ? 'White' : 'Black'
    const opponent = isWhite ? g.black_name : g.white_name
    const opponentBot = isWhite ? g.black_is_bot : g.white_is_bot

    let outcome: Outcome = 'draw'
    if (g.result === '1-0') outcome = isWhite ? 'win' : 'loss'
    else if (g.result === '0-1') outcome = isWhite ? 'loss' : 'win'

    const before = isWhite ? g.white_rating_before : g.black_rating_before
    const after = isWhite ? g.white_rating_after : g.black_rating_after
    const delta = before != null && after != null ? after - before : null

    return { outcome, color, opponent, opponentBot, delta, ratingAfter: after }
}

export function fmtDate(iso: string): string {
    const d = new Date(iso)
    if (Number.isNaN(d.getTime())) return ''
    return d.toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' })
}

// A coarse "last active" label for the identity hero, derived from the most
// recent game's date. Falls back to the absolute date beyond a month.
export function fmtRelative(iso: string): string {
    const d = new Date(iso)
    if (Number.isNaN(d.getTime())) return ''
    const day = 86_400_000
    const diff = Date.now() - d.getTime()
    if (diff < 0) return 'just now'
    if (diff < day) return 'today'
    if (diff < 2 * day) return 'yesterday'
    if (diff < 7 * day) return `${Math.floor(diff / day)} days ago`
    if (diff < 30 * day) return `${Math.floor(diff / (7 * day))}w ago`
    return fmtDate(iso)
}

// Per-category rating progression, oldest → newest, reconstructed from each
// rated game's post-game rating. Feeds the hero sparkline; no backend change.
export function ratingSeries(games: ProfileGame[], userId: string): Record<string, number[]> {
    const out: Record<string, number[]> = {}
    // `games` arrives newest-first; walk it backwards for chronological order.
    for (let i = games.length - 1; i >= 0; i--) {
        const g = games[i]
        if (!g.rated || g.variant !== 'standard') continue
        const { ratingAfter } = perspective(g, userId)
        if (ratingAfter == null) continue
        const cat = g.category || ''
        ;(out[cat] ??= []).push(ratingAfter)
    }
    return out
}

export interface PrimaryRating {
    key: RatingCategory
    label: Category
    color: string
    rating: number
    provisional: boolean
    games: number
    series: number[]
    delta: number | null
}

// The player's "headline" rating: the most-played time control. Drives the big
// call-out in the hero. Returns null only if the profile has no ratings at all.
export function primaryRating(
    profile: Profile,
    series: Record<string, number[]>,
): PrimaryRating | null {
    let best: { key: RatingCategory; label: Category } | null = null
    let bestGames = -1
    for (const c of TC_CATEGORIES) {
        const g = profile.ratings[c.key].games
        if (g > bestGames) {
            bestGames = g
            best = c
        }
    }
    if (!best) return null

    const tile = profile.ratings[best.key]
    const s = series[best.key] ?? []
    // Trend over at most the last ~16 rated games in this category.
    const window = s.slice(-16)
    const delta = window.length >= 2 ? window[window.length - 1] - window[0] : null

    return {
        key: best.key,
        label: best.label,
        color: CATEGORY_META[best.label].color,
        rating: tile.rating,
        provisional: tile.provisional,
        games: tile.games,
        series: window,
        delta,
    }
}

const MONO_COLORS = ['#5e84c0', '#6f9e54', '#d8a657', '#e0844a', '#b06fb0', '#4aa7a0']

// Deterministic accent colour for a name's monogram avatar (stable per player).
export function monogramColor(name: string): string {
    let h = 0
    for (let i = 0; i < name.length; i++) h = (h * 31 + name.charCodeAt(i)) >>> 0
    return MONO_COLORS[h % MONO_COLORS.length]
}

export function initials(name: string): string {
    const parts = name.trim().split(/\s+/).filter(Boolean)
    if (parts.length >= 2) return (parts[0][0] + parts[1][0]).toUpperCase()
    return name.slice(0, 2).toUpperCase()
}
