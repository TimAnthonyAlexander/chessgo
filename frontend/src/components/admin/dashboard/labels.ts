import type { AdminDashboard, FlagStatus } from '../../../api/client'

/** Human-readable names for the anti-cheat detection signals, keyed by the exact
 * `events_by_category` keys the backend emits (the CAT_* vocabulary). */
export const CATEGORY_LABELS: Record<
    keyof AdminDashboard['anticheat']['events_by_category'],
    string
> = {
    analysis_during_game: 'Analysis during game',
    rating_velocity: 'Rating velocity',
    move_time_anomaly: 'Move-time anomaly',
    engine_correlation: 'Engine correlation',
    accuracy_rating_mismatch: 'Accuracy/rating mismatch',
}

/** Display labels + accent colors for the four anti-cheat verdict statuses. */
export const STATUS_META: Record<FlagStatus, { label: string; color: string }> = {
    open: { label: 'Open', color: '#ca4a4a' },
    reviewing: { label: 'Reviewing', color: 'var(--accent)' },
    cleared: { label: 'Cleared', color: '#5b9e5b' },
    banned: { label: 'Banned', color: '#6c6f7d' },
}

/** The verdict statuses in a stable review-lifecycle order. */
export const STATUS_ORDER: FlagStatus[] = ['open', 'reviewing', 'cleared', 'banned']
