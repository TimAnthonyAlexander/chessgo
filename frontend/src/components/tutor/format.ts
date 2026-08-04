// Shared formatting for Tutor's report pages — kept in one place so a "cp"
// vs "percent" vs "rating" value never renders inconsistently between the
// strengths list, the metrics table, and the trend chart.

export type TutorUnit = 'percent' | 'cp' | 'rating'

/** Render a raw metric value per its unit — the ONLY place that decides
 * "78.4%" vs "41 cp" vs "1523" so every consumer stays in sync. A rating
 * (e.g. performance rating) carries no suffix, matching how ratings render
 * everywhere else in the app (profile/shared.ts's game-delta included). */
export function fmtValue(value: number, unit: TutorUnit): string {
    if (unit === 'percent') return `${value.toFixed(1)}%`
    if (unit === 'rating') return `${Math.round(value)}`
    return `${Math.round(value)} cp`
}

/** Signed delta for the trend page — "+4.2%" / "-12 cp" / "+42". */
export function fmtDelta(delta: number, unit: TutorUnit): string {
    const sign = delta > 0 ? '+' : ''
    if (unit === 'percent') return `${sign}${delta.toFixed(1)}%`
    if (unit === 'rating') return `${sign}${Math.round(delta)}`
    return `${sign}${Math.round(delta)} cp`
}

/** "Jan 3, 2026" — nullable, matching the rest of the app's date rendering. */
export function fmtDate(iso: string | null | undefined): string {
    if (!iso) return ''
    const d = new Date(iso)
    if (Number.isNaN(d.getTime())) return ''
    return d.toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' })
}

/** "bullet" -> "Bullet". Category/dimension keys arrive lowercase from the API. */
export function cap(s: string): string {
    return s.length ? s[0].toUpperCase() + s.slice(1) : s
}

/** "hangingPiece" -> "Hanging piece", "rookEndgame" -> "Rook endgame". Puzzle
 * theme tags arrive camelCase from the API; this is the one place that turns
 * them into a readable label so it never renders inconsistently between the
 * report's theme table and a puzzle-page filter chip. */
export function themeLabel(tag: string): string {
    const spaced = tag.replace(/([a-z0-9])([A-Z])/g, '$1 $2').toLowerCase()
    return spaced.length ? spaced[0].toUpperCase() + spaced.slice(1) : spaced
}
