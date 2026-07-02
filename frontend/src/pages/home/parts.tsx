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
import { Cpu, Swords, Target, Telescope, UserPlus, Users } from 'lucide-react'
import { useNavigate } from 'react-router-dom'
import { gameSocket, type LiveGameState } from '../../lib/socket'
import { useGameSocket } from '../../lib/useGameSocket'
import { useAuth } from '../../lib/auth'
import { getStats, type LobbyStats } from '../../api/client'
import { CATEGORY_META, type Category } from '../../lib/timeControl'
import { Panel, PanelHead } from '../../components/home/Panel'
import ChallengeDialog from '../../components/ChallengeDialog'
import type { Variant } from '../../lib/variants'
import { DuckGlyph } from '../../components/DuckGlyph'

// The time control the Duck Chess quick-pairing queue uses. Duck matches only
// other Duck queuers (or a Duck bot backfill after a short wait), so it has its
// own pool separate from the standard time-control queues.
export const DUCK_POOL = '5+0'

// Quick-pairing presets, grouped by time-control category.
export interface Preset {
    time: string
    cat: Category
}
export const PRESETS: Preset[] = [
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

/** All the shared homepage behaviour (queueing, matchmaking navigation, the
 * "searching" label, live lobby stats, the challenge dialog toggle). Both the
 * desktop and mobile layouts call this — only their arrangement differs. */
export function useHome() {
    const navigate = useNavigate()
    const s = useGameSocket()
    const live = s.game
    const [search, setSearch] = useState<string | null>(null)
    const [challengeOpen, setChallengeOpen] = useState(false)

    // When the hub matches us, jump into the live game.
    useEffect(() => {
        if (s.status === 'matched' && s.game) {
            setSearch(null)
            navigate(`/game/${s.game.id}`)
        }
    }, [s.status, s.game?.id, navigate])

    const queue = (label: string, pool: string, variant: Variant = 'standard') => {
        void gameSocket.queue(pool, variant)
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

    return {
        navigate,
        s,
        live,
        queue,
        searching,
        setSearch,
        challengeOpen,
        setChallengeOpen,
        stats,
    }
}

export type HomeState = ReturnType<typeof useHome>

/** The page shell shared by both layouts: max-width container, hero, the
 * resume banner, and the two dialogs. The layout-specific content (the column
 * arrangement) is passed as children. */
export function HomeChrome({ home, children }: { home: HomeState; children: ReactNode }) {
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
                <Hero stats={home.stats} />

                {/* A game in progress is the most urgent thing on the page — for anyone. */}
                {home.live && !home.live.ended && <ResumeBanner game={home.live} />}

                {children}
            </Box>

            <SearchingDialog
                searching={home.searching}
                error={home.s.error}
                onCancel={() => {
                    gameSocket.cancelQueue()
                    home.setSearch(null)
                }}
                onBot={() => home.navigate('/bot')}
            />
            <ChallengeDialog
                open={home.challengeOpen}
                onClose={() => home.setChallengeOpen(false)}
            />
        </Box>
    )
}

function Hero({ stats }: { stats: LobbyStats | null }) {
    return (
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
    )
}

/** The "Play" panel: computer, puzzles, analysis, challenge. */
export function PlayPanel({
    onNavigate,
    onChallenge,
}: {
    onNavigate: (path: string) => void
    onChallenge: () => void
}) {
    const actions = [
        { icon: <Cpu size={22} />, title: 'Computer', onClick: () => onNavigate('/bot') },
        { icon: <Target size={22} />, title: 'Puzzles', onClick: () => onNavigate('/puzzles') },
        { icon: <Telescope size={22} />, title: 'Analysis', onClick: () => onNavigate('/analysis') },
        { icon: <UserPlus size={22} />, title: 'Challenge', onClick: onChallenge },
    ]
    return (
        <Panel>
            <PanelHead title="Play" sub="Train, analyze, or take on a friend" />
            <Box
                sx={{
                    display: 'grid',
                    gridTemplateColumns: {
                        xs: 'repeat(2, 1fr)',
                        sm: 'repeat(4, 1fr)',
                    },
                    gap: 1.25,
                }}
            >
                {actions.map((a) => (
                    <ActionCell key={a.title} icon={a.icon} title={a.title} onClick={a.onClick} />
                ))}
            </Box>
        </Panel>
    )
}

/** The "Quick pairing" panel: time-control presets + Duck Chess. */
export function QuickPairingPanel({
    onQueue,
}: {
    onQueue: (label: string, pool: string, variant?: Variant) => void
}) {
    return (
        <Panel>
            <PanelHead
                title="Quick pairing"
                sub="Get matched with a player of similar strength"
            />
            <Box
                sx={{
                    display: 'grid',
                    gridTemplateColumns: {
                        xs: 'repeat(2, 1fr)',
                        sm: 'repeat(3, 1fr)',
                    },
                    gap: 1.25,
                }}
            >
                {PRESETS.map((p) => (
                    <TimeCell
                        key={p.time + p.cat}
                        preset={p}
                        onClick={() => onQueue(`${p.cat} · ${p.time}`, p.time)}
                    />
                ))}
                <DuckCell onClick={() => onQueue(`Duck Chess · ${DUCK_POOL}`, DUCK_POOL, 'duck')} />
            </Box>
        </Panel>
    )
}

function SearchingDialog({
    searching,
    error,
    onCancel,
    onBot,
}: {
    searching: string | null
    error?: string | null
    onCancel: () => void
    onBot: () => void
}) {
    return (
        <Dialog
            open={searching !== null}
            onClose={onCancel}
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
                <Typography sx={{ fontFamily: 'var(--font-display)', fontWeight: 600, fontSize: 20 }}>
                    Finding an opponent…
                </Typography>
                <Typography
                    sx={{
                        color: 'var(--text-dim)',
                        fontSize: 13,
                        mt: 1,
                        maxWidth: 280,
                        mx: 'auto',
                    }}
                >
                    {error ??
                        'Hang tight while we match you with another player. Prefer not to wait? Play the computer instead.'}
                </Typography>
            </DialogContent>
            <DialogActions sx={{ justifyContent: 'center', pb: 3, gap: 1 }}>
                <Button
                    color="inherit"
                    onClick={onCancel}
                    sx={{ color: 'var(--text-dim)', textTransform: 'none' }}
                >
                    Cancel
                </Button>
                <Button
                    variant="contained"
                    onClick={onBot}
                    sx={{ textTransform: 'none', fontWeight: 600 }}
                >
                    Play the computer instead
                </Button>
            </DialogActions>
        </Dialog>
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
                transition: 'background 0.12s ease',
                '&:hover': { bgcolor: 'var(--accent-soft-strong)' },
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
                    bgcolor: 'var(--accent-soft-strong)',
                    color: 'var(--accent)',
                }}
            >
                <Swords size={19} />
            </Box>
            <Box sx={{ minWidth: 0 }}>
                <Typography sx={{ fontWeight: 600, fontSize: 15, fontFamily: 'var(--font-display)' }}>
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
                    color: 'var(--on-accent)',
                    background: 'var(--accent-grad)',
                    border: '1px solid var(--accent)',
                    borderRadius: '10px',
                    '&:hover': { background: 'var(--accent-grad-hover)' },
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
    const { user } = useAuth()

    const categoryKeyMap: Record<Category, 'bullet' | 'blitz' | 'rapid' | 'classical'> = {
        Bullet: 'bullet',
        Blitz: 'blitz',
        Rapid: 'rapid',
        Classical: 'classical',
    }

    let eloRange: string | null = null
    if (user) {
        const key = categoryKeyMap[preset.cat]
        const userRating = user[`rating_${key}` as const]
        const rounded = Math.round(userRating / 50) * 50
        const min = rounded - 100
        const max = rounded + 100
        eloRange = `~${min.toLocaleString()}–${max.toLocaleString()}`
    }

    return (
        <Box
            onClick={onClick}
            role="button"
            tabIndex={0}
            onKeyDown={(e) => {
                if (e.key === 'Enter' || e.key === ' ') {
                    e.preventDefault()
                    onClick()
                }
            }}
            sx={{
                position: 'relative',
                display: 'flex',
                flexDirection: 'column',
                alignItems: 'center',
                justifyContent: 'center',
                gap: 1,
                py: { xs: 2.5, md: 3 },
                bgcolor: 'var(--surface-2)',
                border: '1px solid var(--line-soft)',
                borderRadius: '12px',
                cursor: 'pointer',
                overflow: 'hidden',
                transition: 'border-color 0.12s ease, background 0.12s ease',
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
            <Box sx={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 0.5 }}>
                <Box sx={{ display: 'flex', alignItems: 'center', gap: 0.75 }}>
                    <Box component="span" sx={{ display: 'flex', color }}>
                        <Icon size={14} />
                    </Box>
                    <Typography sx={{ fontSize: 12.5, color: 'var(--text-dim)', fontWeight: 500 }}>
                        {preset.cat}
                    </Typography>
                </Box>
                {eloRange && (
                    <Typography sx={{ fontSize: 11, color: 'var(--muted)' }}>{eloRange}</Typography>
                )}
            </Box>
        </Box>
    )
}

function DuckCell({ onClick }: { onClick: () => void }) {
    return (
        <Box
            onClick={onClick}
            role="button"
            tabIndex={0}
            onKeyDown={(e) => {
                if (e.key === 'Enter' || e.key === ' ') {
                    e.preventDefault()
                    onClick()
                }
            }}
            sx={{
                position: 'relative',
                display: 'flex',
                flexDirection: 'column',
                alignItems: 'center',
                justifyContent: 'center',
                gap: 1,
                py: { xs: 2.5, md: 3 },
                bgcolor: 'var(--accent-soft)',
                border: '1px solid var(--accent-line)',
                borderRadius: '12px',
                cursor: 'pointer',
                overflow: 'hidden',
                transition: 'border-color 0.12s ease, background 0.12s ease',
                '&:hover': {
                    borderColor: 'var(--accent)',
                    bgcolor: 'var(--accent-soft-strong)',
                },
            }}
        >
            <Box
                component="span"
                sx={{ fontSize: { xs: 26, md: 30 }, lineHeight: 1, display: 'block' }}
                aria-hidden
            >
                <DuckGlyph />
            </Box>
            <Box sx={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 0.5 }}>
                <Typography
                    sx={{
                        fontFamily: 'var(--font-display)',
                        fontSize: 14,
                        fontWeight: 600,
                        color: 'var(--accent)',
                        lineHeight: 1,
                    }}
                >
                    Duck Chess
                </Typography>
                <Typography sx={{ fontSize: 11.5, color: 'var(--text-dim)', fontWeight: 500 }}>
                    {DUCK_POOL} · Blitz
                </Typography>
            </Box>
        </Box>
    )
}

