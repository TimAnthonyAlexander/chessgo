import { type ReactNode, useEffect, useState } from 'react'
import {
    Box,
    Button,
    CircularProgress,
    Dialog,
    DialogActions,
    DialogContent,
    Typography,
} from '@mui/material'
import { ChevronRight, Cpu, Swords, Target, Telescope, UserPlus, Users } from 'lucide-react'
import { useNavigate } from 'react-router-dom'
import { gameSocket, type LiveGameState } from '../lib/socket'
import { useGameSocket } from '../lib/useGameSocket'
import { useAuth } from '../lib/auth'
import { getStats, type LobbyStats } from '../api/client'
import { CATEGORY_META, type Category } from '../lib/timeControl'
import { Panel, PanelHead } from '../components/home/Panel'
import LiveTvWidget from '../components/home/LiveTvWidget'
import DailyPuzzleWidget from '../components/home/DailyPuzzleWidget'
import LeaderboardWidget from '../components/home/LeaderboardWidget'
import RatingCards from '../components/home/RatingCards'
import ChallengeDialog from '../components/ChallengeDialog'
import CustomTimeDialog from '../components/CustomTimeDialog'

// Quick-pairing presets, grouped by time-control category.
interface Preset {
    time: string
    cat: Category
}
const PRESETS: Preset[] = [
    { time: '1+0', cat: 'Bullet' },
    { time: '2+1', cat: 'Bullet' },
    { time: '3+0', cat: 'Blitz' },
    { time: '3+2', cat: 'Blitz' },
    { time: '5+0', cat: 'Blitz' },
    { time: '5+3', cat: 'Blitz' },
    { time: '10+0', cat: 'Rapid' },
    { time: '10+5', cat: 'Rapid' },
    { time: '15+10', cat: 'Rapid' },
    { time: '30+0', cat: 'Classical' },
    { time: '30+20', cat: 'Classical' },
]

