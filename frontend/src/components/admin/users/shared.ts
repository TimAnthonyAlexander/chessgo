// Shared config + helpers for the admin Users tab. Kept framework-free so every
// widget (list + detail) composes on the same primitives, mirroring the
// profile/shared decomposition.
import type {
    AdminUserRow,
    AdminUserRecord,
    AdminUserSort,
    GameSummaryRow,
} from '../../../api/client'
import { CATEGORY_META, type Category } from '../../../lib/timeControl'

/** The four time-control rating columns, paired with the sort key the backend
 * whitelists and the display metadata (icon + accent) the rest of the app uses. */
export const RATING_COLS: {
    key: 'bullet' | 'blitz' | 'rapid' | 'classical'
    label: Category
    sort: AdminUserSort
    color: string
}[] = [
    { key: 'bullet', label: 'Bullet', sort: 'rating_bullet', color: CATEGORY_META.Bullet.color },
    { key: 'blitz', label: 'Blitz', sort: 'rating_blitz', color: CATEGORY_META.Blitz.color },
    { key: 'rapid', label: 'Rapid', sort: 'rating_rapid', color: CATEGORY_META.Rapid.color },
    {
        key: 'classical',
        label: 'Classical',
        sort: 'rating_classical',
        color: CATEGORY_META.Classical.color,
    },
]

/** Pull a row's rating for a time-control column (typed access, no `any`). */
export function ratingOf(row: AdminUserRow, key: RATING_COL_KEY): number {
    return row[`rating_${key}` as const]
}

/** Pull a row's game count for a time-control column. */
export function gamesOf(row: AdminUserRow, key: RATING_COL_KEY): number {
    return row[`games_${key}` as const]
}

export type RATING_COL_KEY = 'bullet' | 'blitz' | 'rapid' | 'classical'

/** The detail record exposes the same per-category rating/games columns as the
 * row, plus a `provisional` map keyed by category. */
export function recordRating(rec: AdminUserRecord, key: RATING_COL_KEY): number {
    return rec[`rating_${key}` as const]
}
export function recordGames(rec: AdminUserRecord, key: RATING_COL_KEY): number {
    return rec[`games_${key}` as const]
}

/** Short absolute date (e.g. "Jul 6, 2026"). Empty on an unparseable value. */
export function fmtDate(iso: string): string {
    const d = new Date(iso)
    if (Number.isNaN(d.getTime())) return ''
    return d.toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' })
}

/** Coarse relative label ("today", "3 days ago", …) falling back to the date. */
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
    if (diff < 365 * day) return `${Math.floor(diff / (30 * day))}mo ago`
    return `${Math.floor(diff / (365 * day))}y ago`
}

/** Result of a recent game from the viewed account's perspective. */
export type Outcome = 'win' | 'loss' | 'draw'

export const OUTCOME_STYLE: Record<Outcome, { label: string; color: string }> = {
    win: { label: 'W', color: '#5b9e5b' },
    loss: { label: 'L', color: '#ca4a4a' },
    draw: { label: 'D', color: 'var(--text-dim)' },
}

export interface GamePerspective {
    outcome: Outcome
    color: 'White' | 'Black'
    opponent: string
    opponentBot: boolean
}

/** A recent game seen from `userId`'s side (opponent + own-result). */
export function gamePerspective(g: GameSummaryRow, userId: string): GamePerspective {
    const isWhite = g.white_user_id === userId
    const color: 'White' | 'Black' = isWhite ? 'White' : 'Black'
    const opponent = isWhite ? g.black_name : g.white_name
    const opponentBot = isWhite ? g.black_is_bot : g.white_is_bot

    let outcome: Outcome = 'draw'
    if (g.result === '1-0') outcome = isWhite ? 'win' : 'loss'
    else if (g.result === '0-1') outcome = isWhite ? 'loss' : 'win'

    return { outcome, color, opponent, opponentBot }
}
