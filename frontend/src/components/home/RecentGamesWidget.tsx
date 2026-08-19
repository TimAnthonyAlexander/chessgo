import { useEffect, useState } from 'react'
import { Box, Typography } from '@mui/material'
import { Bot } from 'lucide-react'
import { useAuth } from '../../lib/auth'
import { getProfileGames, type ProfileGame } from '../../api/client'
import { Panel, PanelHead } from './Panel'

type Outcome = 'win' | 'loss' | 'draw'

function perspective(
    g: ProfileGame,
    userId: string,
): {
    outcome: Outcome
    delta: number | null
    opponent: string
    opponentBot: boolean
} {
    const isWhite = g.white_user_id === userId
    const opponent = isWhite ? g.black_name : g.white_name
    const opponentBot = isWhite ? g.black_is_bot : g.white_is_bot

    let outcome: Outcome = 'draw'
    if (g.result === '1-0') outcome = isWhite ? 'win' : 'loss'
    else if (g.result === '0-1') outcome = isWhite ? 'loss' : 'win'

    const before = isWhite ? g.white_rating_before : g.black_rating_before
    const after = isWhite ? g.white_rating_after : g.black_rating_after
    const delta = before != null && after != null ? after - before : null

    return { outcome, opponent, opponentBot, delta }
}

const OUTCOME_STYLE: Record<Outcome, { label: string; color: string }> = {
    win: { label: 'W', color: '#5b9e5b' },
    loss: { label: 'L', color: '#ca4a4a' },
    draw: { label: 'D', color: 'var(--text-dim)' },
}

type LoadState = { kind: 'loading' } | { kind: 'empty' } | { kind: 'ready'; games: ProfileGame[] }

export default function RecentGamesWidget() {
    const { user } = useAuth()
    const [state, setState] = useState<LoadState>({ kind: 'loading' })

    useEffect(() => {
        if (!user) {
            setState({ kind: 'empty' })
            return
        }

        let cancelled = false
        setState({ kind: 'loading' })
        getProfileGames(user.name, 1)
            .then((res) => {
                if (cancelled) return
                if (res.games.length === 0) {
                    setState({ kind: 'empty' })
                } else {
                    setState({ kind: 'ready', games: res.games.slice(0, 4) })
                }
            })
            .catch(() => {
                if (cancelled) return
                setState({ kind: 'empty' })
            })
        return () => {
            cancelled = true
        }
    }, [user])

    if (!user) return null

    return (
        <Panel>
            <PanelHead title="Recent games" />
            {state.kind === 'loading' && <SkeletonRows />}
            {state.kind === 'empty' && (
                <Typography
                    sx={{ fontSize: 13, color: 'var(--muted)', py: 3, textAlign: 'center' }}
                >
                    No games yet
                </Typography>
            )}
            {state.kind === 'ready' && (
                <Box sx={{ mx: { xs: -2, md: -2.5 } }}>
                    {state.games.map((g, i) => {
                        const { outcome, opponent, opponentBot, delta } = perspective(g, user.id)
                        const o = OUTCOME_STYLE[outcome]

                        return (
                            <Box
                                key={g.id}
                                sx={{
                                    display: 'flex',
                                    alignItems: 'center',
                                    gap: 1.5,
                                    px: { xs: 2, md: 2.5 },
                                    py: 0.75,
                                    borderTop: i === 0 ? 'none' : '1px solid var(--line-soft)',
                                }}
                            >
                                <Box
                                    sx={{
                                        width: 20,
                                        height: 20,
                                        flexShrink: 0,
                                        borderRadius: 'var(--radius)',
                                        display: 'flex',
                                        alignItems: 'center',
                                        justifyContent: 'center',
                                        fontFamily: 'var(--font-mono)',
                                        fontWeight: 700,
                                        fontSize: 11,
                                        color: o.color,
                                        border: `1px solid ${o.color}`,
                                    }}
                                >
                                    {o.label}
                                </Box>

                                <Box sx={{ minWidth: 0, flex: 1 }}>
                                    <Box sx={{ display: 'flex', alignItems: 'center', gap: 0.5 }}>
                                        <Typography
                                            sx={{
                                                fontSize: 13,
                                                fontWeight: 500,
                                                color: 'var(--text)',
                                                overflow: 'hidden',
                                                textOverflow: 'ellipsis',
                                                whiteSpace: 'nowrap',
                                            }}
                                        >
                                            {opponent}
                                        </Typography>
                                        {opponentBot && <Bot size={12} color="var(--muted)" />}
                                    </Box>
                                    <Typography
                                        sx={{
                                            fontSize: 10.5,
                                            color: 'var(--muted)',
                                            textTransform: 'capitalize',
                                        }}
                                    >
                                        {g.category || 'casual'} · {g.pool}
                                    </Typography>
                                </Box>

                                {delta != null && g.rated && (
                                    <Typography
                                        sx={{
                                            fontFamily: 'var(--font-mono)',
                                            fontSize: 11.5,
                                            fontWeight: 600,
                                            color:
                                                delta > 0
                                                    ? '#5b9e5b'
                                                    : delta < 0
                                                      ? '#ca4a4a'
                                                      : 'var(--muted)',
                                            flexShrink: 0,
                                        }}
                                    >
                                        {delta > 0 ? '+' : ''}
                                        {delta}
                                    </Typography>
                                )}
                            </Box>
                        )
                    })}
                </Box>
            )}
        </Panel>
    )
}

function SkeletonRows() {
    return (
        <Box>
            {Array.from({ length: 4 }).map((_, i) => (
                <Box key={i} sx={{ display: 'flex', alignItems: 'center', gap: 1.5, py: 0.75 }}>
                    <Box
                        sx={{
                            width: 14,
                            height: 12,
                            borderRadius: 'var(--radius)',
                            bgcolor: 'var(--surface-2)',
                        }}
                    />
                    <Box sx={{ flex: 1 }}>
                        <Box
                            sx={{
                                height: 10,
                                borderRadius: 'var(--radius)',
                                bgcolor: 'var(--surface-2)',
                                mb: 0.5,
                            }}
                        />
                        <Box
                            sx={{
                                height: 8,
                                width: '70%',
                                borderRadius: 'var(--radius)',
                                bgcolor: 'var(--surface-2)',
                            }}
                        />
                    </Box>
                    <Box
                        sx={{
                            width: 30,
                            height: 12,
                            borderRadius: 'var(--radius)',
                            bgcolor: 'var(--surface-2)',
                        }}
                    />
                </Box>
            ))}
        </Box>
    )
}