export default function Home() {
    const navigate = useNavigate()
    const s = useGameSocket()
    const live = s.game
    const { user } = useAuth()
    const [search, setSearch] = useState<string | null>(null)
    const [challengeOpen, setChallengeOpen] = useState(false)
    const [customOpen, setCustomOpen] = useState(false)

    // When the hub matches us, jump into the live game.
    useEffect(() => {
        if (s.status === 'matched' && s.game) {
            setSearch(null)
            navigate(`/game/${s.game.id}`)
        }
    }, [s.status, s.game?.id, navigate])

    const queue = (label: string, pool: string) => {
        void gameSocket.queue(pool)
        setSearch(label)
    }

    // Either source: our optimistic label, or a queue we landed in (e.g. "New game"
    // from a finished live game, which queues before routing here).
    const searching = search ?? (s.status === 'queued' ? s.pool : null)

    // Live lobby counts (poll while open; failures keep the last value).
    const [stats, setStats] = useState<LobbyStats | null>(null)
    useEffect(() => {
        let cancelled = false
        const tick = () => {
            getStats()
                .then((r) => {
                    if (!cancelled) setStats(r)
                })
                .catch(() => {})
        }
        tick()
        const id = window.setInterval(tick, 10_000)
        return () => {
            cancelled = true
            window.clearInterval(id)
        }
    }, [])

    const actions = [
        {
            icon: <Cpu size={19} />,
            title: 'Play the computer',
            sub: 'Eleven levels, gentle to merciless',
            onClick: () => navigate('/bot'),
        },
        {
            icon: <Target size={19} />,
            title: 'Puzzles',
            sub: 'Rated tactics trainer',
            onClick: () => navigate('/puzzles'),
        },
        {
            icon: <Telescope size={19} />,
            title: 'Analysis board',
            sub: 'Explore lines with the engine',
            onClick: () => navigate('/analysis'),
        },
        {
            icon: <UserPlus size={19} />,
            title: 'Challenge a friend',
            sub: 'Private game by link',
            onClick: () => setChallengeOpen(true),
        },
    ]

    return (
        <Box sx={{ flex: 1 }}>
            <Box
                sx={{
                    maxWidth: 1320,
                    mx: 'auto',
                    px: { xs: 2, md: 3 },
                    py: { xs: 2.5, md: 3.5 },
                }}
            >
                {/* Hero */}
                <Box
                    sx={{
                        display: 'flex',
                        flexDirection: { xs: 'column', md: 'row' },
                        alignItems: { md: 'flex-end' },
                        justifyContent: 'space-between',
                        gap: { xs: 2, md: 3 },
                        mb: { xs: 2.5, md: 3 },
                    }}
                >
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
                            Your move.
                        </Typography>
                        <Typography
                            sx={{
                                mt: 1,
                                fontSize: { xs: 14.5, md: 15.5 },
                                color: 'var(--text-dim)',
                                maxWidth: 540,
                            }}
                        >
                            Pick a time control below to get matched, or play the computer.
                        </Typography>
                    </Box>

                    {/* Live counters */}
                    <Box sx={{ display: 'flex', gap: 1.25, flexShrink: 0 }}>
                        <StatPill
                            icon={<Users size={15} />}
                            value={stats?.playersOnline}
                            label="players online"
                        />
                        <StatPill
                            icon={<Swords size={15} />}
                            value={stats?.activeGames}
                            label="games in play"
                        />
                    </Box>
                </Box>

                {/* A game in progress is the most urgent thing on the page — for anyone. */}
                {live && !live.ended && <ResumeBanner game={live} />}

                {/* Logged-in: your ratings at a glance (renders nothing for anonymous). */}
                {user && (
                    <Box sx={{ mb: { xs: 2.5, md: 3 } }}>
                        <RatingCards />
                    </Box>
                )}

                {/* Dashboard: quick pairing + play + live/community widgets */}
                <Box
                    sx={{
                        display: 'grid',
                        gridTemplateColumns: {
                            xs: '1fr',
                            md: 'repeat(2, minmax(0, 1fr))',
                            lg: 'minmax(0, 1.45fr) minmax(0, 1fr) minmax(0, 1fr)',
                        },
                        gap: { xs: 2.5, lg: 2.5 },
                        alignItems: 'start',
                    }}
                >
                    {/* Column A: quick pairing */}
                    <Panel>
                        <PanelHead
                            title="Quick pairing"
                            sub="Get matched with a player of similar strength"
                        />
                        <Box
                            sx={{
                                display: 'grid',
                                gridTemplateColumns: { xs: 'repeat(2, 1fr)', sm: 'repeat(3, 1fr)' },
                                gap: 1.25,
                            }}
                        >
                            {PRESETS.map((p) => (
                                <TimeCell
                                    key={p.time + p.cat}
                                    preset={p}
                                    onClick={() => queue(`${p.cat} · ${p.time}`, p.time)}
                                />
                            ))}
                            <CustomCell onClick={() => setCustomOpen(true)} />
                        </Box>
                    </Panel>

                    {/* Column B: play + leaderboard */}
                    <Box
                        sx={{ display: 'flex', flexDirection: 'column', gap: { xs: 2.5, lg: 2.5 } }}
                    >
                        <Panel>
                            <PanelHead title="Play" sub="Train, analyse, or take on a friend" />
                            <Box sx={{ mx: { xs: -2, md: -2.5 } }}>
                                {actions.map((a, i) => (
                                    <ActionRow
                                        key={a.title}
                                        icon={a.icon}
                                        title={a.title}
                                        sub={a.sub}
                                        onClick={a.onClick}
                                        first={i === 0}
                                    />
                                ))}
                            </Box>
                        </Panel>
                        <LeaderboardWidget />
                    </Box>

                    {/* Column C: live game + daily puzzle */}
                    <Box
                        sx={{ display: 'flex', flexDirection: 'column', gap: { xs: 2.5, lg: 2.5 } }}
                    >
                        <LiveTvWidget />
                        <DailyPuzzleWidget />
                    </Box>
                </Box>
            </Box>

            {/* "Searching" dialog */}
            <Dialog
                open={searching !== null}
                onClose={() => setSearch(null)}
                slotProps={{
                    paper: {
                        sx: {
                            bgcolor: 'var(--surface)',
                            border: '1px solid var(--line)',
                            borderRadius: '16px',
                            minWidth: 360,
                        },
                    },
                }}
            >
                <DialogContent sx={{ textAlign: 'center', pt: 4, pb: 2 }}>
                    <Typography
                        sx={{
                            fontFamily: 'var(--font-mono)',
                            fontSize: 12.5,
                            letterSpacing: '0.14em',
                            color: 'var(--accent)',
                            textTransform: 'uppercase',
                        }}
                    >
                        {searching}
                    </Typography>
                    <CircularProgress sx={{ color: 'var(--accent)', my: 3 }} />
                    <Typography
                        sx={{ fontFamily: 'var(--font-display)', fontWeight: 700, fontSize: 19 }}
                    >
                        Finding an opponent…
                    </Typography>
                    <Typography
                        sx={{
                            color: 'var(--text-dim)',
                            fontSize: 13.5,
                            mt: 1,
                            maxWidth: 280,
                            mx: 'auto',
                        }}
                    >
                        {s.error ??
                            'Hang tight while we match you with another player. Prefer not to wait? Play the computer instead.'}
                    </Typography>
                </DialogContent>
                <DialogActions sx={{ justifyContent: 'center', pb: 3, gap: 1 }}>
                    <Button
                        color="inherit"
                        onClick={() => {
                            gameSocket.cancelQueue()
                            setSearch(null)
                        }}
                        sx={{ color: 'var(--text-dim)' }}
                    >
                        Cancel
                    </Button>
                    <Button variant="contained" onClick={() => navigate('/bot')}>
                        Play the computer instead
                    </Button>
                </DialogActions>
            </Dialog>

            <CustomTimeDialog
                open={customOpen}
                onClose={() => setCustomOpen(false)}
                onStart={(pool) => queue(`Custom · ${pool}`, pool)}
            />
            <ChallengeDialog open={challengeOpen} onClose={() => setChallengeOpen(false)} />
        </Box>
    )
}

