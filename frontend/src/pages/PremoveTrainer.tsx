import { useEffect, useRef, useState } from 'react'
import { Box } from '@mui/material'
import Board from '../components/Board'
import BoardPage from '../components/BoardPage'
import {
    ApiError,
    createPremoveGame,
    getPremoveGame,
    type PremoveFormat,
    type PremoveGame,
    type PremoveReleaseResult,
    releasePremoveChain,
} from '../api/client'
import { useBoardInteraction } from '../lib/useBoardInteraction'
import { playForSan, setSoundEnabled, soundEnabled, sounds } from '../lib/sounds'
import { authStore } from '../lib/auth'
import type { Phase } from '../components/premove/PremoveUI'
import { PlayingAside, StatusCard } from '../components/premove/PremoveStatus'
import { SetupAside, SetupCard } from '../components/premove/PremoveSetup'

const START_FEN = 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1'

// Fed to useBoardInteraction verbatim per the contract (§4): `myTurn: false`
// keeps the fire effect from ever running, so the chain accumulates in
// interaction.premoves instead of auto-playing. `submit` is never called.
const NO_MOVES: string[] = []
const noop = () => {}

// The chain cap comes from the server on every response (`max_chain`) and is
// deliberately NOT mirrored here. A hardcoded copy drifted below the server's
// value and capped players at 12 while the server allowed 20 — the same trap
// `ply_ms` is sent to avoid. This fallback only covers the first render before
// a game exists, where nothing is queueable anyway.
const MAX_CHAIN_FALLBACK = 20

interface Mark {
    from: string
    to: string
}
const splitUci = (uci: string): Mark => ({ from: uci.slice(0, 2), to: uci.slice(2, 4) })

const FORMAT_KEY = 'chessgo.premoveFormat'
function readFormat(): PremoveFormat {
    try {
        const v = localStorage.getItem(FORMAT_KEY)
        if (v === 'rated' || v === 'casual') return v
    } catch {
        /* ignore */
    }
    return 'rated'
}
function storeFormat(f: PremoveFormat): void {
    try {
        localStorage.setItem(FORMAT_KEY, f)
    } catch {
        /* ignore */
    }
}

// Best consecutive-win streak, persisted across sessions — same shape as
// Puzzles.tsx's chessgo.puzzleStreak (current streak is session-only state).
const STREAK_KEY = 'chessgo.premoveStreak'
function readBestStreak(): number {
    try {
        const v = Number(localStorage.getItem(STREAK_KEY))
        return Number.isFinite(v) && v > 0 ? Math.floor(v) : 0
    } catch {
        return 0
    }
}
function storeBestStreak(v: number): void {
    try {
        localStorage.setItem(STREAK_KEY, String(Math.max(0, Math.floor(v))))
    } catch {
        /* ignore */
    }
}

