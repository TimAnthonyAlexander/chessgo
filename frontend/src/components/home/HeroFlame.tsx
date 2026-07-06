import { type ReactNode, useEffect, useState } from 'react'
import { Box, Typography } from '@mui/material'
import { Flame } from 'lucide-react'
import { useAuth } from '../../lib/auth'
import { getStreak, type Streak } from '../../api/client'

/** The hero headline. For a signed-in player on an active daily streak it becomes
 * a compact flame + day count; otherwise it stays the plain "Your move." headline,
 * so signed-out visitors and cold streaks never see a bare "0". A day counts by
 * solving a puzzle or playing a rated game (StreakService, server-side). */
export default function HeroFlame() {
    const { user, status } = useAuth()
    const [streak, setStreak] = useState<Streak | null>(null)

    useEffect(() => {
        if (status !== 'ready' || !user) {
            setStreak(null)
            return
        }
        let cancelled = false
        getStreak()
            .then((s) => {
                if (!cancelled) setStreak(s)
            })
            .catch(() => {
                if (!cancelled) setStreak(null)
            })
        return () => {
            cancelled = true
        }
    }, [user, status])

    if (!user || !streak || streak.current < 1) {
        return <Headline>Your move.</Headline>
    }

    const glow = streak.activeToday

    return (
        <Box sx={{ display: 'flex', alignItems: 'center', gap: 1.5, minWidth: 0 }}>
            <Box
                aria-hidden
                sx={{
                    display: 'flex',
                    flexShrink: 0,
                    color: 'var(--accent)',
                    filter: glow ? 'drop-shadow(0 0 10px rgba(255, 138, 40, 0.45))' : 'none',
                }}
            >
                <Flame size={38} strokeWidth={2} />
            </Box>
            <Box sx={{ display: 'flex', alignItems: 'baseline', gap: 1, minWidth: 0 }}>
                <Typography
                    sx={{
                        fontFamily: 'var(--font-display)',
                        fontWeight: 700,
                        fontSize: { xs: 34, md: 46 },
                        lineHeight: 1.04,
                        letterSpacing: '-0.02em',
                    }}
                >
                    {streak.current}
                </Typography>
                <Typography
                    sx={{
                        fontFamily: 'var(--font-display)',
                        fontWeight: 600,
                        fontSize: { xs: 14, md: 17 },
                        color: 'var(--text-dim)',
                        whiteSpace: 'nowrap',
                    }}
                >
                    day streak
                </Typography>
            </Box>
        </Box>
    )
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
