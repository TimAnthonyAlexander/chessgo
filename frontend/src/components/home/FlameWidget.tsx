import { useEffect, useState } from 'react'
import { Box, Typography } from '@mui/material'
import { useOutletContext } from 'react-router-dom'
import { useAuth } from '../../lib/auth'
import { getStreak, type Streak } from '../../api/client'
import type { LayoutOutletContext } from '../Layout'
import { Panel, PanelHead } from './Panel'

type LoadState =
    | { kind: 'loading' }
    | { kind: 'ready'; streak: Streak }
    | { kind: 'error' }

/** A gently glowing flame. Dims to an ember when the streak is cold (0 / broken)
 * so a lit vs unlit day reads at a glance — CSS/MUI only, no assets. */
function Flame({ lit }: { lit: boolean }) {
    return (
        <Box
            aria-hidden
            sx={{
                fontSize: 44,
                lineHeight: 1,
                userSelect: 'none',
                filter: lit
                    ? 'drop-shadow(0 0 10px rgba(255, 138, 40, 0.55))'
                    : 'grayscale(0.85) opacity(0.45)',
                animation: lit ? 'flame-flicker 2.6s ease-in-out infinite' : 'none',
                '@keyframes flame-flicker': {
                    '0%, 100%': { transform: 'translateZ(0) scale(1)', opacity: 1 },
                    '45%': { transform: 'translateZ(0) scale(1.06)', opacity: 0.92 },
                    '70%': { transform: 'translateZ(0) scale(0.98)', opacity: 1 },
                },
            }}
        >
            🔥
        </Box>
    )
}

/** Homepage "The Flame" widget: a daily-activity streak. Shows the flame + the
 * current streak number, the longest streak as a subtle secondary, and whether
 * today already counts ("Lit today" vs "Play to keep it lit"). Guests get a soft
 * sign-in nudge instead. A day qualifies by solving a puzzle or playing a rated
 * game — mirrored server-side by StreakService. */
export default function FlameWidget() {
    const { user, status } = useAuth()
    const { openAuth } = useOutletContext<LayoutOutletContext>()
    const [state, setState] = useState<LoadState>({ kind: 'loading' })

    useEffect(() => {
        // Wait for the session to resolve, and skip the fetch for guests entirely.
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

    const head = <PanelHead title="The Flame" sub="Your daily streak" />

    // Guest state: a soft nudge to sign in. No fetch, no numbers.
    if (status === 'ready' && !user) {
        return (
            <Panel
                sx={{
                    cursor: 'pointer',
                    transition: 'border-color 0.12s ease',
                    '&:hover': { borderColor: 'var(--accent-line)' },
                }}
            >
                <Box
                    role="button"
                    tabIndex={0}
                    onClick={() => openAuth('login')}
                    onKeyDown={(e) => {
                        if (e.key === 'Enter' || e.key === ' ') {
                            e.preventDefault()
                            openAuth('login')
                        }
                    }}
                    sx={{ outline: 'none' }}
                >
                    {head}
                    <Box
                        sx={{
                            display: 'flex',
                            alignItems: 'center',
                            gap: 2,
                            py: 1,
                        }}
                    >
                        <Flame lit={false} />
                        <Box sx={{ minWidth: 0 }}>
                            <Typography
                                sx={{
                                    fontSize: 14,
                                    fontWeight: 600,
                                    color: 'var(--text)',
                                    fontFamily: 'var(--font-display)',
                                }}
                            >
                                Sign in to start a streak
                            </Typography>
                            <Typography sx={{ fontSize: 12.5, color: 'var(--text-dim)', mt: 0.25 }}>
                                Solve a puzzle or play a rated game each day.
                            </Typography>
                        </Box>
                    </Box>
                </Box>
            </Panel>
        )
    }

    if (state.kind === 'error') {
        return (
            <Panel>
                {head}
                <Typography
                    sx={{ fontSize: 13, color: 'var(--muted)', py: 3, textAlign: 'center' }}
                >
                    Couldn't load your streak
                </Typography>
            </Panel>
        )
    }

    if (state.kind === 'loading') {
        return (
            <Panel>
                {head}
                <Box sx={{ display: 'flex', alignItems: 'center', gap: 2, py: 1 }}>
                    <Flame lit={false} />
                    <Box sx={{ flex: 1 }}>
                        <Box
                            sx={{
                                height: 26,
                                width: 72,
                                borderRadius: '4px',
                                bgcolor: 'var(--surface-2)',
                                mb: 0.75,
                            }}
                        />
                        <Box
                            sx={{
                                height: 11,
                                width: '55%',
                                borderRadius: '3px',
                                bgcolor: 'var(--surface-2)',
                            }}
                        />
                    </Box>
                </Box>
            </Panel>
        )
    }

    const { current, longest, activeToday } = state.streak
    const lit = current > 0
    const statusLabel = activeToday
        ? 'Lit today ✓'
        : lit
          ? 'Play today to keep it lit'
          : 'Play today to start your streak'
    const statusColor = activeToday ? 'var(--accent)' : 'var(--text-dim)'

    return (
        <Panel>
            {head}
            <Box sx={{ display: 'flex', alignItems: 'center', gap: 2, py: 0.5 }}>
                <Flame lit={lit} />
                <Box sx={{ minWidth: 0, flex: 1 }}>
                    <Box sx={{ display: 'flex', alignItems: 'baseline', gap: 1 }}>
                        <Typography
                            sx={{
                                fontFamily: 'var(--font-display)',
                                fontWeight: 700,
                                fontSize: 34,
                                lineHeight: 1,
                                letterSpacing: '-0.02em',
                                color: lit ? 'var(--text)' : 'var(--text-dim)',
                            }}
                        >
                            {current}
                        </Typography>
                        <Typography
                            sx={{
                                fontSize: 13,
                                color: 'var(--text-dim)',
                                fontWeight: 500,
                            }}
                        >
                            {current === 1 ? 'day' : 'days'}
                        </Typography>
                    </Box>
                    <Typography
                        sx={{
                            fontSize: 12.5,
                            fontWeight: 600,
                            color: statusColor,
                            mt: 0.5,
                        }}
                    >
                        {statusLabel}
                    </Typography>
                </Box>

                {longest > 0 && (
                    <Box sx={{ textAlign: 'right', flexShrink: 0 }}>
                        <Typography
                            sx={{
                                fontFamily: 'var(--font-mono)',
                                fontSize: 18,
                                fontWeight: 600,
                                color: 'var(--text-dim)',
                                lineHeight: 1,
                            }}
                        >
                            {longest}
                        </Typography>
                        <Typography sx={{ fontSize: 10.5, color: 'var(--muted)', mt: 0.5 }}>
                            longest
                        </Typography>
                    </Box>
                )}
            </Box>
        </Panel>
    )
}
