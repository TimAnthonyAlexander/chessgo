import { useEffect, useRef, useState } from 'react'
import { Box, Button, CircularProgress, Typography } from '@mui/material'
import { Users } from 'lucide-react'
import { useNavigate, useOutletContext, useParams } from 'react-router-dom'
import {
    ApiError,
    getTournament,
    getTournamentGames,
    joinTournament,
    withdrawTournament,
    type ArenaGame,
    type TournamentDetail,
} from '../api/client'
import type { LayoutOutletContext } from '../components/Layout'
import ArenaGamesList from '../components/tournaments/ArenaGamesList'
import StandingsTable from '../components/tournaments/StandingsTable'
import { timingText, useNow } from '../components/tournaments/timing'
import { useAuth } from '../lib/auth'
import { gameSocket } from '../lib/socket'
import { useGameSocket } from '../lib/useGameSocket'
import { VARIANT_LABEL } from '../lib/variants'

// While the arena is live (or about to start), poll standings + status so a
// finish flip or a score update shows up without a manual refresh. Stopped
// once finished, or while the tab is hidden.
const POLL_MS = 5000

/** `/tournaments/:id` — one arena: terms + live state, standings, and the
 * join/withdraw/waiting flow. Once joined and running, this page asks the hub
 * to pair us (`joinArena`) and shows a waiting state until it does; a
 * pairing lands as an ordinary `matched` game, and we navigate into it the
 * same way any other match does. */