function ActionCell({
    icon,
    title,
    onClick,
}: {
    icon: ReactNode
    title: string
    onClick: () => void
}) {
    return (
        <Box
            onClick={onClick}
            role="button"
            tabIndex={0}
            onKeyDown={(e) => {
                if (e.key === 'Enter' || e.key === ' ') {
                    e.preventDefault()
                    onClick()
                }
            }}
            sx={{
                display: 'flex',
                flexDirection: 'column',
                alignItems: 'center',
                justifyContent: 'center',
                gap: 1,
                py: { xs: 2, md: 2.25 },
                bgcolor: 'var(--surface-2)',
                border: '1px solid var(--line-soft)',
                borderRadius: '12px',
                cursor: 'pointer',
                color: 'var(--text-dim)',
                transition: 'color 0.12s ease, border-color 0.12s ease, background 0.12s ease',
                '&:hover': {
                    color: 'var(--accent)',
                    borderColor: 'var(--accent-line)',
                    bgcolor: 'var(--surface)',
                },
            }}
        >
            {icon}
            <Typography
                sx={{
                    fontSize: 12.5,
                    fontWeight: 600,
                    color: 'var(--text)',
                    fontFamily: 'var(--font-display)',
                }}
            >
                {title}
            </Typography>
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
                        fontWeight: 600,
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
