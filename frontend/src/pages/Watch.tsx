import { useEffect, useState } from 'react'
import { Box, CircularProgress, Typography } from '@mui/material'
import { Eye, Radio } from 'lucide-react'
import { useNavigate } from 'react-router-dom'
import MiniBoard from '../components/MiniBoard'
import EvalBar, { type WhiteEval } from '../components/EvalBar'
import TitleBadge from '../components/TitleBadge'
import { analyze, getLiveGames, type LiveGameSummary, type LiveSide } from '../api/client'
import { useAuth } from '../lib/auth'

const POLL_MS = 2500 // steady cadence once games are flowing
const WARM_MS = 700 // fast cadence while the lobby is still warming up
// The hub spawns its self-play fillers lazily, and the very first /watch poll is
// what wakes that pool — so the first few responses arrive with 0..max-1 games
// while the engine-vs-engine games spin up. We keep polling fast and hold the
// spinner until the lobby is *full* (games.length >= max), so a fresh page load
// reveals all `max` games at once instead of a partial set the user has to
// refresh away. This budget caps the warm-up so a lobby that genuinely can't
// reach `max` still reveals whatever it has.
const WARM_MAX_POLLS = 10

export default function Watch() {
    const navigate = useNavigate()
    const { user } = useAuth()
    // Admins get a full-strength eval bar on each card; everyone else sees the
    // board as-is (no analyze traffic for ordinary spectators).
    const isAdmin = user?.role === 'admin'
    const [games, setGames] = useState<LiveGameSummary[] | null>(null)
    const [max, setMax] = useState(5)
    // We hold a spinner (rather than a partial or empty grid) until the lobby is
    // "settled": either full (games.length >= max) or the warm-up budget is spent.
    // This guarantees a fresh load reveals all `max` games at once instead of the
    // 0/3 partial the first poll returns while fillers spin up.
    const [settled, setSettled] = useState(false)

    // Poll the lobby. The request itself signals the hub that someone is watching,
    // which is what spins up the filler games; so we poll fast while warming, then
    // settle to a steady cadence once the lobby is full.
    useEffect(() => {
        let cancelled = false
        let timer = 0
        // Closure-local so the cadence decision is synchronous (setSettled is
        // async, so reading `settled` state here would be stale). Once true we're
        // in steady state and reveal every response as-is.
        let done = false
        let polls = 0

        const poll = () => {
            getLiveGames()
                .then((r) => {
                    if (cancelled) return
                    setGames(r.games)
                    setMax(r.max)
                    if (!done) {
                        polls += 1
                        const full = r.games.length >= r.max
                        const exhausted = polls >= WARM_MAX_POLLS
                        if (full || exhausted) {
                            done = true
                            setSettled(true)
                        }
                    }
                    timer = window.setTimeout(poll, done ? POLL_MS : WARM_MS)
                })
                .catch(() => {
                    if (!cancelled) timer = window.setTimeout(poll, done ? POLL_MS : WARM_MS)
                })
        }
        poll()
        return () => {
            cancelled = true
            window.clearTimeout(timer)
        }
    }, [])

    // Spinner until the lobby settles (full, or warm-up exhausted); the "no games"
    // text only once settled with genuinely nothing to show.
    const loading = !settled
    const empty = settled && games != null && games.length === 0

    return (
        <Box sx={{ position: 'relative', flex: 1, overflow: 'hidden' }}>
            <Box
                aria-hidden
                sx={{
                    position: 'absolute',
                    inset: 0,
                    pointerEvents: 'none',
                    background:
                        'radial-gradient(ellipse 70% 50% at 50% -8%, rgba(216,166,87,0.08), transparent 62%)',
                }}
            />
            <Box
                sx={{
                    position: 'relative',
                    maxWidth: 1200,
                    mx: 'auto',
                    px: { xs: 2, md: 3 },
                    py: { xs: 3, md: 5 },
                }}
            >
                {/* Header */}
                <Box sx={{ mb: { xs: 3, md: 4 } }}>
                    <Box sx={{ display: 'flex', alignItems: 'center', gap: 1, mb: 1.25 }}>
                        <Box sx={{ display: 'flex', color: 'var(--accent)' }}>
                            <Radio size={15} />
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
                            Live now
                        </Typography>
                    </Box>
                    <Typography
                        sx={{
                            fontFamily: 'var(--font-display)',
                            fontWeight: 700,
                            fontSize: { xs: 30, md: 40 },
                            lineHeight: 1.05,
                            letterSpacing: '-0.02em',
                        }}
                    >
                        Watch
                    </Typography>
                    <Typography
                        sx={{
                            mt: 1,
                            fontSize: { xs: 14, md: 15 },
                            color: 'var(--text-dim)',
                            maxWidth: 560,
                        }}
                    >
                        The {max} most notable games in play right now. Click any board to spectate
                        live, move by move.
                    </Typography>
                </Box>

                {/* Grid */}
                {loading ? (
                    <Placeholder spinner text="Loading live games…" />
                ) : empty ? (
                    <Placeholder text="No live games right now. Check back in a bit." />
                ) : (
                    <Box
                        sx={{
                            display: 'grid',
                            gridTemplateColumns: {
                                xs: '1fr',
                                sm: 'repeat(2, 1fr)',
                                lg: 'repeat(3, 1fr)',
                            },
                            gap: { xs: 2, md: 2.5 },
                        }}
                    >
                        {(games ?? []).map((g) => (
                            <GameCard
                                key={g.id}
                                game={g}
                                showEval={isAdmin}
                                onClick={() => navigate(`/watch/${g.id}`)}
                            />
                        ))}
                    </Box>
                )}
            </Box>
        </Box>
    )
}

