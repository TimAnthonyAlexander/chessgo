import { useEffect, useState } from 'react'
import { Box, Typography } from '@mui/material'
import { useNavigate } from 'react-router-dom'
import { Panel, PanelHead } from './Panel'
import SkeletonBar from './SkeletonBar'
import { EMPTY_FEN, STRIP_H } from './boardCard'
import MiniBoard from '../MiniBoard'
import { getLiveGames, type LiveGameSummary, type LiveSide } from '../../api/client'
import { categoryFor } from '../../lib/timeControl'

const POLL_MS = 6000
// The very first /watch poll is also what wakes the hub's JIT filler pool
// (it stamps lastWatchActivity), so an empty first response is expected while
// those engine-vs-engine games spin up. Retry a few times on a short backoff
// before falling back to "no live games", so the card warms up instead of
// blanking out on load. The steady POLL_MS loop is the longer-term backstop.
const WARMUP_BACKOFF_MS = [0, 1200, 2600]
const STATUS_GREEN = 'var(--live)'

/** mm:ss from a millisecond clock value (clamped at zero). */
function formatClock(ms: number): string {
    const total = Math.max(0, Math.floor(ms / 1000))
    const mm = Math.floor(total / 60)
    const ss = total % 60
    return `${mm}:${String(ss).padStart(2, '0')}`
}

/** One player strip (name + rating on the left, clock on the right). The side
 * to move gets a subtle accent dot before the name. Fixed height so it lines up
 * with the Daily-puzzle card's strips. */
function PlayerStrip({
    side,
    clockMs,
    toMove,
}: {
    side: LiveSide
    clockMs: number
    toMove: boolean
}) {
    return (
        <Box
            sx={{
                height: STRIP_H,
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'space-between',
                gap: 1,
                px: 1,
            }}
        >
            <Box sx={{ display: 'flex', alignItems: 'center', gap: 0.75, minWidth: 0 }}>
                <Box
                    sx={{
                        width: 7,
                        height: 7,
                        borderRadius: '50%',
                        flexShrink: 0,
                        bgcolor: toMove ? 'var(--accent)' : 'var(--line)',
                    }}
                />
                <Typography
                    sx={{
                        fontSize: 14,
                        fontWeight: 600,
                        color: 'var(--text)',
                        overflow: 'hidden',
                        textOverflow: 'ellipsis',
                        whiteSpace: 'nowrap',
                    }}
                >
                    {side.anon ? 'Anonymous' : side.name}
                </Typography>
                <Typography
                    sx={{
                        fontFamily: 'var(--font-mono)',
                        fontSize: 12,
                        color: 'var(--text-dim)',
                        flexShrink: 0,
                    }}
                >
                    {side.rating}
                </Typography>
            </Box>
            <Typography
                sx={{
                    fontFamily: 'var(--font-mono)',
                    fontSize: 15,
                    fontWeight: 600,
                    color: toMove ? 'var(--text)' : 'var(--text-dim)',
                    flexShrink: 0,
                }}
            >
                {formatClock(clockMs)}
            </Typography>
        </Box>
    )
}

/** Loading placeholder for a player strip: a name bar + a clock bar, same fixed
 * height as PlayerStrip so the board doesn't shift when the real data lands. */
function SkeletonStrip() {
    return (
        <Box
            sx={{
                height: STRIP_H,
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'space-between',
                gap: 1,
                px: 1,
            }}
        >
            <Box sx={{ display: 'flex', alignItems: 'center', gap: 0.75, minWidth: 0 }}>
                <Box
                    sx={{
                        width: 7,
                        height: 7,
                        borderRadius: '50%',
                        flexShrink: 0,
                        bgcolor: 'var(--line)',
                    }}
                />
                <SkeletonBar w={96} />
            </Box>
            <SkeletonBar w={40} h={13} />
        </Box>
    )
}

/** Homepage "featured live game" TV widget: polls the Watch lobby and shows the
 * single top game with an auto-updating preview board. While loading it renders
 * an empty board plus player-strip skeletons — the board never late-pops, only
 * the pieces appear on load. Click → /watch. */
