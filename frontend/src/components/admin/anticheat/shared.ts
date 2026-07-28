// Shared anti-cheat display helpers: severity vocabulary, per-signal category
// metadata (label + icon + accent), move-judgment styling, and safe accessors
// for the untyped `FlagEvent.meta` bag. Kept framework-free so every anti-cheat
// widget composes on the same primitives (mirrors profile/shared.ts).
import type { LucideIcon } from 'lucide-react'
import { Cpu, ScanEye, Target, Timer, TrendingUp } from 'lucide-react'
import type { AnalysisJudgment, FlagSeverity } from '../../../api/client'
import { CATEGORY_LABELS } from '../dashboard/labels'

export type Category = keyof typeof CATEGORY_LABELS

/** The five detection signals, in a stable display order. */
export const CATEGORIES: Category[] = [
    'analysis_during_game',
    'engine_correlation',
    'accuracy_rating_mismatch',
    'move_time_anomaly',
    'rating_velocity',
]

/** Per-severity display: label + accent colour. (Severity sorting is server-side,
 * so the client keeps no numeric rank.) */
export const SEVERITY_META: Record<FlagSeverity, { label: string; color: string }> = {
    low: { label: 'Low', color: '#6c8fb0' },
    medium: { label: 'Medium', color: '#e0a33e' },
    high: { label: 'High', color: '#ca4a4a' },
}

/** Per-signal icon + accent, so a category reads at a glance across the surfaces. */
export const CATEGORY_META: Record<Category, { icon: LucideIcon; color: string }> = {
    analysis_during_game: { icon: ScanEye, color: '#ca4a4a' },
    engine_correlation: { icon: Cpu, color: '#c77dcf' },
    accuracy_rating_mismatch: { icon: Target, color: '#5b9ed0' },
    move_time_anomaly: { icon: Timer, color: '#e0a33e' },
    rating_velocity: { icon: TrendingUp, color: '#5b9e5b' },
}

/** The friendly label for any category key (falls back to the raw key). */
export function categoryLabel(key: string): string {
    return (CATEGORY_LABELS as Record<string, string>)[key] ?? key
}

// --- Move-judgment styling (mirrors MoveTree's palette so review reads the same). ---

export type Judgment = AnalysisJudgment

export const JUDGMENT_COLOR: Record<Judgment, string> = {
    best: 'var(--text)',
    good: 'var(--text)',
    inaccuracy: '#e0a33e',
    mistake: '#e08a3e',
    blunder: '#ca4a4a',
}

export const JUDGMENT_GLYPH: Record<Judgment, string> = {
    best: '',
    good: '',
    inaccuracy: '?!',
    mistake: '?',
    blunder: '??',
}

// --- Safe accessors for the untyped meta bag (Record<string, unknown>). ---

/** A string meta value, or null when absent / not a string. */
export function metaStr(meta: Record<string, unknown>, key: string): string | null {
    const v = meta[key]
    return typeof v === 'string' ? v : null
}

/** A finite numeric meta value, or null. Accepts a numeric string too (the
 * backend occasionally serialises numbers as JSON strings). */
export function metaNum(meta: Record<string, unknown>, key: string): number | null {
    const v = meta[key]
    if (typeof v === 'number' && Number.isFinite(v)) return v
    if (typeof v === 'string' && v.trim() !== '') {
        const n = Number(v)
        if (Number.isFinite(n)) return n
    }
    return null
}

/** A boolean meta value, or null. Accepts 1/0 and "true"/"false" too. */
export function metaBool(meta: Record<string, unknown>, key: string): boolean | null {
    const v = meta[key]
    if (typeof v === 'boolean') return v
    if (typeof v === 'number') return v !== 0
    if (typeof v === 'string') {
        if (v === 'true' || v === '1') return true
        if (v === 'false' || v === '0') return false
    }
    return null
}

/** The hub game id a flag is tied to (`meta.game_id`), as a string, or null.
 * Four of the five signals carry it; `analysis_during_game` does not. */
export function metaGameId(meta: Record<string, unknown>): string | null {
    const v = meta.game_id
    if (typeof v === 'string' && v.trim() !== '') return v
    if (typeof v === 'number' && Number.isFinite(v)) return String(v)
    return null
}

// --- Formatting ---

/** Compact number: keeps up to `d` decimals, trims trailing zeros. */
export function fmtNum(n: number | null, d = 1): string {
    if (n == null) return '—'
    return Number(n.toFixed(d)).toString()
}

/** Percent from a 0..1 or 0..100 value — pass the raw meta number and a hint. */
export function fmtPct(n: number | null): string {
    if (n == null) return '—'
    const pct = n <= 1 ? n * 100 : n
    return `${Number(pct.toFixed(1))}%`
}

/** Milliseconds → a short "1.4s" / "820ms" label. */
export function fmtMs(ms: number | null): string {
    if (ms == null) return '—'
    if (ms >= 1000) return `${Number((ms / 1000).toFixed(2))}s`
    return `${Math.round(ms)}ms`
}