function Placeholder({ text, spinner }: { text: string; spinner?: boolean }) {
    return (
        <Box
            sx={{
                display: 'flex',
                flexDirection: 'column',
                alignItems: 'center',
                justifyContent: 'center',
                gap: 2,
                minHeight: 200,
                borderRadius: '16px',
                border: '1px dashed var(--line)',
                color: 'var(--muted)',
                textAlign: 'center',
                px: 3,
            }}
        >
            {spinner && <CircularProgress size={26} sx={{ color: 'var(--accent)' }} />}
            <Typography sx={{ fontSize: 14 }}>{text}</Typography>
        </Box>
    )
}

function GameCard({
    game,
    showEval,
    onClick,
}: {
    game: LiveGameSummary
    showEval: boolean
    onClick: () => void
}) {
    const whiteActive = game.sideToMove === 'w' && game.ply >= 2
    const blackActive = game.sideToMove === 'b' && game.ply >= 2

    // Admin-only eval: re-read the position (full strength, snappy 300ms) whenever
    // this card's FEN changes — i.e. only when a move lands, not on every poll.
    // The engine reports from the side-to-move's view, so flip to White's.
    const [whiteEval, setWhiteEval] = useState<WhiteEval | null>(null)
    useEffect(() => {
        if (!showEval) return
        let cancelled = false
        const ctrl = new AbortController()
        analyze(game.fen, { movetime: 300, signal: ctrl.signal })
            .then((r) => {
                if (cancelled || !r.eval) return
                const white = game.sideToMove === 'w' ? r.eval.value : -r.eval.value
                setWhiteEval({ type: r.eval.type, white })
            })
            .catch(() => {}) // aborted / transient failure → keep last shown eval
        return () => {
            cancelled = true
            ctrl.abort()
        }
    }, [game.fen, game.sideToMove, showEval])

    const timeControl = game.pool
    const label = `${game.white.name} vs ${game.black.name}, ${timeControl}`

    return (
        <Box
            onClick={onClick}
            role="button"
            tabIndex={0}
            aria-label={label}
            onKeyDown={(e) => {
                if (e.key === 'Enter' || e.key === ' ') {
                    e.preventDefault()
                    onClick()
                }
            }}
            sx={{
                position: 'relative',
                bgcolor: 'var(--surface)',
                border: '1px solid var(--line-soft)',
                borderRadius: '16px',
                p: 1.5,
                cursor: 'pointer',
                boxShadow: '0 18px 50px -30px rgba(0,0,0,0.8)',
                transition: 'transform .12s ease, border-color .12s ease',
                '&:hover': { transform: 'translateY(-2px)', borderColor: 'var(--accent-line)' },
                '&:hover .watch-cta': { opacity: 1 },
                '&:focus-visible': { outline: '2px solid #5a6bd8', outlineOffset: '2px' },
            }}
        >
            <PlayerRow side={game.black} ms={game.clockB} active={blackActive} />
            <Box sx={{ my: 0.75, display: 'flex', gap: 0.75 }}>
                {showEval && <EvalBar ev={whiteEval} orientation="w" />}
                <Box sx={{ position: 'relative', flex: 1, minWidth: 0 }}>
                    <MiniBoard fen={game.fen} lastMove={game.lastMove} />
                    <Box
                        className="watch-cta"
                        sx={{
                            position: 'absolute',
                            inset: 0,
                            display: 'flex',
                            alignItems: 'center',
                            justifyContent: 'center',
                            opacity: 0,
                            transition: 'opacity .12s ease',
                            background: 'rgba(10,11,14,0.32)',
                            borderRadius: '8px',
                            pointerEvents: 'none',
                        }}
                    >
                        <Box
                            sx={{
                                display: 'flex',
                                alignItems: 'center',
                                gap: 0.75,
                                px: 1.5,
                                py: 0.75,
                                borderRadius: '999px',
                                bgcolor: 'var(--accent)',
                                color: '#15171c',
                                fontFamily: 'var(--font-display)',
                                fontWeight: 700,
                                fontSize: 12.5,
                            }}
                        >
                            <Eye size={14} /> Spectate
                        </Box>
                    </Box>
                </Box>
            </Box>
            <PlayerRow side={game.white} ms={game.clockW} active={whiteActive} />

            <Box sx={{ display: 'flex', alignItems: 'center', gap: 1, mt: 1, px: 0.25 }}>
                <Typography
                    sx={{
                        fontFamily: 'var(--font-mono)',
                        fontSize: 11.5,
                        color: 'var(--text-dim)',
                    }}
                >
                    {game.pool}
                </Typography>
                <Typography
                    sx={{
                        ml: 'auto',
                        fontSize: 9.5,
                        fontWeight: 700,
                        letterSpacing: '0.1em',
                        textTransform: 'uppercase',
                        color: game.rated ? 'var(--accent)' : 'var(--muted)',
                    }}
                >
                    {game.rated ? 'Rated' : 'Casual'}
                </Typography>
            </Box>
        </Box>
    )
}

