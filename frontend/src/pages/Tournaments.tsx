import { useEffect, useMemo, useState } from 'react'
import { Box, Button, CircularProgress, Typography } from '@mui/material'
import { Plus, Trophy } from 'lucide-react'
import { useNavigate, type NavigateFunction } from 'react-router-dom'
import { ApiError, getTournaments, type TournamentSummary } from '../api/client'
import CreateTournamentDialog from '../components/tournaments/CreateTournamentDialog'
import TournamentListRow from '../components/tournaments/TournamentListRow'
import { useNow } from '../components/tournaments/timing'
import { useAuth } from '../lib/auth'

// Steady poll for the public list — status flips (scheduled → running →
// finished) and player counts change server-side without any local signal to
// react to, so a light background refresh keeps it honest. Paused while the
// tab is hidden.
const POLL_MS = 20000

/** `/tournaments` — the arena list: running, upcoming, and recently finished,
 * each with a live countdown. Admins get an inline "New" button that opens
 * the creation form. */
export default function Tournaments() {
    const navigate = useNavigate()
    const { user } = useAuth()
    const isAdmin = user?.role === 'admin'
    const now = useNow(1000)

    const [tournaments, setTournaments] = useState<TournamentSummary[] | null>(null)
    const [error, setError] = useState<string | null>(null)
    const [createOpen, setCreateOpen] = useState(false)

    const load = () => {
        getTournaments()
            .then((r) => {
                setTournaments(r.tournaments)
                setError(null)
            })
            .catch((e) => setError(e instanceof ApiError ? e.message : 'Could not load tournaments.'))
    }

    useEffect(() => {
        load()
        const id = window.setInterval(() => {
            if (document.visibilityState === 'visible') load()
        }, POLL_MS)
        return () => window.clearInterval(id)
    }, [])

    const groups = useMemo(() => {
        const list = tournaments ?? []
        return {
            running: list.filter((t) => t.status === 'running'),
            scheduled: list.filter((t) => t.status === 'scheduled'),
            finished: list.filter((t) => t.status === 'finished'),
        }
    }, [tournaments])

    return (
        <Box sx={{ maxWidth: 760, mx: 'auto', px: { xs: 2, md: 3 }, py: { xs: 3, md: 5 }, width: '100%' }}>
            <Box
                sx={{
                    display: 'flex',
                    alignItems: 'flex-start',
                    justifyContent: 'space-between',
                    gap: 2,
                    mb: 3,
                }}
            >
                <Box>
                    <Box sx={{ display: 'flex', alignItems: 'center', gap: 1, mb: 1 }}>
                        <Box sx={{ display: 'flex', color: 'var(--accent)' }}>
                            <Trophy size={15} />
                        </Box>
                        <Typography
                            sx={{
                                fontFamily: 'var(--font-mono)',
                                fontSize: 12,
                                letterSpacing: '0.2em',
                                textTransform: 'uppercase',
                                color: 'var(--accent)',
                            }}
                        >
                            Arena
                        </Typography>
                    </Box>
                    <Typography
                        sx={{
                            fontFamily: 'var(--font-display)',
                            fontWeight: 700,
                            fontSize: { xs: 26, md: 34 },
                            lineHeight: 1.05,
                        }}
                    >
                        Tournaments
                    </Typography>
                </Box>
                {isAdmin && (
                    <Button
                        variant="contained"
                        startIcon={<Plus size={16} />}
                        onClick={() => setCreateOpen(true)}
                        sx={{ textTransform: 'none', fontWeight: 600, flexShrink: 0 }}
                    >
                        New
                    </Button>
                )}
            </Box>

            {error && !tournaments ? (
                <Box sx={{ py: 8, textAlign: 'center', color: 'var(--text-dim)', fontSize: 14 }}>
                    {error}
                </Box>
            ) : !tournaments ? (
                <Box sx={{ py: 8, display: 'flex', justifyContent: 'center' }}>
                    <CircularProgress size={22} sx={{ color: 'var(--muted)' }} />
                </Box>
            ) : tournaments.length === 0 ? (
                <Box sx={{ py: 8, textAlign: 'center', color: 'var(--muted)', fontSize: 14 }}>
                    No tournaments scheduled yet.
                </Box>
            ) : (
                <Box sx={{ display: 'flex', flexDirection: 'column', gap: 3 }}>
                    <Section title="Running" items={groups.running} now={now} navigate={navigate} />
                    <Section title="Upcoming" items={groups.scheduled} now={now} navigate={navigate} />
                    <Section
                        title="Recently finished"
                        items={groups.finished}
                        now={now}
                        navigate={navigate}
                    />
                </Box>
            )}

            <CreateTournamentDialog
                open={createOpen}
                onClose={() => setCreateOpen(false)}
                onCreated={(t) => {
                    setCreateOpen(false)
                    setTournaments((prev) => [t, ...(prev ?? [])])
                    navigate(`/tournaments/${t.id}`)
                }}
            />
        </Box>
    )
}

function Section({
    title,
    items,
    now,
    navigate,
}: {
    title: string
    items: TournamentSummary[]
    now: number
    navigate: NavigateFunction
}) {
    if (items.length === 0) return null
    return (
        <Box>
            <Typography
                sx={{
                    fontFamily: 'var(--font-mono)',
                    fontSize: 11,
                    letterSpacing: '0.12em',
                    textTransform: 'uppercase',
                    color: 'var(--muted)',
                    mb: 1,
                }}
            >
                {title}
            </Typography>
            <Box
                sx={{
                    border: '1px solid var(--line-soft)',
                    borderRadius: '12px',
                    bgcolor: 'var(--surface)',
                    overflow: 'hidden',
                }}
            >
                {items.map((t, i) => (
                    <Box key={t.id} sx={{ borderTop: i > 0 ? '1px solid var(--line-soft)' : 'none' }}>
                        <TournamentListRow
                            t={t}
                            now={now}
                            onClick={() => navigate(`/tournaments/${t.id}`)}
                        />
                    </Box>
                ))}
            </Box>
        </Box>
    )
}
