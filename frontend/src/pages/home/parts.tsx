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
import { Cpu, Crown, Gauge, Shuffle, Skull, Swords, Target, Telescope, UserPlus } from 'lucide-react'
import { useLocation, useNavigate } from 'react-router-dom'
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

// Crazyhouse quick-pairing pool — one isolated pool (its own rating), like Duck.
// Blitz suits the sharp, tactical variant.
export const CRAZYHOUSE_POOL = '3+0'

// Antichess quick-pairing pool — one isolated pool (its own rating), like Duck
// and Crazyhouse. Blitz suits a variant that's usually over fast.
export const ANTICHESS_POOL = '3+0'
export const SECRETQUEEN_POOL = '3+0'

// Chess960 quick-pairing pool — one isolated pool with its own rating, like the
// other variants. A shuffled back rank costs you the opening book you've
// memorized, so it gets the slower 5+0 rather than the 3+0 the sharp variants use.
export const CHESS960_POOL = '5+0'

// Quick-pairing presets, grouped by time-control category.
export interface Preset {
    time: string
    cat: Category
}
export const PRESETS: Preset[] = [
    { time: '1+0', cat: 'Bullet' },
    { time: '1+1', cat: 'Bullet' },
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
    const location = useLocation()
    const s = useGameSocket()
    const live = s.game
    const [search, setSearch] = useState<string | null>(null)
    const [challengeOpen, setChallengeOpen] = useState(false)
    // Set while we're waiting for a game to land so we know to route into it.
    // Covers the case where we asked to queue and the hub answered with a resume
    // for the game this account already had open elsewhere.
    const [openWhenLive, setOpenWhenLive] = useState(false)

    // When the hub matches us, jump into the live game.
    useEffect(() => {
        if (s.status === 'matched' && s.game) {
            setSearch(null)
            navigate(`/game/${s.game.id}`)
        }
    }, [s.status, s.game?.id, navigate])

    // We asked for a game and the hub handed us one we already had (started in
    // another tab or on the phone — it never starts a second one). Drop the
    // searching dialog and go to that board.
    useEffect(() => {
        if (!openWhenLive || !live || live.ended) return
        setOpenWhenLive(false)
        setSearch(null)
        navigate(`/game/${live.id}`)
    }, [openWhenLive, live?.id, live?.ended, navigate])

    const queue = (label: string, pool: string, variant: Variant = 'standard') => {
        void gameSocket.queue(pool, variant)
        setSearch(label)
        setOpenWhenLive(true)
    }

    // Quick-pairing intent carried in from the navbar (Play → Chess960 / Duck Chess /
    // Crazyhouse / Antichess): land on Home and start matchmaking instantly. Consumed
    // once, then cleared from history state so a refresh/back doesn't silently re-queue.
    useEffect(() => {
        const qp = (location.state as { quickPair?: Variant } | null)?.quickPair
        if (
            qp !== 'chess960' &&
            qp !== 'duck' &&
            qp !== 'crazyhouse' &&
            qp !== 'antichess' &&
            qp !== 'secretqueen'
        )
            return
        navigate(location.pathname, { replace: true, state: null })
        if (qp === 'chess960') queue(`Chess960 · ${CHESS960_POOL}`, CHESS960_POOL, 'chess960')
        else if (qp === 'duck') queue(`Duck Chess · ${DUCK_POOL}`, DUCK_POOL, 'duck')
        else if (qp === 'crazyhouse')
            queue(`Crazyhouse · ${CRAZYHOUSE_POOL}`, CRAZYHOUSE_POOL, 'crazyhouse')
        else if (qp === 'antichess') queue(`Antichess · ${ANTICHESS_POOL}`, ANTICHESS_POOL, 'antichess')
        else
            queue(
                `Secret Queen · ${SECRETQUEEN_POOL}`,
                SECRETQUEEN_POOL,
                'secretqueen',
            )
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [location.key])

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
                .catch(() => { })
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
export function HomeChrome({
    home,
    children,
}: {
    home: HomeState
    children: ReactNode
}) {
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
                onBot={() => {
                    // Leave the queue before routing to /bot — otherwise the hub can
                    // still pair/backfill us into a live game while we're playing the
                    // computer. Mirror onCancel, then navigate.
                    gameSocket.cancelQueue()
                    home.setSearch(null)
                    home.navigate('/bot')
                }}
            />
            <ChallengeDialog
                open={home.challengeOpen}
                onClose={() => home.setChallengeOpen(false)}
            />
        </Box>
    )
}

/** The live lobby counters as two right-aligned one-liners (number in text
 * colour, label dimmed) — sits below the leaderboard in the right column. */
export function LobbyStatLines({ stats }: { stats: LobbyStats | null }) {
    return (
        <Box
            sx={{
                display: 'flex',
                flexDirection: 'column',
                alignItems: 'flex-end',
                gap: 0.25,
                px: 0.5,
            }}
        >
            <StatLine value={stats?.playersOnline} label="players online" />
            <StatLine value={stats?.activeGames} label="games in play" />
        </Box>
    )
}

function StatLine({ value, label }: { value?: number; label: string }) {
    return (
        <Typography sx={{ fontSize: 13, lineHeight: 1.6 }}>
            <Box
                component="span"
                sx={{ fontFamily: 'var(--font-mono)', fontWeight: 600, color: 'var(--text)' }}
            >
                {value != null ? value.toLocaleString() : '—'}
            </Box>{' '}
            <Box component="span" sx={{ color: 'var(--text-dim)' }}>
                {label}
            </Box>
        </Typography>
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

/** A slim, full-width row of the four Play actions — sits ABOVE the dashboard
 * grid on desktop so it never lengthens any column (the three columns stay
 * balanced). Same destinations as PlayPanel, laid out horizontally. */
export function PlayBar({
    onNavigate,
    onChallenge,
}: {
    onNavigate: (path: string) => void
    onChallenge: () => void
}) {
    const actions = [
        { icon: <Cpu size={18} />, title: 'Computer', onClick: () => onNavigate('/bot') },
        { icon: <Target size={18} />, title: 'Puzzles', onClick: () => onNavigate('/puzzles') },
        { icon: <Telescope size={18} />, title: 'Analysis', onClick: () => onNavigate('/analysis') },
        { icon: <UserPlus size={18} />, title: 'Challenge', onClick: onChallenge },
    ]
    return (
        <Box
            sx={{
                display: 'grid',
                gridTemplateColumns: 'repeat(4, 1fr)',
                gap: 1.25,
                mb: 2.5,
            }}
        >
            {actions.map((a) => (
                <BarCell key={a.title} icon={a.icon} title={a.title} onClick={a.onClick} />
            ))}
        </Box>
    )
}

/** One horizontal cell of the PlayBar: icon + label side by side, slim height. */
function BarCell({
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
                alignItems: 'center',
                justifyContent: 'center',
                gap: 1,
                py: 1.5,
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
                    fontSize: 13,
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

/** The "Quick pairing" panel: time-control presets + Duck Chess. */
export function QuickPairingPanel({
    onQueue,
}: {
    onQueue: (label: string, pool: string, variant?: Variant) => void
}) {
    const navigate = useNavigate()
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
                    gridAutoRows: '1fr',
                    gap: 0.75,
                }}
            >
                {PRESETS.map((p) => (
                    <TimeCell
                        key={p.time + p.cat}
                        preset={p}
                        onClick={() => onQueue(`${p.cat} · ${p.time}`, p.time)}
                    />
                ))}
            </Box>

            {/* Everything that isn't a standard time control gets its own section +
                grid, so it grows independently as new modes ship without knocking the
                time-control grid off-count. Six cells fill the 3-up (desktop) and 2-up
                (phone) grids exactly. */}
            <Typography
                sx={{
                    mt: '6px',
                    mb: 0.5,
                    fontFamily: 'var(--font-display)',
                    fontSize: 12,
                    fontWeight: 700,
                    letterSpacing: 0.6,
                    textTransform: 'uppercase',
                    color: 'var(--text-dim)',
                }}
            >
                More
            </Typography>
            <Box
                sx={{
                    display: 'grid',
                    gridTemplateColumns: { xs: 'repeat(2, 1fr)', sm: 'repeat(3, 1fr)' },
                    gridAutoRows: '1fr',
                    gap: 0.75,
                }}
            >
                <Chess960Cell
                    onClick={() => onQueue(`Chess960 · ${CHESS960_POOL}`, CHESS960_POOL, 'chess960')}
                />
                <DuckCell onClick={() => onQueue(`Duck Chess · ${DUCK_POOL}`, DUCK_POOL, 'duck')} />
                <CrazyhouseCell
                    onClick={() =>
                        onQueue(`Crazyhouse · ${CRAZYHOUSE_POOL}`, CRAZYHOUSE_POOL, 'crazyhouse')
                    }
                />
                <AntichessCell
                    onClick={() =>
                        onQueue(`Antichess · ${ANTICHESS_POOL}`, ANTICHESS_POOL, 'antichess')
                    }
                />
                <SecretQueenCell
                    onClick={() =>
                        onQueue(
                            `Secret Queen · ${SECRETQUEEN_POOL}`,
                            SECRETQUEEN_POOL,
                            'secretqueen',
                        )
                    }
                />
                <GuessEloCell onClick={() => navigate('/guess-the-elo')} />
            </Box>
        </Panel>
    )
}

/** Guess the Elo — watch an engine game played at a hidden strength and guess the
 * rating. A solo mode that sits in the "More" grid as its own cell: it plays like
 * its own game type, and it's what fills the grid's sixth slot. It has no pool and
 * no rating of its own, so the slot the variant cells give the time control holds
 * the icon instead. */
function GuessEloCell({ onClick }: { onClick: () => void }) {
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
                gap: 0.75,
                py: { xs: 1.75, md: 2 },
                bgcolor: 'var(--surface-2)',
                border: '1px solid var(--line-soft)',
                borderRadius: '12px',
                cursor: 'pointer',
                overflow: 'hidden',
                transition: 'border-color 0.12s ease, background 0.12s ease',
                '&:hover': { borderColor: 'var(--accent-line)', bgcolor: 'var(--surface)' },
            }}
        >
            <Box sx={{ display: 'flex', color: 'var(--text)', height: 26, alignItems: 'center' }}>
                <Gauge size={24} />
            </Box>
            <Box sx={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 0.5 }}>
                <Typography sx={{ fontSize: 12.5, color: 'var(--text-dim)', fontWeight: 500 }}>
                    Guess the Elo
                </Typography>
            </Box>
        </Box>
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
    const open = searching !== null

    // Elapsed-seconds counter, driven by a start timestamp captured when the dialog
    // opens (never a module-scope Date.now()). Reset + ticked while open; cleaned up
    // on close/unmount.
    const [elapsed, setElapsed] = useState(0)
    useEffect(() => {
        if (!open) return
        const start = Date.now()
        setElapsed(0)
        const id = window.setInterval(() => {
            setElapsed(Math.floor((Date.now() - start) / 1000))
        }, 1000)
        return () => window.clearInterval(id)
    }, [open])

    const mm = Math.floor(elapsed / 60)
    const ss = String(elapsed % 60).padStart(2, '0')

    // After a short wait the hub backfills a rating-matched bot, so a game is
    // effectively guaranteed — soften the copy to say so.
    const softened = elapsed >= 10

    return (
        <Dialog
            open={open}
            // Only the explicit Cancel button leaves the queue — a stray backdrop
            // click or Escape must NOT drop us from matchmaking.
            onClose={(_event, reason) => {
                if (reason === 'backdropClick' || reason === 'escapeKeyDown') return
                onCancel()
            }}
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
                    Searching… {mm}:{ss}
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
                        (softened
                            ? "Still searching — we'll add a computer opponent shortly if no one's free."
                            : 'Hang tight while we match you with another player. Prefer not to wait? Play the computer instead.')}
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
    return (
        <GameBanner
            subtitle={`vs ${game.opponent.name} · ${game.pool}${game.opponentOnline ? '' : ' · opponent disconnected'}`}
            onOpen={() => navigate(`/game/${game.id}`)}
        />
    )
}

