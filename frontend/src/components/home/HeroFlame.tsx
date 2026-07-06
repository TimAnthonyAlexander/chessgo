import { type ReactNode, useEffect, useState } from 'react'
import { Box, Typography } from '@mui/material'
import { Flame } from 'lucide-react'
import { useAuth } from '../../lib/auth'
import { getStreak, type Streak } from '../../api/client'

type LoadState =
    | { kind: 'loading' }
    | { kind: 'ready'; streak: Streak }
    | { kind: 'error' }

/** The hero headline. A signed-in player sees a compact flame + streak count (dim
 * at 0, lit once it's rolling); a confirmed guest sees the plain "Your move."
 * A day counts by solving a puzzle or playing a rated game (StreakService).
 *
 * "Your move." is shown ONLY once auth has resolved to no user — never while the
 * session or the streak is still loading, so a signed-in player never flashes the
 * guest headline before their flame appears. Undetermined states render a neutral
 * fixed-height slot (no layout shift). */
export default function HeroFlame() {
    const { user, status } = useAuth()
    const [state, setState] = useState<LoadState>({ kind: 'loading' })

    useEffect(() => {
        if (status !== 'ready' || !user) return

        let cancelled = false
        setState({ kind: 'loading' })
        getStreak()
            .then((streak) => {
                if (!cancelled) setState({ kind: 'ready', streak })
            })
            .catch(() => {
                if (!cancelled) setState({ kind: 'error' })
            })
        return () => {
            cancelled = true
        }
    }, [user, status])

    // Session not yet resolved: hold a neutral slot rather than guessing.
    if (status !== 'ready') return <Slot />

    // Confirmed anonymous — now (and only now) the guest headline is correct.
    if (!user) return <Headline>Your move.</Headline>

    // Signed in but the streak hasn't loaded (or failed): a neutral slot, never
    // the guest headline.
    if (state.kind !== 'ready') return <Slot />

    const { current, activeToday } = state.streak
    const lit = current > 0

    return (
        <Box sx={{ display: 'flex', alignItems: 'center', gap: 1.5, minWidth: 0 }}>
            <Box
                aria-hidden
                sx={{
                    display: 'flex',
                    flexShrink: 0,
                    color: lit ? 'var(--accent)' : 'var(--text-dim)',
                    opacity: lit ? 1 : 0.6,
                    filter: activeToday ? 'drop-shadow(0 0 10px rgba(255, 138, 40, 0.45))' : 'none',
                }}
            >
                <Flame size={38} strokeWidth={2} />
            </Box>
            <Typography
                sx={{
                    fontFamily: 'var(--font-display)',
                    fontWeight: 700,
                    fontSize: { xs: 34, md: 46 },
                    lineHeight: 1.04,
                    letterSpacing: '-0.02em',
                    color: lit ? 'var(--text)' : 'var(--text-dim)',
                }}
            >
                {current}
            </Typography>
        </Box>
    )
}

/** A neutral placeholder that reserves the hero headline's height while auth or the
 * streak is still resolving — keeps the row from jumping when the flame lands. */
function Slot() {
    return <Box aria-hidden sx={{ minWidth: 0, height: { xs: 38, md: 48 } }} />
}

function Headline({ children }: { children: ReactNode }) {
    return (
        <Box sx={{ minWidth: 0 }}>
            <Typography
                sx={{
                    fontFamily: 'var(--font-display)',
                    fontWeight: 700,
                    fontSize: { xs: 34, md: 46 },
                    lineHeight: 1.04,
                    letterSpacing: '-0.02em',
                }}
            >
                {children}
            </Typography>
        </Box>
    )
}
