// Pure lane-grouping + packing logic for the timeline, kept free of React so
// it's trivially testable and reusable between the width calculation and the
// render pass.
import type { TournamentSummary } from '../../api/client'

/** The four lane groups, top to bottom. Purely a function of the tournament's
 * own fields — never of which ones happen to exist right now, so a group
 * simply renders empty (not with filler) when nothing currently matches it. */
export type LaneGroup = 'standard' | 'fast' | 'restricted' | 'variant'

export const GROUP_ORDER: LaneGroup[] = ['standard', 'fast', 'restricted', 'variant']

export const GROUP_COLOR: Record<LaneGroup, string> = {
    standard: '#629924',
    fast: '#629924',
    restricted: '#5a4fcf',
    variant: '#7d5c3f',
}

/** Lichess's own "faster than bullet" cutoff — under 30 estimated seconds
 * (`base*60 + inc*40`, same formula as {@link import('./timing').poolSpeed}).
 * Our fastest configured pool is 1+0 (60s, plain bullet), so nothing in the
 * current rota ever satisfies this — the "fast" lane is real code, just
 * currently always empty. */
function isHyperFast(pool: string): boolean {
    const m = pool.match(/^(\d+)\+(\d+)$/)
    const base = m ? Number(m[1]) : 3
    const inc = m ? Number(m[2]) : 0
    return base * 60 + inc * 40 < 30
}

function isRestricted(t: TournamentSummary): boolean {
    return t.titled_only || t.min_rating != null || t.max_rating != null
}

/** Which lane group a tournament belongs in. Restriction wins over variant —
 * Elite Weekend and Titled Tuesday are `variant: 'standard'` events that
 * happen to be rating-gated / titled-only, so they belong in the purple
 * lane, not the green one. */
export function laneGroupOf(t: TournamentSummary): LaneGroup {
    if (isRestricted(t)) return 'restricted'
    if (t.variant !== 'standard') return 'variant'
    if (isHyperFast(t.pool)) return 'fast'
    return 'standard'
}

/** "3+0" → { limit: 3, increment: 0 }. */
export function parsePool(pool: string): { limit: number; increment: number } {
    const m = pool.match(/^(\d+)\+(\d+)$/)
    return { limit: m ? Number(m[1]) : 0, increment: m ? Number(m[2]) : 0 }
}

/** Greedy first-fit lane packing: `items` must already be sorted by start
 * time. Each item goes into the first lane whose last block finishes at or
 * before this one starts; otherwise a new lane opens. */
export function packLanes<T>(items: T[], startOf: (t: T) => number, finishOf: (t: T) => number): T[][] {
    const lanes: T[][] = []
    for (const item of items) {
        const lane = lanes.find((l) => finishOf(l[l.length - 1]) <= startOf(item))
        if (lane) {
            lane.push(item)
        } else {
            lanes.push([item])
        }
    }
    return lanes
}