export default function LiveTvWidget() {
    const navigate = useNavigate()
    const [game, setGame] = useState<LiveGameSummary | null>(null)
    const [loading, setLoading] = useState(true)

    useEffect(() => {
        let alive = true
        let intervalId: number | undefined
        let timeoutId: number | undefined

        // One fetch. Returns the top game, or null on empty/transient error so
        // the caller decides whether to retry or fall back.
        const fetchTop = async (): Promise<LiveGameSummary | null> => {
            try {
                const res = await getLiveGames()
                return res.games[0] ?? null
            } catch {
                return null
            }
        }

        // Initial warm-up: retry an empty result a couple of times (the first
        // poll is what triggers filler creation) before showing the empty
        // state. As soon as any attempt returns a game we render it.
        const warmUp = async () => {
            for (const delay of WARMUP_BACKOFF_MS) {
                if (!alive) return
                if (delay > 0) {
                    await new Promise<void>((resolve) => {
                        timeoutId = window.setTimeout(resolve, delay)
                    })
                    if (!alive) return
                }
                const top = await fetchTop()
                if (!alive) return
                if (top) {
                    setGame(top)
                    setLoading(false)
                    return
                }
            }
            // Exhausted the warm-up attempts with nothing to show yet — reveal
            // the empty state; the steady poll below still keeps trying.
            if (alive) setLoading(false)
        }

        // Steady-state poll keeps the featured game fresh and keeps the hub's
        // watch window alive (so fillers keep flowing while we're on screen).
        const startPolling = () => {
            intervalId = window.setInterval(async () => {
                const top = await fetchTop()
                if (alive) setGame(top)
            }, POLL_MS)
        }

        void warmUp()
        startPolling()

        return () => {
            alive = false
            if (intervalId) window.clearInterval(intervalId)
            if (timeoutId) window.clearTimeout(timeoutId)
        }
    }, [])

    const sub = game ? `${categoryFor(game.pool)} · ${game.pool}` : 'Top game in play'

    const head = (
        <PanelHead
            title="Live now"
            sub={sub}
            action={
                <Box sx={{ display: 'flex', alignItems: 'center', gap: 0.75 }}>
                    <Box
                        sx={{
                            width: 9,
                            height: 9,
                            borderRadius: '50%',
                            bgcolor: STATUS_GREEN,
                            boxShadow: `0 0 0 0 ${STATUS_GREEN}`,
                            animation: 'liveTvPulse 1.8s ease-out infinite',
                            '@keyframes liveTvPulse': {
                                '0%': { boxShadow: `0 0 0 0 ${STATUS_GREEN}66` },
                                '70%': { boxShadow: `0 0 0 6px ${STATUS_GREEN}00` },
                                '100%': { boxShadow: `0 0 0 0 ${STATUS_GREEN}00` },
                            },
                        }}
                    />
                    <Typography
                        sx={{
                            fontFamily: 'var(--font-mono)',
                            fontSize: 11,
                            letterSpacing: '0.14em',
                            color: STATUS_GREEN,
                            fontWeight: 700,
                        }}
                    >
                        LIVE
                    </Typography>
                </Box>
            }
        />
    )

    // Terminal "nothing playing" state (warm-up exhausted, no game). Rare on the
    // homepage since the /watch poll wakes fillers, but handled explicitly.
    if (!loading && !game) {
        return (
            <Panel>
                {head}
                <Typography
                    sx={{ fontSize: 13, color: 'var(--muted)', textAlign: 'center', py: 6 }}
                >
                    No live games right now
                </Typography>
            </Panel>
        )
    }

    const goWatch = () => navigate('/watch')

    // The board frame — empty board + skeleton strips while loading, real game
    // once it lands. Structurally identical so only the pieces/text swap in.
    const boardFrame = (
        <Box
            sx={{
                border: '1px solid var(--line-soft)',
                borderRadius: '10px',
                overflow: 'hidden',
                bgcolor: 'var(--surface-2)',
            }}
        >
            {game ? (
                <PlayerStrip
                    side={game.black}
                    clockMs={game.clockB}
                    toMove={game.sideToMove === 'b'}
                />
            ) : (
                <SkeletonStrip />
            )}
            <MiniBoard
                fen={game ? game.fen : EMPTY_FEN}
                lastMove={game ? game.lastMove || undefined : undefined}
                orientation="w"
            />
            {game ? (
                <PlayerStrip
                    side={game.white}
                    clockMs={game.clockW}
                    toMove={game.sideToMove === 'w'}
                />
            ) : (
                <SkeletonStrip />
            )}
        </Box>
    )

    // Loading: not yet clickable (no destination context). Show head + frame.
    if (!game) {
        return (
            <Panel>
                {head}
                {boardFrame}
            </Panel>
        )
    }

    return (
        <Panel
            sx={{
                cursor: 'pointer',
                transition: 'border-color 0.12s ease',
                '&:hover': { borderColor: 'var(--accent-line)' },
            }}
        >
            <Box
                role="button"
                tabIndex={0}
                onClick={goWatch}
                onKeyDown={(e) => {
                    if (e.key === 'Enter' || e.key === ' ') {
                        e.preventDefault()
                        goWatch()
                    }
                }}
                sx={{ outline: 'none' }}
            >
                {head}
                {boardFrame}
            </Box>
        </Panel>
    )
}