function ResumeBanner({ game }: { game: LiveGameState }) {
    const navigate = useNavigate()
    const go = () => navigate(`/game/${game.id}`)
    return (
        <Box
            onClick={go}
            sx={{
                display: 'flex',
                alignItems: 'center',
                gap: 1.5,
                p: 1.75,
                mb: { xs: 2.5, md: 3 },
                borderRadius: '14px',
                cursor: 'pointer',
                bgcolor: 'var(--accent-soft)',
                border: '1px solid var(--accent-line)',
                transition: 'background 0.15s ease',
                '&:hover': { bgcolor: 'rgba(216,166,87,0.18)' },
            }}
        >
            <Box
                sx={{
                    width: 38,
                    height: 38,
                    flexShrink: 0,
                    borderRadius: '10px',
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'center',
                    bgcolor: 'rgba(216,166,87,0.18)',
                    color: 'var(--accent)',
                }}
            >
                <Swords size={19} />
            </Box>
            <Box sx={{ minWidth: 0 }}>
                <Typography
                    sx={{ fontWeight: 700, fontSize: 14.5, fontFamily: 'var(--font-display)' }}
                >
                    You have a game in progress
                </Typography>
                <Typography sx={{ fontSize: 12.5, color: 'var(--text-dim)' }}>
                    vs {game.opponent.name} · {game.pool}
                    {game.opponentOnline ? '' : ' · opponent disconnected'}
                </Typography>
            </Box>
            <Box
                component="button"
                onClick={(e) => {
                    e.stopPropagation()
                    go()
                }}
                sx={{
                    ml: 'auto',
                    flexShrink: 0,
                    height: 38,
                    px: 2,
                    cursor: 'pointer',
                    fontFamily: 'var(--font-display)',
                    fontSize: 14,
                    fontWeight: 600,
                    color: '#15171c',
                    background: 'linear-gradient(180deg, #e3b56a, #d8a657)',
                    border: '1px solid var(--accent)',
                    borderRadius: '10px',
                    '&:hover': { background: 'linear-gradient(180deg, #e7bd76, #dcab5d)' },
                    '&:active': { transform: 'translateY(1px)' },
                }}
            >
                Resume
            </Box>
        </Box>
    )
}