/** The accent banner pinned above the lobby when a game is waiting for you. */
function GameBanner({ subtitle, onOpen }: { subtitle: string; onOpen: () => void }) {
    return (
        <Box
            onClick={onOpen}
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
                <Typography sx={{ fontSize: 12.5, color: 'var(--text-dim)' }}>{subtitle}</Typography>
            </Box>
            <Box
                component="button"
                onClick={(e) => {
                    e.stopPropagation()
                    onOpen()
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
        eloRange = `${min.toLocaleString('de-DE')}–${max.toLocaleString('de-DE')}`
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
                gap: 0.75,
                py: { xs: 1.75, md: 2 },
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
                    fontSize: { xs: 22, md: 26 },
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

function Chess960Cell({ onClick }: { onClick: () => void }) {
    const { user } = useAuth()

    // Chess960 is its own isolated rating, like Duck/Crazyhouse/Antichess/Secret
    // Queen — it's standard rules, but knowing the position from move one is a
    // different skill, so it doesn't feed the time-control pools.
    let eloRange: string | null = null
    if (user) {
        const rounded = Math.round(user.rating_chess960 / 50) * 50
        eloRange = `${(rounded - 100).toLocaleString('de-DE')}–${(rounded + 100).toLocaleString('de-DE')}`
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
                gap: 0.75,
                py: { xs: 1.75, md: 2 },
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
                    fontSize: { xs: 22, md: 26 },
                    fontWeight: 500,
                    lineHeight: 1,
                    letterSpacing: '-0.01em',
                }}
            >
                {CHESS960_POOL}
            </Typography>
            <Box sx={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 0.5 }}>
                <Box sx={{ display: 'flex', alignItems: 'center', gap: 0.75 }}>
                    <Box component="span" sx={{ display: 'flex', color: 'var(--text-dim)' }}>
                        <Shuffle size={14} />
                    </Box>
                    <Typography sx={{ fontSize: 12.5, color: 'var(--text-dim)', fontWeight: 500 }}>
                        Chess960
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
    const { user } = useAuth()

    // Duck Chess has its own isolated rating — show the same matchmaking Elo range
    // the time-control cells show, from the user's duck rating.
    let eloRange: string | null = null
    if (user) {
        const rounded = Math.round(user.rating_duck / 50) * 50
        eloRange = `${(rounded - 100).toLocaleString('de-DE')}–${(rounded + 100).toLocaleString('de-DE')}`
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
                gap: 0.75,
                py: { xs: 1.75, md: 2 },
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
                    fontSize: { xs: 22, md: 26 },
                    fontWeight: 500,
                    lineHeight: 1,
                    letterSpacing: '-0.01em',
                }}
            >
                {DUCK_POOL}
            </Typography>
            <Box sx={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 0.5 }}>
                <Box sx={{ display: 'flex', alignItems: 'center', gap: 0.75 }}>
                    <Box
                        component="span"
                        sx={{ fontSize: 14, lineHeight: 1, display: 'flex' }}
                        aria-hidden
                    >
                        <DuckGlyph />
                    </Box>
                    <Typography sx={{ fontSize: 12.5, color: 'var(--text-dim)', fontWeight: 500 }}>
                        Duck Chess
                    </Typography>
                </Box>
                {eloRange && (
                    <Typography sx={{ fontSize: 11, color: 'var(--muted)' }}>{eloRange}</Typography>
                )}
            </Box>
        </Box>
    )
}

