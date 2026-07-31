// Shared timing helpers for the tournament list + detail pages: a ticking
// "now" clock plus the text each of them derives from it ("Starts in 2h 14m",
// "Ends in 12m", "Finished 3h ago").
import { useEffect, useState } from 'react'
import type { TournamentSummary } from '../../api/client'

/** A ticking `now` (ms), re-rendering the caller every `intervalMs`. One
 * interval shared by every row on a page, rather than each row running its
 * own timer. */
export function useNow(intervalMs = 1000): number {
    const [now, setNow] = useState(() => Date.now())
    useEffect(() => {
        const id = window.setInterval(() => setNow(Date.now()), intervalMs)
        return () => window.clearInterval(id)
    }, [intervalMs])
    return now
}

/** The backend stores `starts_at` as a "Y-m-d H:i:s" string in UTC (see
 * Tournament::$starts_at's docblock) — parse it as UTC explicitly so the
 * countdown is correct regardless of the browser's own timezone. */
export function parseStartsAt(startsAt: string): number {
    return Date.parse(`${startsAt.replace(' ', 'T')}Z`)
}

/** "2h 14m", "45s", "3d 6h" — at most two units, dropping to seconds only
 * under a minute. Never negative. */
export function formatDuration(ms: number): string {
    const total = Math.max(0, Math.round(ms / 1000))
    const d = Math.floor(total / 86400)
    const h = Math.floor((total % 86400) / 3600)
    const m = Math.floor((total % 3600) / 60)
    const s = total % 60
    if (d > 0) return `${d}d ${h}h`
    if (h > 0) return `${h}h ${m}m`
    if (m > 0) return `${m}m ${s}s`
    return `${s}s`
}

/** A one-line state readout for a tournament row or header, driven by a
 * ticking `now` so it stays live without a refetch. */
export function timingText(t: TournamentSummary, now: number): string {
    if (t.status === 'scheduled') {
        const startsAt = parseStartsAt(t.starts_at)
        return startsAt <= now ? 'Starting…' : `Starts in ${formatDuration(startsAt - now)}`
    }
    if (t.status === 'running') {
        return t.ends_at_ms <= now ? 'Ending…' : `Ends in ${formatDuration(t.ends_at_ms - now)}`
    }
    return `Finished ${formatDuration(now - t.ends_at_ms)} ago`
}

/** Local wall-clock time, always 24-hour ("16:00") regardless of locale — the
 * timeline axis's hour labels and a block's hover tooltip. */
export function hhmm(ms: number): string {
    return new Date(ms).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit', hour12: false })
}

/** "30m", "1h", "1h30m" — a tournament's fixed duration, distinct from
 * {@link formatDuration} (which formats a live countdown, not a flat span). */
export function formatMinutes(totalMinutes: number): string {
    if (totalMinutes < 60) return `${totalMinutes}m`
    const h = Math.floor(totalMinutes / 60)
    const m = totalMinutes % 60
    return m > 0 ? `${h}h${m}m` : `${h}h`
}

/** Lichess-style speed class from a "base+inc" pool string (base minutes,
 * increment seconds), by estimated total game length — `base*60 + inc*40`
 * seconds — the same formula Lichess uses to bucket clocks. */
export type Speed = 'bullet' | 'blitz' | 'rapid' | 'classical'

export const SPEED_LABEL: Record<Speed, string> = {
    bullet: 'Bullet',
    blitz: 'Blitz',
    rapid: 'Rapid',
    classical: 'Classical',
}

export function poolSpeed(pool: string): Speed {
    const m = pool.match(/^(\d+)\+(\d+)$/)
    const base = m ? Number(m[1]) : 3
    const inc = m ? Number(m[2]) : 0
    const estimateSeconds = base * 60 + inc * 40
    if (estimateSeconds < 180) return 'bullet'
    if (estimateSeconds < 480) return 'blitz'
    if (estimateSeconds < 1500) return 'rapid'
    return 'classical'
}

/** Plain-language restriction line for a row — "Titled only", "2000+",
 * "Titled only · Under 1200" — or null when the arena is open to everyone. */
export function restrictionText(t: TournamentSummary): string | null {
    const parts: string[] = []
    if (t.titled_only) parts.push('Titled only')
    if (t.min_rating != null && t.max_rating != null) parts.push(`${t.min_rating}–${t.max_rating}`)
    else if (t.min_rating != null) parts.push(`${t.min_rating}+`)
    else if (t.max_rating != null) parts.push(`Under ${t.max_rating}`)
    return parts.length > 0 ? parts.join(' · ') : null
}