export default function Tournament() {
    const { id = '' } = useParams()
    const navigate = useNavigate()
    const { user } = useAuth()
    const { openAuth } = useOutletContext<LayoutOutletContext>()
    const s = useGameSocket()
    const now = useNow(1000)

    const [detail, setDetail] = useState<TournamentDetail | null>(null)
    const [loadError, setLoadError] = useState<string | null>(null)
    const [busy, setBusy] = useState(false)
    const [actionError, setActionError] = useState<string | null>(null)

    const load = () => {
        getTournament(id)
            .then((d) => {
                setDetail(d)
                setLoadError(null)
            })
            .catch((e) =>
                setLoadError(e instanceof ApiError ? e.message : 'Could not load this tournament.'),
            )
    }

    // Fresh tournament id: drop any stale detail from the previous one before
    // refetching, so nothing below briefly reads the wrong tournament's state.
    useEffect(() => {
        setDetail(null)
        setLoadError(null)
        load()
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [id])

    useEffect(() => {
        if (detail?.tournament.status === 'finished') return
        const timer = window.setInterval(() => {
            if (document.visibilityState === 'visible') load()
        }, POLL_MS)
        return () => window.clearInterval(timer)
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [id, detail?.tournament.status])

    // "Games in progress": only meaningful while the arena is actually running
    // (scheduled = nothing started yet, finished = nothing left live). Polled
    // independently of standings so a hub hiccup on one never blocks the other.
    const [games, setGames] = useState<ArenaGame[] | null>(null)
    useEffect(() => {
        if (detail?.tournament.status !== 'running') {
            setGames(null)
            return
        }
        let cancelled = false
        const poll = () => {
            getTournamentGames(id)
                .then((r) => {
                    if (!cancelled) setGames(r.games)
                })
                .catch(() => {}) // fail soft — keep whatever we last had
        }
        poll()
        const timer = window.setInterval(() => {
            if (document.visibilityState === 'visible') poll()
        }, POLL_MS)
        return () => {
            cancelled = true
            window.clearInterval(timer)
        }
    }, [id, detail?.tournament.status])

    // A pairing landed: enter the game exactly like any other match.
    useEffect(() => {
        if (s.game && s.game.tournamentId === id && !s.game.ended) {
            navigate(`/game/${s.game.id}`, { replace: true })
        }
    }, [s.game, id, navigate])

    // Leaving the page stops any pending pairing for THIS tournament (Withdraw
    // does the same thing explicitly; this covers navigating away instead).
    useEffect(() => {
        return () => {
            if (gameSocket.getState().arena?.tournamentId === id) gameSocket.leaveArena()
        }
    }, [id])

    const t = detail?.tournament ?? null
    const mine = detail?.standings.find((row) => row.user_id === user?.id) ?? null
    const joined = !!mine && !mine.withdrawn

    // Once joined and running, ask the hub to start pairing us — guarded so a
    // re-render or the 5s poll doesn't resend it once we're already
    // waiting/playing. Resets whenever we stop being joined (withdrew) or the
    // tournament id changes, so a later re-join asks again.
    const askedToPlay = useRef(false)
    useEffect(() => {
        askedToPlay.current = false
    }, [id])
    useEffect(() => {
        if (!joined) askedToPlay.current = false
    }, [joined])
    useEffect(() => {
        if (!joined || t?.status !== 'running') return
        if (s.arena?.tournamentId === id) return
        if (s.game && !s.game.ended) return
        if (askedToPlay.current) return
        askedToPlay.current = true
        void gameSocket.joinArena(id)
    }, [joined, t?.status, id, s.arena, s.game])

    const doJoin = async () => {
        setBusy(true)
        setActionError(null)
        try {
            await joinTournament(id)
            load()
        } catch (e) {
            setActionError(e instanceof ApiError ? e.message : 'Could not join.')
        } finally {
            setBusy(false)
        }
    }

    const doWithdraw = async () => {
        setBusy(true)
        setActionError(null)
        try {
            await withdrawTournament(id)
            gameSocket.leaveArena()
            askedToPlay.current = false
            load()
        } catch (e) {
            setActionError(e instanceof ApiError ? e.message : 'Could not withdraw.')
        } finally {
            setBusy(false)
        }
    }

    if (loadError && !detail) {
        return (
            <Box
                sx={{
                    flex: 1,
                    display: 'flex',
                    flexDirection: 'column',
                    alignItems: 'center',
                    justifyContent: 'center',
                    gap: 2,
                    py: 10,
                }}
            >
                <Typography sx={{ color: 'var(--text-dim)' }}>{loadError}</Typography>
                <Button variant="contained" onClick={() => navigate('/tournaments')}>
                    Back to tournaments
                </Button>
            </Box>
        )
    }

    if (!detail || !t) {
        return (
            <Box sx={{ flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center', py: 10 }}>
                <CircularProgress size={22} sx={{ color: 'var(--muted)' }} />
            </Box>
        )
    }

    const waiting = s.arena?.tournamentId === id

    return (
        <Box sx={{ maxWidth: 640, mx: 'auto', px: { xs: 2, md: 3 }, py: { xs: 3, md: 5 }, width: '100%' }}>
            <Box sx={{ mb: 3 }}>
                <Typography
                    sx={{
                        fontFamily: 'var(--font-display)',
                        fontWeight: 700,
                        fontSize: { xs: 24, md: 30 },
                        lineHeight: 1.15,
                    }}
                >
                    {t.name}
                </Typography>
                <Box
                    sx={{
                        display: 'flex',
                        flexWrap: 'wrap',
                        alignItems: 'center',
                        gap: 1,
                        mt: 1,
                        fontSize: 13,
                        color: 'var(--text-dim)',
                    }}
                >
                    <Box component="span" sx={{ fontFamily: 'var(--font-mono)' }}>
                        {t.pool}
                    </Box>
                    <span>·</span>
                    <span>{t.rated ? 'Rated' : 'Casual'}</span>
                    {t.variant !== 'standard' && (
                        <>
                            <span>·</span>
                            <span>{VARIANT_LABEL[t.variant]}</span>
                        </>
                    )}
                    <span>·</span>
                    <Box component="span" sx={{ display: 'inline-flex', alignItems: 'center', gap: 0.4 }}>
                        <Users size={13} /> {t.player_count}
                    </Box>
                </Box>
                <Typography
                    sx={{
                        mt: 1,
                        fontSize: 13.5,
                        fontWeight: 600,
                        color: t.status === 'running' ? 'var(--accent)' : 'var(--text-dim)',
                    }}
                >
                    {timingText(t, now)}
                </Typography>
            </Box>

            <Box sx={{ mb: 3 }}>
                {!user ? (
                    t.status !== 'finished' && (
                        <Button
                            variant="outlined"
                            onClick={() => openAuth('login')}
                            sx={{ textTransform: 'none' }}
                        >
                            Log in to join
                        </Button>
                    )
                ) : t.status === 'finished' ? null : waiting ? (
                    <Box sx={{ display: 'flex', alignItems: 'center', gap: 1.25, flexWrap: 'wrap' }}>
                        <CircularProgress size={16} sx={{ color: 'var(--accent)' }} />
                        <Typography sx={{ fontSize: 13.5, color: 'var(--text-dim)' }}>
                            In the pool — waiting for a pairing…
                        </Typography>
                        <Button
                            size="small"
                            onClick={doWithdraw}
                            disabled={busy}
                            sx={{ textTransform: 'none', color: 'var(--text-dim)' }}
                        >
                            Withdraw
                        </Button>
                    </Box>
                ) : joined ? (
                    <Button
                        variant="outlined"
                        onClick={doWithdraw}
                        disabled={busy}
                        sx={{
                            textTransform: 'none',
                            borderColor: 'var(--line)',
                            color: 'var(--text-dim)',
                        }}
                    >
                        Withdraw
                    </Button>
                ) : (
                    <Button
                        variant="contained"
                        onClick={doJoin}
                        disabled={busy}
                        sx={{ textTransform: 'none', fontWeight: 600 }}
                    >
                        {mine?.withdrawn ? 'Rejoin' : 'Join'}
                    </Button>
                )}
                {actionError && (
                    <Typography sx={{ mt: 1, fontSize: 13, color: '#e6a3a3' }}>{actionError}</Typography>
                )}
            </Box>

            <Typography
                sx={{ fontFamily: 'var(--font-display)', fontWeight: 700, fontSize: 16, mb: 1.25 }}
            >
                Standings
            </Typography>
            <StandingsTable standings={detail.standings} currentUserId={user?.id} />

            {t.status === 'running' && (
                <Box sx={{ mt: 3 }}>
                    <Typography
                        sx={{ fontFamily: 'var(--font-display)', fontWeight: 700, fontSize: 16, mb: 1.25 }}
                    >
                        Games in progress
                    </Typography>
                    <ArenaGamesList games={games} />
                </Box>
            )}
        </Box>
    )
}