function CrazyhouseCell({ onClick }: { onClick: () => void }) {
    const { user } = useAuth()

    // Crazyhouse has its own isolated rating — show the same matchmaking Elo range
    // the time-control cells show, from the user's crazyhouse rating.
    let eloRange: string | null = null
    if (user) {
        const rounded = Math.round(user.rating_crazyhouse / 50) * 50
        eloRange = `${(rounded - 100).toLocaleString('de-DE')}–${(rounded + 100).toLocaleString('de-DE')}`
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
                gap: 0.75,
                py: { xs: 1.75, md: 2 },
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
                    fontSize: { xs: 22, md: 26 },
                    fontWeight: 500,
                    lineHeight: 1,
                    letterSpacing: '-0.01em',
                }}
            >
                {CRAZYHOUSE_POOL}
            </Typography>
            <Box sx={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 0.5 }}>
                <Box sx={{ display: 'flex', alignItems: 'center', gap: 0.75 }}>
                    <Box
                        component="span"
                        sx={{ fontSize: 14, lineHeight: 1, display: 'flex' }}
                        aria-hidden
                    >
                        ⇄
                    </Box>
                    <Typography sx={{ fontSize: 12.5, color: 'var(--text-dim)', fontWeight: 500 }}>
                        Crazyhouse
                    </Typography>
                </Box>
                {eloRange && (
                    <Typography sx={{ fontSize: 11, color: 'var(--muted)' }}>{eloRange}</Typography>
                )}
            </Box>
        </Box>
    )
}