export default function PremoveTrainer() {
    const [format, setFormat] = useState<PremoveFormat>(readFormat)
    const [game, setGame] = useState<PremoveGame | null>(null)
    const [phase, setPhase] = useState<Phase>('queuing')
    // The rendered position. Equals `game.fen` at rest; stepped ply-by-ply
    // across the server's `playout` while animating (§5/§9 — always at the
    // server's `ply_ms`, never a local guess).
    const [fen, setFen] = useState(START_FEN)
    const [lastMove, setLastMove] = useState<Mark | null>(null)
    // Only set once an attempt is actually over — carries `collapsed_at` for
    // the "chain broke at move K" result line.
    const [resultData, setResultData] = useState<PremoveReleaseResult | null>(null)
    const [creating, setCreating] = useState(false)
    const [error, setError] = useState<string | null>(null)
    const [sound, setSound] = useState(soundEnabled())
    const [streak, setStreak] = useState(0)
    const [bestStreak, setBestStreak] = useState(readBestStreak)
    // Set when a rated release leaves the attempt ONGOING — the collapse-and-
    // recover moment (contract §5 step 3). The board has just changed and the
    // clock is running again; without saying so the player has to work out from
    // scratch why it's their turn. Cleared the moment they start a new release.
    const [lastBreak, setLastBreak] = useState<{ collapsedAt: number | null } | null>(null)

    // Timers for the staged playout animation — same later()/clearTimers()
    // shape as Puzzles.tsx, so a route change or unmount can't fire a stale
    // step into an unmounted page.
    const timers = useRef<ReturnType<typeof setTimeout>[]>([])
    const clearTimers = () => {
        timers.current.forEach(clearTimeout)
        timers.current = []
    }
    const later = (fn: () => void, ms: number) => {
        timers.current.push(setTimeout(fn, ms))
    }
    useEffect(() => clearTimers, [])

    // Guards against a double release firing (e.g. a keydown AND the GO
    // button's own native click-on-Enter both landing for the same press).
    const releasingRef = useRef(false)

    // The one board controller for the whole page (contract §4). `fen` here is
    // whatever's currently rendered, so the premove overlay always folds onto
    // the right base position; it's only ever actually shown to the player
    // while `phase === 'queuing'` (see the render below).
    const interaction = useBoardInteraction({
        fen,
        myTurn: false,
        legalMoves: NO_MOVES,
        submit: noop,
        canPremove: true,
    })

    function toggleSound() {
        const next = !sound
        setSound(next)
        setSoundEnabled(next)
        if (next) sounds.move()
    }

    async function startGame(f: PremoveFormat) {
        clearTimers()
        setError(null)
        setCreating(true)
        try {
            const g = await createPremoveGame(f)
            interaction.cancelPremove()
            setGame(g)
            setFen(g.fen)
            setLastMove(null)
            setResultData(null)
            setLastBreak(null)
            setPhase('queuing')
        } catch (e) {
            setError(
                e instanceof ApiError && e.status === 503
                    ? 'No position available right now. Try again in a moment.'
                    : e instanceof Error
                      ? e.message
                      : 'Could not start an attempt.',
            )
        } finally {
            setCreating(false)
        }
    }

    // Drop the current attempt and return to the format picker. Casual games
    // are already a single shot; a rated game left mid-chain is simply
    // abandoned client-side (there's nothing to undo — nothing was released).
    function changeFormat() {
        clearTimers()
        interaction.cancelPremove()
        setGame(null)
        setResultData(null)
        setLastBreak(null)
        setError(null)
        setPhase('queuing')
    }

    function nextAttempt() {
        if (creating) return
        void startGame(format)
    }

    function extendStreak() {
        setStreak((s) => {
            const next = s + 1
            setBestStreak((best) => {
                if (next <= best) return best
                storeBestStreak(next)
                return next
            })
            return next
        })
    }

    // Land a resolved release: either the attempt is over (rate it into the
    // streak, refresh the account's rating), or — a rated collapse — the game
    // stays ongoing and the clock resumes (contract §5 step 3).
    function settleRelease(res: PremoveReleaseResult) {
        setGame(res)
        if (res.status === 'ongoing') {
            setLastBreak({ collapsedAt: res.collapsed_at })
            setPhase('queuing')
            return
        }
        setLastBreak(null)
        setResultData(res)
        if (res.status === 'won') extendStreak()
        else setStreak(0)
        if (res.rating) void authStore.refresh()
        setPhase('result')
    }

    // Animate the server's playout at ITS ply_ms (never a local constant —
    // see the contract's critical-correctness point 1: the server's clock
    // future-stamp already assumes exactly this cadence). An immediate
    // collapse (the first submitted move was already illegal) carries an
    // empty playout — nothing to animate.
    function animateAndSettle(res: PremoveReleaseResult) {
        setPhase('animating')
        const plies = res.playout
        if (plies.length === 0) {
            settleRelease(res)
            return
        }
        plies.forEach((p, i) => {
            later(
                () => {
                    setFen(p.fen)
                    setLastMove(splitUci(p.uci))
                    const isLast = i === plies.length - 1
                    playForSan(p.san, isLast && res.status !== 'ongoing')
                    if (isLast) settleRelease(res)
                },
                (i + 1) * res.ply_ms,
            )
        })
    }

    async function releaseChain() {
        if (!game || phase !== 'queuing' || interaction.premoves.length === 0) return
        if (releasingRef.current) return
        releasingRef.current = true
        const chain = interaction.premoves.map((p) => p.from + p.to)
        setError(null)
        setLastBreak(null)
        setPhase('releasing')
        try {
            const res = await releasePremoveChain(game.id, chain)
            interaction.cancelPremove()
            animateAndSettle(res)
        } catch (e) {
            if (e instanceof ApiError && e.status === 0) {
                // Network failure — we genuinely don't know if the release
                // landed server-side. Resync from the source of truth instead
                // of guessing (the contract's own GET endpoint is exactly
                // for this: "current state ... for refresh and resume").
                try {
                    const fresh = await getPremoveGame(game.id)
                    interaction.cancelPremove()
                    setGame(fresh)
                    setFen(fresh.fen)
                    setLastMove(null)
                    if (fresh.status === 'ongoing') {
                        setLastBreak({ collapsedAt: null })
                        setPhase('queuing')
                    } else {
                        setResultData({ ...fresh, playout: [], collapsed_at: null })
                        if (fresh.status === 'won') extendStreak()
                        else setStreak(0)
                        if (fresh.rating) void authStore.refresh()
                        setPhase('result')
                    }
                } catch {
                    setError("Lost contact with the server. Press GO again once you're back online.")
                    setPhase('queuing')
                }
            } else {
                setError(e instanceof Error ? e.message : 'Release failed.')
                setPhase('queuing')
            }
        } finally {
            releasingRef.current = false
        }
    }

    // Release is bound to GO, Enter and Space (contract §4).
    useEffect(() => {
        const onKey = (e: KeyboardEvent) => {
            if (e.key !== 'Enter' && e.key !== ' ') return
            if (!game || phase !== 'queuing' || interaction.premoves.length === 0) return
            e.preventDefault()
            void releaseChain()
        }
        window.addEventListener('keydown', onKey)
        return () => window.removeEventListener('keydown', onKey)
    })

    const maxChain = game?.max_chain ?? MAX_CHAIN_FALLBACK

    // A board move intent while queuing: append to the chain, capped at the
    // server's max_chain (silently — the button/counter already show the cap).
    function handleBoardMove(uci: string) {
        if (interaction.premoves.length >= maxChain) return
        interaction.onMove(uci)
    }

    const mateInN =
        game && game.status === 'won' ? game.moves.filter((m) => m.by === 'player').length : null

    if (!game) {
        return (
            <BoardPage
                rightFit
                leftFit
                left={
                    <Box sx={{ display: { xs: 'none', md: 'block' } }}>
                        <SetupAside bestStreak={bestStreak} />
                    </Box>
                }
                right={
                    <SetupCard
                        format={format}
                        creating={creating}
                        error={error}
                        onFormat={(f) => {
                            setFormat(f)
                            storeFormat(f)
                        }}
                        onStart={() => void startGame(format)}
                    />
                }
            >
                <Board
                    fen={START_FEN}
                    orientation="w"
                    sideToMove="w"
                    legalMoves={[]}
                    lastMove={null}
                    interactive={false}
                    onMove={() => {}}
                />
            </BoardPage>
        )
    }

    const queuing = phase === 'queuing'

    return (
        <BoardPage
            rightFit
            left={
                <Box sx={{ display: { xs: 'none', md: 'block' } }}>
                    <PlayingAside game={game} streak={streak} bestStreak={bestStreak} />
                </Box>
            }
            right={
                <StatusCard
                    phase={phase}
                    game={game}
                    resultData={resultData}
                    mateInN={mateInN}
                    queuedCount={interaction.premoves.length}
                    maxChain={maxChain}
                    lastBreak={lastBreak}
                    error={error}
                    sound={sound}
                    streak={streak}
                    bestStreak={bestStreak}
                    creating={creating}
                    onToggleSound={toggleSound}
                    onRelease={() => void releaseChain()}
                    onNext={nextAttempt}
                    onChangeFormat={changeFormat}
                />
            }
        >
            <Board
                fen={fen}
                orientation={game.player_color}
                sideToMove={game.side_to_move}
                legalMoves={[]}
                lastMove={lastMove}
                interactive={false}
                onMove={queuing ? handleBoardMove : () => {}}
                premoveColor={queuing ? game.player_color : null}
                premoves={queuing ? interaction.premoves : null}
                onCancelPremove={interaction.cancelPremove}
                {...(queuing && interaction.override ? { overrideBoard: interaction.override } : {})}
            />
        </BoardPage>
    )
}
