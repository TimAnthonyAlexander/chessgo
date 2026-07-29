import { useEffect, useState } from 'react'
import { Box } from '@mui/material'
import { useSetting, type ClockTenths } from '../lib/settings'

interface ClockProps {
    /** Reads the live remaining ms (recomputed against `Date.now()` on each call).
     *  Its identity changes when the game state advances, snapping the display to
     *  the authoritative time. */
    getMs: () => number
    /** This side is to move — running visual + self-ticking countdown. */
    active: boolean
    /** Clocks are actually live (game not over and both openers have moved). When
     *  false the countdown holds — no interval is armed. */
    running?: boolean
    /** The time control's initial time for this side, in ms — the denominator for
     * the `clockBar` progress bar. Optional: omit when it isn't known (untimed
     * games) and the bar simply doesn't render, rather than guessing. */
    initialMs?: number
}

// Escalating urgency tiers — ONE hue per tier, applied to BOTH the text and the
// border so the low-time signal reads as a single language: normal (accent), under
// 30s amber, under 10s red. The CSS tokens (--warn / --danger) are the source of
// truth; the literals are a self-sufficient fallback so the tiers work regardless
// of stylesheet load order.
const WARN_MS = 30_000
const DANGER_MS = 10_000
const HUE_NORMAL = 'var(--accent)'
const HUE_WARN = 'var(--warn, #e9c46a)'
const HUE_DANGER = 'var(--danger, #e07a5f)'

function hueFor(ms: number): string {
    return ms < DANGER_MS ? HUE_DANGER : ms < WARN_MS ? HUE_WARN : HUE_NORMAL
}

/** Snap to the authoritative time, then self-tick only while this side is actually
 *  running (the idle side's remaining is static, so it needs no interval). Shared by
 *  the digits and the bar so each stays a leaf that re-renders on its own. */
function useRemainingMs(getMs: () => number, active: boolean, running: boolean): number {
    const [ms, setMs] = useState(() => getMs())
    useEffect(() => {
        setMs(getMs())
        if (!active || !running) return
        const id = window.setInterval(() => setMs(getMs()), 200)
        return () => window.clearInterval(id)
    }, [getMs, active, running])
    return ms
}

function format(ms: number, tenths: ClockTenths): string {
    const total = Math.max(0, Math.ceil(ms / 100) / 10) // tenths
    const mins = Math.floor(total / 60)
    const secs = total - mins * 60
    // 'lowtime' (default): tenths only under 10s in the final minute — the
    // original hardcoded behavior. 'always'/'never' override that gate
    // outright; either way the minutes:seconds fallback is unchanged.
    const showTenths =
        tenths === 'always' ? true : tenths === 'never' ? false : mins === 0 && ms < 10_000
    if (showTenths) return secs.toFixed(1)
    return `${mins}:${Math.floor(secs).toString().padStart(2, '0')}`
}

/**
 * A chess clock cell: monospace time, brightened + accented when running.
 *
 * The countdown ticks INSIDE this leaf (its own 200ms interval) so a running clock
 * never re-renders the surrounding page — only these digits update. The page passes
 * `getMs`, a closure over the authoritative remaining time; when the game advances
 * the closure's identity changes and the display snaps to truth.
 */
export default function Clock({ getMs, active, running = true }: ClockProps) {
    // Single-key subscription (not usePrefs()): only re-renders when this one
    // setting changes (rare, user-driven), so it adds nothing beyond the tick
    // interval, which already re-renders this leaf every 200ms while running.
    const clockTenths = useSetting('clockTenths')
    const ms = useRemainingMs(getMs, active, running)
    const hue = hueFor(ms)

    return (
        <Box
            sx={{
                fontFamily: 'var(--font-mono)',
                fontSize: 26,
                fontWeight: 600,
                letterSpacing: '0.02em',
                px: 1.75,
                py: 0.75,
                borderRadius: 1.5,
                minWidth: 96,
                textAlign: 'center',
                color: active ? hue : 'var(--text-dim)',
                bgcolor: active ? 'var(--surface-2)' : 'transparent',
                border: '1px solid',
                borderColor: active ? hue : 'transparent',
                transition: 'color 0.15s ease, background 0.15s ease, border-color 0.15s ease',
            }}
        >
            {format(ms, clockTenths)}
        </Box>
    )
}

/**
 * The `clockBar` strip: remaining time as a proportion of the time control's
 * initial time.
 *
 * Deliberately a SEPARATE leaf from `Clock` rather than a child of it, because it
 * spans the full width of the player row while the digits sit right-aligned within
 * it. Render it inside a `position: relative` container and it draws edge to edge
 * along that container's bottom. Ticking here (not in the row) keeps the 200ms
 * update from re-rendering the surrounding page, exactly as `Clock` does.
 *
 * Renders nothing when the pref is off or `initialMs` is unknown — degrading to no
 * bar rather than a guessed denominator.
 */
export function ClockBar({ getMs, active, running = true, initialMs }: ClockProps) {
    const clockBar = useSetting('clockBar')
    const ms = useRemainingMs(getMs, active, running)
    if (!clockBar || !initialMs || initialMs <= 0) return null

    const pct = Math.min(1, Math.max(0, ms / initialMs))
    // Pulse only while this side is genuinely counting down. A still bar therefore
    // means "not your clock", which makes the animation informative rather than
    // ornamental — and it stops the moment the game does.
    const ticking = active && running
    return (
        <Box
            aria-hidden
            className={ticking ? 'clock-bar-pulse' : undefined}
            sx={{
                position: 'absolute',
                left: 0,
                bottom: 0,
                height: '3px',
                width: `${pct * 100}%`,
                bgcolor: hueFor(ms),
                opacity: active ? 1 : 0.35,
                transition: 'width 0.2s linear, opacity 0.15s ease',
                animation: ticking ? 'clock-bar-pulse 1.9s ease-in-out infinite' : undefined,
                pointerEvents: 'none',
            }}
        />
    )
}
