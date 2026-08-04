// Shared formatting for Tutor's report pages — kept in one place so a "cp"
// vs "percent" value never renders inconsistently between the strengths list,
// the metrics table, and the trend chart.

/** Render a raw metric value per its unit — the ONLY place that decides
 * "78.4%" vs "41 cp" so every consumer stays in sync. */
export function fmtValue(value: number, unit: 'percent' | 'cp'): string {
    if (unit === 'percent') return `${value.toFixed(1)}%`
    return `${Math.round(value)} cp`
}

/** Signed delta for the trend page — "+4.2%" / "-12 cp". */
export function fmtDelta(delta: number, unit: 'percent' | 'cp'): string {
    const sign = delta > 0 ? '+' : ''
    if (unit === 'percent') return `${sign}${delta.toFixed(1)}%`
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
