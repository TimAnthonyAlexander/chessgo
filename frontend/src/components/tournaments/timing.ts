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
