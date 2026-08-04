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

/** "hangingPiece" -> "Hanging piece", "rookEndgame" -> "Rook endgame",
 * "mateIn1" -> "Mate in 1". Puzzle theme tags arrive camelCase from the API;
 * this is the one place that turns them into a readable label so it never
 * renders inconsistently between the report's theme table and a puzzle-page
 * filter chip.
 *
 * Two boundaries, not one: lowercase->uppercase AND letter->digit. Only the
 * first was handled, so every "mateInN" tag rendered as "Mate in1". */
export function themeLabel(tag: string): string {
    const spaced = tag
        .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
        .replace(/([a-zA-Z])(\d)/g, '$1 $2')
        .toLowerCase()
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

/**
 * Sample size at which a figure is drawn at full strength. Between THIN_SAMPLE
 * and here, confidence ramps continuously rather than snapping.
 */
export const FULL_SAMPLE = 40

/**
 * How strongly to draw a figure, 0.35–1, from the number of games behind it.
 * A step function at THIN_SAMPLE rendered a 16-game row and a 110-game row
 * identically — the same "confident number from a thin sample" problem one
 * threshold up. sqrt, because evidence accumulates with the square root of the
 * sample and the eye should see that curve, not a cliff.
 */
export function confidence(sample: number): number {
    if (!Number.isFinite(sample) || sample <= 0) return 0.35
    return Math.min(1, Math.max(0.35, Math.sqrt(sample / FULL_SAMPLE)))
}

/**
 * The signed distance from the band, in the metric's own unit — "+4.9 pts",
 * "-19 cp", "+172". This is what rows print instead of restating the peer
 * value: the peer figure is near-identical down a column (it's the same band)
 * while the gap is the thing that actually varies row to row, and it is the
 * number the meter is drawing. Percentage-point gaps say "pts", never "%",
 * because a gap between two percentages is not itself a percentage.
 */
export function fmtGap(mine: number, peer: number, unit: TutorUnit): string {
    const d = mine - peer
    const sign = d > 0 ? '+' : d < 0 ? '-' : '±'
    const mag = Math.abs(d)
    if (unit === 'percent') return `${sign}${mag.toFixed(1)} pts`
    if (unit === 'rating') return `${sign}${Math.round(mag)}`
    return `${sign}${Math.round(mag)} cp`
}

/**
 * The grade at which the meter runs out of track. The backend clamps `grade`
 * to [-1, 1], so a row at the rail is "at least this far from the band" and
 * not "exactly this far" — the meter draws a caret at the end to say so, and
 * the printed gap carries the real magnitude.
 */
export function isSaturated(grade: number | null): boolean {
    return grade !== null && Math.abs(grade) >= 1
}

/** Where the linear part of the meter ends — the point the backend calls
 * "much better/worse". Rows inside it are drawn strictly proportionally. */
const MUCH_MARK = 0.72

/**
 * How far along the meter a comparison sits, in [-1, 1].
 *
 * `grade` is a VERDICT: the backend clamps it to ±1 so that "much better"
 * means one thing, and on real reports 46% of rows sat exactly at that clamp.
 * Drawn directly, that made the single largest visual element on the page
 * encode nothing — a third of the bars were the same bar. `spread` is the same
 * ratio BEFORE clamping, so it still separates the rows the grade has flattened
 * together.
 *
 * The mapping is deliberately linear up to the "much" line, where most rows
 * live, so the bar can be read proportionally and the scale can be stated in
 * one sentence. Past that line it compresses towards the rail but never
 * reaches it, so two rows that are both off the scale still differ. Exact
 * magnitudes are never left to the bar alone — every row prints its gap.
 */
export function meterMagnitude(grade: number, spread?: number | null): number {
    const x = spread != null && Number.isFinite(spread) ? spread : grade
    if (!Number.isFinite(x)) return 0
    const mag = Math.abs(x)
    const sign = x < 0 ? -1 : 1
    if (mag <= 1) return sign * MUCH_MARK * mag
    return sign * Math.min(1, MUCH_MARK + (1 - MUCH_MARK) * (1 - 1 / mag))
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

/**
 * What each metric actually means, in one line, in the player's language.
 *
 * This is what replaced the sidebar legend. A reader who doesn't know what
 * "resourcefulness" is cannot act on being bad at it, and explaining the
 * CHART was never the missing piece — explaining the MEASURE was.
 */
const METRIC_BLURBS: Record<string, string> = {
    accuracy: 'How close your moves were to the best move available.',
    acpl: 'How much each of your moves cost you on average, in centipawns.',
    awareness: 'How often you punished your opponent for a mistake.',
    conversion: 'How often you went on to win from a winning position.',
    resourcefulness: 'How often you saved a game you were losing.',
    flagging_loss: 'How often you lost on the clock instead of on the board.',
    time_pressure: 'How much of your play happened with under a tenth of your clock left.',
    global_clock: 'How much of your clock you had left across the game.',
    clock_when_losing: 'How much clock you still had when you lost.',
    win_rate: 'Your overall score — a win counts one, a draw a half.',
    performance: 'The rating your results were worth against the players you faced.',
}

export function metricBlurb(metric: string): string | undefined {
    return METRIC_BLURBS[metric]
}

/** Which way a metric points, in words — the old table gave the reader no way
 * to know that 47 cp is good and 26% is bad. Used as the title on every
 * direction arrow and spelled out once in the reading key. */
export function directionText(higherIsBetter: boolean): string {
    return higherIsBetter ? 'Higher is better' : 'Lower is better'
}