function PlayerRow({ side, ms, active }: { side: LiveSide; ms: number; active: boolean }) {
    return (
        <Box sx={{ display: 'flex', alignItems: 'center', gap: 1, px: 0.5, py: 0.25, minWidth: 0 }}>
            <Box sx={{ display: 'flex', alignItems: 'center', gap: 0.5, minWidth: 0 }}>
                <TitleBadge title={side.title} />
                <Typography
                    sx={{ fontFamily: 'var(--font-display)', fontWeight: 600, fontSize: 13.5 }}
                    noWrap
                >
                    {side.name}
                </Typography>
            </Box>
            {!side.anon && (
                <Typography
                    sx={{
                        fontFamily: 'var(--font-mono)',
                        fontSize: 11.5,
                        color: 'var(--text-dim)',
                    }}
                >
                    {side.rating}
                </Typography>
            )}
            <Box
                sx={{
                    ml: 'auto',
                    fontFamily: 'var(--font-mono)',
                    fontSize: 13,
                    fontWeight: 600,
                    px: 0.9,
                    py: 0.2,
                    borderRadius: '6px',
                    color: active ? 'var(--text)' : 'var(--text-dim)',
                    bgcolor: active ? 'var(--surface-2)' : 'transparent',
                    border: '1px solid',
                    borderColor: active ? 'var(--accent-line)' : 'transparent',
                }}
            >
                {formatClock(ms)}
            </Box>
        </Box>
    )
}

function formatClock(ms: number): string {
    const total = Math.max(0, Math.floor(ms / 1000))
    const mins = Math.floor(total / 60)
    const secs = total - mins * 60
    return `${mins}:${secs.toString().padStart(2, '0')}`
}
