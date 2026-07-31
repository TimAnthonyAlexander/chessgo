import { useEffect, useMemo, useState } from 'react'
import { Box, Button, CircularProgress, Typography } from '@mui/material'
import { Plus, Trophy } from 'lucide-react'
import { useNavigate, type NavigateFunction } from 'react-router-dom'
import {
    ApiError,
    getTournaments,
    type TournamentSummary,
    type TournamentVariant,
} from '../api/client'
import CreateTournamentDialog from '../components/tournaments/CreateTournamentDialog'
import TournamentFilters from '../components/tournaments/TournamentFilters'
import TournamentListRow, { ROW_GRID_SX } from '../components/tournaments/TournamentListRow'
import { dayLabel, parseStartsAt, poolSpeed, STARTING_SOON_MS, useNow, type Speed } from '../components/tournaments/timing'
import { useAuth } from '../lib/auth'

// Steady poll for the public list — status flips (scheduled → running →
// finished) and player counts change server-side without any local signal to
// react to, so a light background refresh keeps it honest. Paused while the
// tab is hidden.
const POLL_MS = 20000

const COLUMN_LABELS = {
    time: 'Start',
    name: 'Event',
    variant: 'Variant',
    clock: 'Clock',
    duration: 'Time',
    players: 'Players',
    state: '',
} as const

/** `/tournaments` — the arena schedule: a dense, one-table broadcast list
 * (running → starting soon → the rest of the day's rota, grouped by day →
 * recently finished), not a stack of cards. Admins get an inline "New"
 * button that opens the creation form. */
