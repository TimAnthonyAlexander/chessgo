import { useEffect, useState } from 'react'
import { Box, Typography } from '@mui/material'
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
        <Box
            title={`${current}-day streak`}
            sx={{ display: 'flex', alignItems: 'center', gap: 0.6, flexShrink: 0 }}
        >
            <Box
                aria-hidden
                sx={{
                    display: 'flex',
                    color: lit ? 'var(--accent)' : 'var(--text-dim)',
                    opacity: lit ? 1 : 0.6,
                    filter: activeToday ? 'drop-shadow(0 0 8px rgba(255, 138, 40, 0.5))' : 'none',
                }}
            >
                <Flame size={17} strokeWidth={2.25} />
            </Box>
            <Typography
                sx={{
                    fontFamily: 'var(--font-display)',
                    fontWeight: 700,
                    fontSize: 15,
                    lineHeight: 1,
                    color: lit ? 'var(--text)' : 'var(--text-dim)',
                }}
            >
                {current}
            </Typography>
        </Box>
    )
}
