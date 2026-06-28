// Shared time-control taxonomy for the homepage dashboard + lobby.
// A "pool" is a "base+inc" string in minutes+seconds, e.g. "5+3".
import type { LucideIcon } from 'lucide-react'
import { Crown, Rabbit, Timer, Zap } from 'lucide-react'

export type Category = 'Bullet' | 'Blitz' | 'Rapid' | 'Classical'

// Per-category icon + accent colour (the single source of truth the whole app
// reads — previously these literals were duplicated inline in Home/LiveModeCard).
export const CATEGORY_META: Record<Category, { color: string; Icon: LucideIcon }> = {
    Bullet: { color: '#e0844a', Icon: Rabbit },
    Blitz: { color: '#d8a657', Icon: Zap },
    Rapid: { color: '#6f9e54', Icon: Timer },
    Classical: { color: '#5e84c0', Icon: Crown },
}

/** Estimated game length in seconds (Lichess heuristic: base*60 + inc*40). */
export function estimatedSeconds(pool: string): number {
    const [baseStr, incStr] = pool.split('+')
    const base = Number(baseStr) || 0
    const inc = Number(incStr) || 0
    return base * 60 + inc * 40
}

/** Classify a "base+inc" pool into its time-control category. */
export function categoryFor(pool: string): Category {
    const est = estimatedSeconds(pool)
    if (est < 180) return 'Bullet'
    if (est < 480) return 'Blitz'
    if (est < 1500) return 'Rapid'
    return 'Classical'
}

/** The accent colour for a pool's category. */
export function categoryColor(pool: string): string {
    return CATEGORY_META[categoryFor(pool)].color
}
