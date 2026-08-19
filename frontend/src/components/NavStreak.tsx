import { useEffect, useState } from 'react'
import { Box, Tooltip, Typography } from '@mui/material'
import { Flame } from 'lucide-react'
import { useAuth } from '../lib/auth'
import { getStreak, type Streak } from '../api/client'

type LoadState =
    | { kind: 'loading' }
    | { kind: 'ready'; streak: Streak }
    | { kind: 'error' }

/** Compact flame + day-streak count for the top nav. Signed-in only; renders
 * nothing while auth/streak resolve or on error (the navbar must never reserve a
 * gap for a value that may never arrive). Lit once the streak is rolling, glowing
 * when today already counts — same semantics as the old hero flame. */
export default function NavStreak() {
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

    if (status !== 'ready' || !user || state.kind !== 'ready') return null

    const { current, activeToday } = state.streak
    const lit = current > 0

    return (
        <Tooltip
            title={
                activeToday
                    ? `${current}-day streak — today counts`
                    : `${current}-day streak — play today to keep it`
            }
        >
            {/* Sized to the nav's icon-button cell (see nav/IconBtn) so it lines up
                with the buttons beside it instead of sitting on its own baseline.
                It is not a button — nothing happens when you press it — so it is a
                Box, not one. */}
            <Box
                sx={{
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'center',
                    gap: 0.5,
                    flexShrink: 0,
                    height: 30,
                    px: 0.75,
                    color: lit ? 'var(--accent)' : 'var(--text-dim)',
                    // "Played today" used to be a glow around the flame. It is opacity
                    // now: full strength once today counts, half-lit while the streak is
                    // alive but today is still open. Same information, no halo.
                    opacity: lit ? (activeToday ? 1 : 0.75) : 0.6,
                }}
            >
                <Box aria-hidden sx={{ display: 'flex' }}>
                    <Flame size={16} strokeWidth={2.25} />
                </Box>
                <Typography
                    sx={{
                        fontFamily: 'var(--font-mono)',
                        fontWeight: 700,
                        fontSize: 13,
                        lineHeight: 1,
                        color: lit ? 'var(--text)' : 'var(--text-dim)',
                    }}
                >
                    {current}
                </Typography>
            </Box>
        </Tooltip>
    )
}
