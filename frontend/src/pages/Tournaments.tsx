import { useEffect, useState } from 'react'
import { Box, Button, CircularProgress, Typography } from '@mui/material'
import { Plus, Trophy } from 'lucide-react'
import { useNavigate } from 'react-router-dom'
import { ApiError, getTournaments, type TournamentSummary } from '../api/client'
import CreateTournamentDialog from '../components/tournaments/CreateTournamentDialog'
import TournamentTimeline from '../components/tournaments/TournamentTimeline'
import { useNow } from '../components/tournaments/timing'
import { useAuth } from '../lib/auth'
import { fullBleedSx } from '../lib/fullBleed'

// Steady poll for the public list — status flips (scheduled → running →
// finished) and player counts change server-side without any local signal to
// react to, so a light background refresh keeps it honest. Paused while the
// tab is hidden.
const POLL_MS = 20000

/** `/tournaments` — a Lichess-style horizontal arena schedule: fixed lane
 * groups (green standard, green sub-bullet, purple restricted, brown
 * variants), scrollable, auto-centred on "now". Admins get an inline "New"
 * button that opens the creation form. */
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

    return (
        <Box sx={{ maxWidth: 1160, mx: 'auto', px: { xs: 1.5, md: 3 }, py: { xs: 3, md: 5 }, width: '100%' }}>
            <Box
                sx={{
                    display: 'flex',
                    alignItems: 'flex-start',
                    justifyContent: 'space-between',
                    gap: 2,
                    mb: 3,
                    px: { xs: 0.5, md: 0 },
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
                // Full-bleed break-out: the page column is capped at 1160px, but the
                // timeline wants every pixel it can get. `fullBleedSx` escapes the
                // column and spans the CONTENT area — which is not the viewport when
                // the side-rail nav is on; the global `overflow-x: clip` backstop
                // (styles.css) keeps this from ever producing a sideways page
                // scrollbar.
                <Box sx={fullBleedSx()}>
                    <TournamentTimeline
                        tournaments={tournaments}
                        now={now}
                        onOpen={(id) => navigate(`/tournaments/${id}`)}
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