function AntichessCell({ onClick }: { onClick: () => void }) {
    const { user } = useAuth()

    // Antichess has its own isolated rating — show the same matchmaking Elo range
    // the time-control cells show, from the user's antichess rating.
    let eloRange: string | null = null
    if (user) {
        const rounded = Math.round(user.rating_antichess / 50) * 50
        eloRange = `${(rounded - 100).toLocaleString('de-DE')}–${(rounded + 100).toLocaleString('de-DE')}`
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
                gap: 0.75,
                py: { xs: 1.75, md: 2 },
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
                    fontSize: { xs: 22, md: 26 },
                    fontWeight: 500,
                    lineHeight: 1,
                    letterSpacing: '-0.01em',
                }}
            >
                {ANTICHESS_POOL}
            </Typography>
            <Box sx={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 0.5 }}>
                <Box sx={{ display: 'flex', alignItems: 'center', gap: 0.75 }}>
                    <Box component="span" sx={{ display: 'flex', color: 'var(--text-dim)' }}>
                        <Skull size={14} />
                    </Box>
                    <Typography sx={{ fontSize: 12.5, color: 'var(--text-dim)', fontWeight: 500 }}>
                        Antichess
                    </Typography>
                </Box>
                {eloRange && (
                    <Typography sx={{ fontSize: 11, color: 'var(--muted)' }}>{eloRange}</Typography>
                )}
            </Box>
        </Box>
    )
}

