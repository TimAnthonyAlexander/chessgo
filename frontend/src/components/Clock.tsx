import { useEffect, useState } from 'react'
import { Box } from '@mui/material'

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

function format(ms: number): string {
    const total = Math.max(0, Math.ceil(ms / 100) / 10) // tenths
    const mins = Math.floor(total / 60)
    const secs = total - mins * 60
    if (mins === 0 && ms < 10_000) {
        // Under 10s: show tenths (e.g. 7.3)
        return secs.toFixed(1)
    }
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
    const [ms, setMs] = useState(() => getMs())

    // Snap to the authoritative time whenever the inputs change (a move landed →
    // fresh `getMs`), then self-tick only while this side is actually running (the
    // idle side's remaining is static, so it needs no interval).
    useEffect(() => {
        setMs(getMs())
        if (!active || !running) return
        const id = window.setInterval(() => setMs(getMs()), 200)
        return () => window.clearInterval(id)
    }, [getMs, active, running])

    const hue = ms < DANGER_MS ? HUE_DANGER : ms < WARN_MS ? HUE_WARN : HUE_NORMAL

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
            {format(ms)}
        </Box>
    )
}
