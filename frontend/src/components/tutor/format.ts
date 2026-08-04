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

/**
 * Below this many games a figure is drawn de-emphasised — faint bar, dimmed
 * value, and its sample called out in --warn. A comparison built on eight
 * games is not the same claim as one built on a hundred, and rendering the two
 * identically is exactly what a caption alone never fixed.
 */
export const THIN_SAMPLE = 12

export function isThin(sample: number): boolean {
    return sample < THIN_SAMPLE
}

/** "1 game" / "23 games". */
export function fmtGames(n: number): string {
    return `${n} ${n === 1 ? 'game' : 'games'}`
}

/** 1 -> "1st", 62 -> "62nd". Percentiles are 1–99, so the teens rule suffices. */
export function ordinal(n: number): string {
    const teens = n % 100
    if (teens >= 11 && teens <= 13) return `${n}th`
    const suffix = ['th', 'st', 'nd', 'rd'][n % 10] ?? 'th'
    return `${n}${suffix}`
}

/** "R" -> "Rook". Piece dimensions arrive as bare letters; rendering them raw
 * makes the breakdown unreadable to anyone who doesn't already speak FEN. */
const PIECE_NAMES: Record<string, string> = {
    P: 'Pawn',
    N: 'Knight',
    B: 'Bishop',
    R: 'Rook',
    Q: 'Queen',
    K: 'King',
}
export function pieceLabel(s: string): string {
    return PIECE_NAMES[s.toUpperCase()] ?? cap(s)
}

/** The backend's `wording` ("much better", "similar", …) turned into a phrase.
 * "similar" takes "to", everything else takes "than" — the one bit of grammar
 * the UI is allowed to add, and the only text it ever puts around a verdict it
 * did not compute. */
export function relToBand(wording: string): string {
    const prep = /similar/i.test(wording) ? 'to' : 'than'
    return `${wording} ${prep} your rating band`
}

/** Which way a metric points, in words — the old table gave the reader no way
 * to know that 47 cp is good and 26% is bad. Used as the title on every
 * direction arrow and spelled out once in the reading key. */
export function directionText(higherIsBetter: boolean): string {
    return higherIsBetter ? 'Higher is better' : 'Lower is better'
}
