// Pure lane-grouping + packing logic for the timeline, kept free of React so
// it's trivially testable and reusable between the width calculation and the
// render pass.
import type { TournamentSummary } from '../../api/client'
import { poolSpeed } from './timing'

/** The three colour groups a block renders in. Purely a function of the
 * tournament's own fields. Distinct from {@link Track}, which is the finer
 * per-row grouping used for lane layout — several tracks can share a group's
 * colour (e.g. every standard-speed track is green). */
export type LaneGroup = 'standard' | 'restricted' | 'variant'

export const GROUP_COLOR: Record<LaneGroup, string> = {
    standard: '#629924',
    restricted: '#5a4fcf',
    variant: '#7d5c3f',
}

/** One row of the timeline. Standard play gets its own track per speed so a
 * lane means "bullet" or "blitz", not an accident of scheduling; variants
 * each get their own track; restricted (titled-only / rating-gated) events
 * stay a single track regardless of speed or variant. A track with nothing
 * in the current window simply renders no rows — see {@link laneRowsFor}. */
export type Track = 'bullet' | 'blitz' | 'rapid' | 'classical' | 'restricted' | 'chess960' | 'crazyhouse' | 'duck' | 'antichess'

export const TRACK_ORDER: Track[] = [
    'bullet',
    'blitz',
    'rapid',
    'classical',
    'restricted',
    'chess960',
    'crazyhouse',
    'duck',
    'antichess',
]

export const TRACK_LABEL: Record<Track, string> = {
    bullet: 'Bullet',
    blitz: 'Blitz',
    rapid: 'Rapid',
    classical: 'Classical',
    restricted: 'Restricted',
    chess960: 'Chess960',
    crazyhouse: 'Crazyhouse',
    duck: 'Duck',
    antichess: 'Antichess',
}

export const TRACK_GROUP: Record<Track, LaneGroup> = {
    bullet: 'standard',
    blitz: 'standard',
    rapid: 'standard',
    classical: 'standard',
    restricted: 'restricted',
    chess960: 'variant',
    crazyhouse: 'variant',
    duck: 'variant',
    antichess: 'variant',
}

function isRestricted(t: TournamentSummary): boolean {
    return t.titled_only || t.min_rating != null || t.max_rating != null
}

/** Which colour group a tournament belongs in. Restriction wins over variant —
 * Elite Weekend and Titled Tuesday are `variant: 'standard'` events that
 * happen to be rating-gated / titled-only, so they render purple, not green. */
export function laneGroupOf(t: TournamentSummary): LaneGroup {
    if (isRestricted(t)) return 'restricted'
    if (t.variant !== 'standard') return 'variant'
    return 'standard'
}

/** Which row-track a tournament belongs in. Restriction wins over variant/speed
 * (same precedence as {@link laneGroupOf}) so a titled-only Chess960 arena
 * lands in the single "Restricted" track, not a "Chess960" one. */
export function trackOf(t: TournamentSummary): Track {
    if (isRestricted(t)) return 'restricted'
    if (t.variant !== 'standard') return t.variant
    return poolSpeed(t.pool)
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