function TimeCell({ preset, onClick }: { preset: Preset; onClick: () => void }) {
    const { Icon, color } = CATEGORY_META[preset.cat]
    return (
        <Box
            onClick={onClick}
            sx={{
                position: 'relative',
                display: 'flex',
                flexDirection: 'column',
                alignItems: 'center',
                justifyContent: 'center',
                gap: 1,
                py: { xs: 2.5, md: 3 },
                bgcolor: 'var(--surface-2)',
                border: '1px solid var(--line)',
                borderRadius: '12px',
                cursor: 'pointer',
                overflow: 'hidden',
                transition: 'border-color .12s ease, background .12s ease',
                '&:hover': {
                    borderColor: 'var(--accent-line)',
                    bgcolor: 'var(--surface)',
                },
            }}
        >
            <Typography
                sx={{
                    fontFamily: 'var(--font-display)',
                    fontSize: { xs: 25, md: 30 },
                    fontWeight: 500,
                    lineHeight: 1,
                    letterSpacing: '-0.01em',
                }}
            >
                {preset.time}
            </Typography>
            <Box sx={{ display: 'flex', alignItems: 'center', gap: 0.6 }}>
                <Box component="span" sx={{ display: 'flex', color }}>
                    <Icon size={13} />
                </Box>
                <Typography sx={{ fontSize: 12.5, color: 'var(--text-dim)', fontWeight: 500 }}>
                    {preset.cat}
                </Typography>
            </Box>
        </Box>
    )
}

function CustomCell({ onClick }: { onClick: () => void }) {
    return (
        <Box
            onClick={onClick}
            sx={{
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                py: { xs: 2.5, md: 3 },
                border: '1px dashed var(--line)',
                borderRadius: '12px',
                cursor: 'pointer',
                color: 'var(--muted)',
                transition: 'color .12s ease, border-color .12s ease',
                '&:hover': { color: 'var(--accent)', borderColor: 'var(--accent-line)' },
            }}
        >
            <Typography sx={{ fontSize: { xs: 16, md: 17 }, fontWeight: 500 }}>Custom</Typography>
        </Box>
    )
}

function ActionRow({
    icon,
    title,
    sub,
    onClick,
    first,
}: {
    icon: ReactNode
    title: string
    sub: string
    onClick: () => void
    first?: boolean
}) {
    return (
        <Box
            onClick={onClick}
            sx={{
                display: 'flex',
                alignItems: 'center',
                gap: 1.5,
                px: { xs: 2, md: 2.5 },
                py: 1.4,
                cursor: 'pointer',
                borderTop: first ? 'none' : '1px solid var(--line-soft)',
                transition: 'background-color .12s ease',
                '&:hover': {
                    bgcolor: 'var(--surface-2)',
                    '& .action-chevron': { color: 'var(--accent)', transform: 'translateX(2px)' },
                },
            }}
        >
            <Box
                sx={{
                    width: 38,
                    height: 38,
                    flexShrink: 0,
                    borderRadius: '10px',
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'center',
                    bgcolor: 'var(--surface-2)',
                    border: '1px solid var(--line)',
                    color: 'var(--text-dim)',
                }}
            >
                {icon}
            </Box>
            <Box sx={{ minWidth: 0, flex: 1 }}>
                <Typography
                    sx={{ fontWeight: 600, fontSize: 15, fontFamily: 'var(--font-display)' }}
                >
                    {title}
                </Typography>
                <Typography sx={{ fontSize: 12.5, color: 'var(--muted)', mt: 0.1 }}>
                    {sub}
                </Typography>
            </Box>
            <Box
                className="action-chevron"
                sx={{
                    display: 'flex',
                    color: 'var(--text-dim)',
                    flexShrink: 0,
                    transition: 'color .12s, transform .12s',
                }}
            >
                <ChevronRight size={18} />
            </Box>
        </Box>
    )
}

function StatPill({ icon, value, label }: { icon: ReactNode; value?: number; label: string }) {
    return (
        <Box
            sx={{
                display: 'flex',
                alignItems: 'center',
                gap: 1,
                px: 1.5,
                py: 1,
                borderRadius: '12px',
                bgcolor: 'var(--surface)',
                border: '1px solid var(--line-soft)',
            }}
        >
            <Box sx={{ display: 'flex', color: 'var(--accent)' }}>{icon}</Box>
            <Box sx={{ lineHeight: 1.1 }}>
                <Typography
                    component="div"
                    sx={{
                        fontFamily: 'var(--font-mono)',
                        fontSize: 16,
                        fontWeight: 700,
                        color: 'var(--text)',
                    }}
                >
                    {value != null ? value.toLocaleString() : '—'}
                </Typography>
                <Typography sx={{ fontSize: 11, color: 'var(--muted)' }}>{label}</Typography>
            </Box>
        </Box>
    )
}