export default function Tournaments() {
    const navigate = useNavigate()
    const { user } = useAuth()
    const isAdmin = user?.role === 'admin'
    const now = useNow(1000)

    const [tournaments, setTournaments] = useState<TournamentSummary[] | null>(null)
    const [error, setError] = useState<string | null>(null)
    const [createOpen, setCreateOpen] = useState(false)
    const [variant, setVariant] = useState<TournamentVariant | null>(null)
    const [speed, setSpeed] = useState<Speed | null>(null)

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

    const filtered = useMemo(() => {
        const list = tournaments ?? []
        return list.filter(
            (t) => (variant === null || t.variant === variant) && (speed === null || poolSpeed(t.pool) === speed),
        )
    }, [tournaments, variant, speed])

    // Running (soonest-ending isn't tracked separately — the backend already
    // hands these back soonest-started-first), then scheduled split into
    // "starting soon" (a live countdown) vs. the rest of the rota grouped by
    // calendar day, then recently-finished. One continuous table, four kinds
    // of section header, never three separate boxes.
    const groups = useMemo(() => {
        const running = filtered.filter((t) => t.status === 'running')
        const scheduled = filtered.filter((t) => t.status === 'scheduled')
        const finished = filtered.filter((t) => t.status === 'finished')

        const startingSoon = scheduled.filter((t) => parseStartsAt(t.starts_at) - now <= STARTING_SOON_MS)
        const rest = scheduled.filter((t) => parseStartsAt(t.starts_at) - now > STARTING_SOON_MS)

        const dayGroups: { label: string; items: TournamentSummary[] }[] = []
        for (const t of rest) {
            const label = dayLabel(parseStartsAt(t.starts_at), now)
            const last = dayGroups[dayGroups.length - 1]
            if (last && last.label === label) {
                last.items.push(t)
            } else {
                dayGroups.push({ label, items: [t] })
            }
        }

        return { running, startingSoon, dayGroups, finished }
    }, [filtered, now])

    const isEmpty =
        tournaments !== null &&
        groups.running.length === 0 &&
        groups.startingSoon.length === 0 &&
        groups.dayGroups.length === 0 &&
        groups.finished.length === 0

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

            <Box sx={{ px: { xs: 0.5, md: 0 } }}>
                <TournamentFilters variant={variant} onVariant={setVariant} speed={speed} onSpeed={setSpeed} />
            </Box>

            {error && !tournaments ? (
                <Box sx={{ py: 8, textAlign: 'center', color: 'var(--text-dim)', fontSize: 14 }}>
                    {error}
                </Box>
            ) : !tournaments ? (
                <Box sx={{ py: 8, display: 'flex', justifyContent: 'center' }}>
                    <CircularProgress size={22} sx={{ color: 'var(--muted)' }} />
                </Box>
            ) : isEmpty ? (
                <Box sx={{ py: 8, textAlign: 'center', color: 'var(--muted)', fontSize: 14 }}>
                    {tournaments.length === 0 ? 'No tournaments scheduled yet.' : 'Nothing matches this filter.'}
                </Box>
            ) : (
                <Box
                    sx={{
                        border: '1px solid var(--line-soft)',
                        borderRadius: '10px',
                        bgcolor: 'var(--surface)',
                        overflow: 'hidden',
                        overflowX: 'auto',
                    }}
                >
                    <TableHead />
                    <SectionRows title="Running" items={groups.running} now={now} navigate={navigate} />
                    <SectionRows title="Starting soon" items={groups.startingSoon} now={now} navigate={navigate} />
                    {groups.dayGroups.map((g) => (
                        <SectionRows key={g.label} title={g.label} items={g.items} now={now} navigate={navigate} />
                    ))}
                    <SectionRows title="Recently finished" items={groups.finished} now={now} navigate={navigate} />
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

/** The header row of column captions, sharing the exact grid the rows below
 * it use so everything lines up. */
function TableHead() {
    return (
        <Box
            sx={{
                ...ROW_GRID_SX,
                px: { xs: 1, sm: 1.5 },
                py: 0.6,
                bgcolor: 'var(--surface-2)',
                borderBottom: '1px solid var(--line-soft)',
                fontFamily: 'var(--font-mono)',
                fontSize: 10,
                letterSpacing: '0.07em',
                textTransform: 'uppercase',
                color: 'var(--muted)',
                fontWeight: 700,
            }}
        >
            <Box component="span" sx={{ gridArea: 'time' }}>
                {COLUMN_LABELS.time}
            </Box>
            <Box component="span" sx={{ gridArea: 'name' }}>
                {COLUMN_LABELS.name}
            </Box>
            <Box component="span" sx={{ gridArea: 'variant', display: { xs: 'none', sm: 'block' } }}>
                {COLUMN_LABELS.variant}
            </Box>
            <Box component="span" sx={{ gridArea: 'clock' }}>
                {COLUMN_LABELS.clock}
            </Box>
            <Box
                component="span"
                sx={{ gridArea: 'duration', textAlign: 'right', display: { xs: 'none', sm: 'block' } }}
            >
                {COLUMN_LABELS.duration}
            </Box>
            <Box component="span" sx={{ gridArea: 'players', textAlign: 'right' }}>
                {COLUMN_LABELS.players}
            </Box>
            <Box component="span" sx={{ gridArea: 'state', textAlign: 'right' }}>
                {COLUMN_LABELS.state}
            </Box>
        </Box>
    )
}

/** A full-width section label row followed by its tournament rows — a
 * lightweight break inside the one continuous table rather than a separate
 * bordered widget per group. Renders nothing when the section is empty. */
function SectionRows({
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
        <Box component="section">
            <Typography
                sx={{
                    px: { xs: 1, sm: 1.5 },
                    py: 0.4,
                    fontFamily: 'var(--font-mono)',
                    fontSize: 10,
                    letterSpacing: '0.1em',
                    textTransform: 'uppercase',
                    color: 'var(--muted)',
                    bgcolor: 'var(--bg-2)',
                    borderBottom: '1px solid var(--line-soft)',
                }}
            >
                {title}
            </Typography>
            {items.map((t) => (
                <TournamentListRow key={t.id} t={t} now={now} onClick={() => navigate(`/tournaments/${t.id}`)} />
            ))}
        </Box>
    )
}