function SecretQueenCell({ onClick }: { onClick: () => void }) {
    const { user } = useAuth()

    // Secret Queen has its own isolated rating, like Duck/Crazyhouse/Antichess —
    // show the same matchmaking Elo range the time-control cells show.
    let eloRange: string | null = null
    if (user) {
        const rounded = Math.round(user.rating_secretqueen / 50) * 50
        eloRange = `${(rounded - 100).toLocaleString('de-DE')}\u2013${(rounded + 100).toLocaleString('de-DE')}`
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
                gap: 0.75,
                py: { xs: 1.75, md: 2 },
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
                    fontSize: { xs: 22, md: 26 },
                    fontWeight: 500,
                    lineHeight: 1,
                    letterSpacing: '-0.01em',
                }}
            >
                {SECRETQUEEN_POOL}
            </Typography>
            <Box sx={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 0.5 }}>
                <Box sx={{ display: 'flex', alignItems: 'center', gap: 0.75 }}>
                    <Box component="span" sx={{ display: 'flex', color: 'var(--text-dim)' }}>
                        <Crown size={14} />
                    </Box>
                    <Typography sx={{ fontSize: 12.5, color: 'var(--text-dim)', fontWeight: 500 }}>
                        Secret Queen
                    </Typography>
                </Box>
                {eloRange && (
                    <Typography sx={{ fontSize: 11, color: 'var(--muted)' }}>{eloRange}</Typography>
                )}
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

