import { useEffect, useMemo, useRef, useState } from 'react'
import { Box, Button, Typography } from '@mui/material'
import { Check, Flag, Handshake, Undo2, User, Volume2, VolumeX, X } from 'lucide-react'
import { useNavigate } from 'react-router-dom'
import Board from '../components/Board'
import BoardPage from '../components/BoardPage'
import ChatPanel from '../components/ChatPanel'
import Clock from '../components/Clock'
import LiveModeCard from '../components/LiveModeCard'
import MoveList from '../components/MoveList'
import { ActionBtn, Avatar, NavBtn, PANEL_SHADOW } from '../components/PanelUI'
import type { MoveEntry } from '../api/client'
import { type Color, gameSocket, type LiveGameState, liveRemaining } from '../lib/socket'
import { useGameSocket } from '../lib/useGameSocket'
import { useBoardInteraction } from '../lib/useBoardInteraction'
import { useDuckInteraction } from '../lib/useDuckInteraction'
import { useMoveNavKeys } from '../lib/useMoveNavKeys'
import { applyUciVisually, type BoardMap, parseFen } from '../lib/chess'
import { playForSan, setSoundEnabled, soundEnabled, sounds } from '../lib/sounds'
import { VARIANT_LABEL } from '../lib/variants'
import { authStore, useAuth } from '../lib/auth'
import AdminBestMove from '../components/AdminBestMove'
import BoardActions from '../components/BoardActions'

const other = (c: Color): Color => (c === 'w' ? 'b' : 'w')

const START_FEN = 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1'

// Per-time-control "low time" threshold: ~1/10 of the base clock, clamped to a
// sane 8s–60s window (bullet warns late, classical not absurdly early).
function lowTimeThreshold(baseMs: number): number {
    return Math.min(60_000, Math.max(8_000, baseMs / 10))
}

// Fire the low-time cue once when our own clock crosses the threshold; re-arm if
// an increment lifts us back above it. Reads the latest game via a ref (the
// authoritative clock advances outside React) and checks on a light interval.
function useLowTimeWarning(g: LiveGameState | null): void {
    const armed = useRef(true)
    const gRef = useRef(g)
    gRef.current = g
    useEffect(() => {
        armed.current = true
    }, [g?.id])
    useEffect(() => {
        if (!g || g.ended) return
        const id = window.setInterval(() => {
            const cur = gRef.current
            if (!cur || cur.ended || !cur.timeControl || cur.moves.length < 2) return
            const thr = lowTimeThreshold(cur.timeControl.base)
            const rem = liveRemaining(cur, cur.color)
            if (rem <= thr && armed.current) {
                armed.current = false
                sounds.lowTime()
            } else if (rem > thr + 2_000) {
                armed.current = true
            }
        }, 250)
        return () => window.clearInterval(id)
    }, [g?.id, g?.ended])
}

export default function LiveGame() {
    const navigate = useNavigate()
    const s = useGameSocket()
    const g = s.game
    const { user } = useAuth()
    const isAdmin = user?.role === 'admin'

    const [, force] = useState(0)
    const [sound, setSound] = useState(soundEnabled())

    function toggleSound() {
        const next = !sound
        setSound(next)
        setSoundEnabled(next)
        if (next) sounds.move()
    }

    // Tick for live clock countdown while a game is running.
    useEffect(() => {
        if (!g || g.ended) return
        const id = window.setInterval(() => force((n) => n + 1), 200)
        return () => window.clearInterval(id)
    }, [g?.id, g?.ended])

    // The local player can move when it's their turn and the socket is live.
    const myTurn = !!g && !g.ended && g.sideToMove === g.color && s.conn === 'open'
    const isDuck = g?.variant === 'duck'

    // Client-side history browsing. `viewIndex` (null = follow the live position)
    // lets the player scrub back through past plies to review them — it never
    // touches the game: the live position keeps advancing, clocks keep running, and
    // opponent-move sounds still fire (that effect keys off the move count, not the
    // viewed ply). While browsing (`atLive` false) the board is read-only.
    const [viewIndex, setViewIndex] = useState<number | null>(null)
    const liveLen = g?.moves.length ?? 0
    const shownPly = viewIndex === null ? liveLen : Math.min(viewIndex, liveLen)
    const atLive = shownPly === liveLen
    const boardInteractive = myTurn && atLive

    // The position each game started from, needed to replay UCIs into a past board.
    // Captured at ply 0 (so Chess960's random back-rank is exact); a game joined
    // mid-stream (resume) falls back to the standard start — correct for standard/
    // duck, whose pieces begin standard.
    const startFenRef = useRef<{ id: string; fen: string } | null>(null)
    if (g && (!startFenRef.current || startFenRef.current.id !== g.id)) {
        startFenRef.current = { id: g.id, fen: g.moves.length === 0 ? g.fen : START_FEN }
    }

    // The board to show when reviewing history: replay UCIs from the start up to the
    // viewed ply (display-only reconstruction — the duck isn't tracked here). null
    // while at the live position, where the real fen/overlay drive the board.
    const historyBoard = useMemo<BoardMap | null>(() => {
        if (!g || atLive) return null
        let board = parseFen(startFenRef.current?.fen ?? g.fen)
        for (let i = 0; i < shownPly; i++) board = applyUciVisually(board, g.moves[i].uci)
        return board
    }, [g?.id, atLive, shownPly, g?.moves])

    const historyLast =
        g && !atLive && shownPly > 0
            ? {
                  from: g.moves[shownPly - 1].uci.slice(0, 2),
                  to: g.moves[shownPly - 1].uci.slice(2, 4),
              }
            : null

    // History navigation (client-side review only).
    const goFirst = () => setViewIndex(0)
    const goPrev = () => setViewIndex(Math.max(0, shownPly - 1))
    const goNext = () => {
        const n = Math.min(liveLen, shownPly + 1)
        setViewIndex(n >= liveLen ? null : n)
    }
    const goLast = () => setViewIndex(null)
    const selectPly = (p: number) => setViewIndex(p >= liveLen ? null : p)
    useMoveNavKeys({ onPrev: goPrev, onNext: goNext, onFirst: goFirst, onLast: goLast, enabled: !!g })

    // Two board controllers, both hooks called unconditionally (only one is ever
    // "live" — the other is inert with myTurn:false). Standard/Chess960 use the
    // shared optimistic+premove controller; Duck Chess uses the two-phase
    // piece-then-duck controller. Both submit over the SAME socket move call — the
    // hub accepts a plain UCI or a composite "<pieceUci>:<duckSquare>". Unlike the
    // bot page there's no reveal delay: the opponent is a human whose reply arrives
    // asynchronously, so the player sees their own duck placement immediately.
    const interaction = useBoardInteraction({
        fen: g?.fen ?? '',
        myTurn: boardInteractive && !isDuck,
        legalMoves: g && boardInteractive && !isDuck ? g.legalMoves : [],
        submit: (uci) => gameSocket.move(uci),
        canPremove: true,
    })
    const duck = useDuckInteraction({
        fen: g?.fen ?? '',
        duck: g?.duck ?? null,
        myTurn: boardInteractive && isDuck,
        legalMoves: g && boardInteractive && isDuck ? g.legalMoves : [],
        submit: (composite) => gameSocket.move(composite),
    })

    // The optimistic overlay + last-move highlight come from whichever controller
    // is live for this variant.
    const activeOverride = isDuck ? duck.override : interaction.override
    const activeOptimisticLast = isDuck ? duck.optimisticLast : interaction.optimisticLast

    // Sound: voice the OPPONENT's newest move as the position advances. Our own
    // move is played synchronously in onMove (inside the click gesture) — both for
    // instant feedback and, crucially, to create/resume the AudioContext within a
    // user gesture (browsers keep it suspended otherwise, so a purely
    // state-message-driven sound never plays). Tracked per game id so resuming
    // doesn't replay history. The mover is the side NOT to move now.
    const soundedPly = useRef<{ id: string; ply: number } | null>(null)
    useEffect(() => {
        if (!g) return
        const prev = soundedPly.current
        if (!prev || prev.id !== g.id) {
            soundedPly.current = { id: g.id, ply: g.moves.length } // baseline; don't replay
            return
        }
        if (g.moves.length > prev.ply) {
            soundedPly.current = { id: g.id, ply: g.moves.length }
            if (other(g.sideToMove) !== g.color) playForSan(g.moves[g.moves.length - 1].san, false)
        }
    }, [g?.id, g?.moves.length])

    // Sound: warn once when our own clock enters "low time" (threshold scales with
    // the time control). Re-arms if we climb back above it via increment.
    useLowTimeWarning(g)

    // Sound: one game-over tone when the game ends (once per game).
    const endedSound = useRef<string | null>(null)
    useEffect(() => {
        if (g && g.ended && endedSound.current !== g.id) {
            endedSound.current = g.id
            sounds.end()
        }
    }, [g?.id, g?.ended])

    // A rated game changes the player's rating server-side; refresh the cached
    // user (once per game) so the navbar rating isn't stale.
    const ratedRefresh = useRef<string | null>(null)
    useEffect(() => {
        if (g && g.ended && g.rated && ratedRefresh.current !== g.id) {
            ratedRefresh.current = g.id
            void authStore.refresh()
        }
    }, [g?.id, g?.ended, g?.rated])

    if (!g) {
        return (
            <Box
                sx={{
                    flex: 1,
                    display: 'flex',
                    flexDirection: 'column',
                    alignItems: 'center',
                    justifyContent: 'center',
                    gap: 2,
                }}
            >
                <Typography sx={{ color: 'var(--text-dim)' }}>No active game.</Typography>
                <Button variant="contained" onClick={() => navigate('/')}>
                    Back to lobby
                </Button>
            </Box>
        )
    }

    // The duck square to render at the live position: the game's duck, hidden while
    // the local player's own move is mid-flight (the duck is "in hand" during
    // placement, until the authoritative position advances).
    const shownDuck: string | null = isDuck ? (activeOverride ? null : g.duck) : null

    const moveEntries: MoveEntry[] = g.moves.map((m, i) => ({
        ply: i + 1,
        san: m.san,
        uci: m.uci,
        by: 'human',
        fen: '',
    }))

    return (
        <BoardPage
            left={
                <Box
                    sx={{
                        display: { xs: 'none', md: 'flex' },
                        flexDirection: 'column',
                        gap: 2,
                        minHeight: 0,
                        flex: 1,
                    }}
                >
                    <LiveModeCard
                        pool={g.pool}
                        rated={g.rated}
                        color={g.color}
                        opponent={g.opponent}
                        variant={g.variant}
                    />
                    <ChatPanel
                        messages={g.messages}
                        onSend={(t) => gameSocket.sendChat(t)}
                        disabled={g.ended}
                    />
                </Box>
            }
            right={
                <Box
                    sx={{
                        flex: 1,
                        minHeight: 0,
                        display: 'flex',
                        flexDirection: 'column',
                        bgcolor: 'var(--surface)',
                        border: '1px solid var(--line-soft)',
                        borderRadius: '14px',
                        overflow: 'hidden',
                        boxShadow: PANEL_SHADOW,
                        alignSelf: { md: 'stretch' },
                        width: '100%',
                    }}
                >
                    {/* Pool + rated badge */}
                    <Box
                        sx={{
                            display: 'flex',
                            alignItems: 'center',
                            gap: 1,
                            px: 1.75,
                            py: 1.25,
                            bgcolor: 'var(--bg-2)',
                            borderBottom: '1px solid var(--line-soft)',
                        }}
                    >
                        <Typography
                            sx={{
                                fontFamily: 'var(--font-mono)',
                                fontSize: 12.5,
                                color: 'var(--text-dim)',
                            }}
                        >
                            {g.pool}
                        </Typography>
                        {g.variant !== 'standard' && (
                            <Box
                                sx={{
                                    px: 1,
                                    py: 0.3,
                                    borderRadius: '6px',
                                    fontFamily: 'var(--font-mono)',
                                    fontSize: 10.5,
                                    fontWeight: 700,
                                    letterSpacing: '0.1em',
                                    textTransform: 'uppercase',
                                    color: 'var(--accent)',
                                    bgcolor: 'var(--accent-soft)',
                                    border: '1px solid var(--accent-line)',
                                }}
                            >
                                {VARIANT_LABEL[g.variant]}
                            </Box>
                        )}
                        <Box
                            sx={{
                                ml: 'auto',
                                px: 1,
                                py: 0.3,
                                borderRadius: '6px',
                                fontSize: 10.5,
                                fontWeight: 700,
                                letterSpacing: '0.1em',
                                textTransform: 'uppercase',
                                border: '1px solid',
                                color: g.rated ? 'var(--accent)' : 'var(--text-dim)',
                                bgcolor: g.rated ? 'var(--accent-soft)' : 'transparent',
                                borderColor: g.rated ? 'var(--accent-line)' : 'var(--line)',
                            }}
                        >
                            {g.rated ? 'Rated' : 'Casual'}
                        </Box>
                        <NavBtn small label={sound ? 'Mute' : 'Unmute'} onClick={toggleSound}>
                            {sound ? <Volume2 size={18} /> : <VolumeX size={18} />}
                        </NavBtn>
                    </Box>

                    {/* Opponent */}
                    <PlayerBar
                        name={g.opponent.name}
                        rating={g.opponent.anon ? null : g.opponent.rating}
                        ms={liveRemaining(g, other(g.color))}
                        active={!g.ended && g.sideToMove === other(g.color)}
                        online={g.opponentOnline}
                        divider="bottom"
                    />

                    {s.conn !== 'open' && !g.ended && (
                        <Box
                            sx={{
                                px: 1.75,
                                py: 0.75,
                                bgcolor: 'var(--accent-soft)',
                                borderBottom: '1px solid var(--accent-line)',
                            }}
                        >
                            <Typography
                                sx={{
                                    fontSize: 12.5,
                                    color: 'var(--accent)',
                                    fontFamily: 'var(--font-mono)',
                                }}
                            >
                                Reconnecting…
                            </Typography>
                        </Box>
                    )}

                    {/* Moves (fills the panel) */}
                    <MoveList
                        fill
                        moves={moveEntries}
                        currentPly={shownPly}
                        onSelectPly={selectPly}
                    />

                    {/* Admin-only: engine best move toggle for the current position */}
                    {isAdmin && (
                        <Box
                            sx={{
                                px: 1.25,
                                py: 0.75,
                                borderTop: '1px solid var(--line-soft)',
                                bgcolor: 'var(--bg-2)',
                            }}
                        >
                            <AdminBestMove
                                fen={g.fen}
                                myTurn={!g.ended && g.sideToMove === g.color}
                                isDuck={isDuck}
                                duck={g.duck ?? null}
                            />
                        </Box>
                    )}

                    {/* Draw / takeback / resign while playing, or the result when over */}
                    {!g.ended ? (
                        <Box
                            sx={{
                                p: 1.25,
                                borderTop: '1px solid var(--line-soft)',
                                bgcolor: 'var(--bg-2)',
                                display: 'flex',
                                flexDirection: 'column',
                                gap: 1,
                            }}
                        >
                            {g.drawOffer === 'theirs' && (
                                <OfferBanner
                                    label="Opponent offers a draw"
                                    onAccept={() => gameSocket.respondDraw(true)}
                                    onDecline={() => gameSocket.respondDraw(false)}
                                />
                            )}
                            {g.takebackOffer === 'theirs' && (
                                <OfferBanner
                                    label="Opponent requests a takeback"
                                    onAccept={() => gameSocket.respondTakeback(true)}
                                    onDecline={() => gameSocket.respondTakeback(false)}
                                />
                            )}
                            <Box sx={{ display: 'flex', gap: 1 }}>
                                {g.drawOffer === 'mine' ? (
                                    <ActionBtn
                                        tone="neutral"
                                        icon={<Handshake size={15} />}
                                        label="Offered…"
                                        onClick={() => gameSocket.cancelDraw()}
                                    />
                                ) : (
                                    <ActionBtn
                                        tone="neutral"
                                        icon={<Handshake size={15} />}
                                        label="Draw"
                                        onClick={() => gameSocket.offerDraw()}
                                        disabled={g.drawOffer === 'theirs'}
                                    />
                                )}
                                {g.takebackOffer === 'mine' ? (
                                    <ActionBtn
                                        tone="neutral"
                                        icon={<Undo2 size={15} />}
                                        label="Requested…"
                                        onClick={() => gameSocket.cancelTakeback()}
                                    />
                                ) : (
                                    <ActionBtn
                                        tone="neutral"
                                        icon={<Undo2 size={15} />}
                                        label="Takeback"
                                        onClick={() => gameSocket.offerTakeback()}
                                        disabled={
                                            g.takebackOffer === 'theirs' || g.moves.length === 0
                                        }
                                    />
                                )}
                            </Box>
                            <ActionBtn
                                tone="danger"
                                icon={<Flag size={15} />}
                                label="Resign"
                                onClick={() => gameSocket.resign()}
                            />
                        </Box>
                    ) : (
                        <Box
                            sx={{
                                p: 1.25,
                                borderTop: '1px solid var(--line-soft)',
                                bgcolor: 'var(--bg-2)',
                                display: 'flex',
                                flexDirection: 'column',
                                gap: 1.25,
                            }}
                        >
                            <Typography
                                sx={{
                                    fontFamily: 'var(--font-display)',
                                    fontSize: 18,
                                    fontWeight: 700,
                                    textAlign: 'center',
                                }}
                            >
                                {resultText(g)}
                            </Typography>
                            <Box sx={{ display: 'flex', gap: 1 }}>
                                <ActionBtn
                                    tone="neutral"
                                    label="Lobby"
                                    onClick={() => {
                                        gameSocket.leave()
                                        navigate('/')
                                    }}
                                />
                                <ActionBtn
                                    tone="primary"
                                    label="New game"
                                    onClick={() => {
                                        gameSocket.queue(g.pool)
                                        navigate('/')
                                    }}
                                />
                            </Box>
                            {/* Post-game only — carry the finished game/position into
                                analysis, the editor, a bot game, or an engine match.
                                Never mid-game (no engine assistance while playing).
                                Duck Chess has no analysable standard position. The
                                game replays server-side by id, so Chess960 works too. */}
                            {g.variant !== 'duck' && (
                                <BoardActions
                                    fen={g.fen}
                                    analyzeGame={
                                        g.reason !== 'aborted' && g.status !== 'aborted'
                                            ? { id: g.id }
                                            : null
                                    }
                                />
                            )}
                        </Box>
                    )}

                    {/* You */}
                    <PlayerBar
                        name="You"
                        rating={null}
                        ms={liveRemaining(g, g.color)}
                        active={myTurn}
                        divider="top"
                    />
                </Box>
            }
        >
            <Board
                fen={g.fen}
                orientation={g.color}
                sideToMove={g.sideToMove}
                legalMoves={boardInteractive ? g.legalMoves : []}
                lastMove={atLive ? (activeOptimisticLast ?? g.lastMove) : historyLast}
                inCheck={!atLive || isDuck ? false : g.check}
                interactive={boardInteractive}
                onMove={isDuck ? duck.onMove : interaction.onMove}
                premoveColor={g.ended || isDuck || !atLive ? null : g.color}
                premove={isDuck || !atLive ? null : interaction.premove}
                onCancelPremove={interaction.cancelPremove}
                duck={atLive ? shownDuck : null}
                duckTargets={isDuck && atLive ? duck.duckTargets : null}
                onPlaceDuck={duck.onPlaceDuck}
                {...(atLive
                    ? activeOverride
                        ? { overrideBoard: activeOverride }
                        : {}
                    : { overrideBoard: historyBoard ?? undefined })}
            />
        </BoardPage>
    )
}

function PlayerBar({
    name,
    rating,
    ms,
    active,
    online,
    divider,
}: {
    name: string
    rating: number | null
    ms: number
    active: boolean
    online?: boolean
    divider?: 'top' | 'bottom'
}) {
    return (
        <Box
            sx={{
                display: 'flex',
                alignItems: 'center',
                gap: 1.25,
                px: 1.75,
                py: 1.25,
                bgcolor: 'var(--bg-2)',
                borderTop: divider === 'top' ? '1px solid var(--line-soft)' : undefined,
                borderBottom: divider === 'bottom' ? '1px solid var(--line-soft)' : undefined,
            }}
        >
            <Avatar small>
                <User size={15} />
            </Avatar>
            <Box sx={{ minWidth: 0 }}>
                <Box sx={{ display: 'flex', alignItems: 'baseline', gap: 0.75 }}>
                    <Typography
                        sx={{ fontFamily: 'var(--font-display)', fontWeight: 700, fontSize: 14.5 }}
                        noWrap
                    >
                        {name}
                    </Typography>
                    {rating != null && (
                        <Typography
                            sx={{
                                fontFamily: 'var(--font-mono)',
                                fontSize: 12,
                                color: 'var(--text-dim)',
                            }}
                        >
                            {rating}
                        </Typography>
                    )}
                </Box>
                {online === false && (
                    <Typography sx={{ fontSize: 11, color: 'var(--muted)', lineHeight: 1.1 }}>
                        disconnected
                    </Typography>
                )}
            </Box>
            <Box sx={{ ml: 'auto' }}>
                <Clock ms={ms} active={active} />
            </Box>
        </Box>
    )
}

function OfferBanner({
    label,
    onAccept,
    onDecline,
}: {
    label: string
    onAccept: () => void
    onDecline: () => void
}) {
    return (
        <Box
            sx={{
                p: 1,
                borderRadius: '10px',
                bgcolor: 'var(--accent-soft)',
                border: '1px solid var(--accent-line)',
                display: 'flex',
                flexDirection: 'column',
                gap: 0.75,
            }}
        >
            <Typography
                sx={{
                    fontSize: 12.5,
                    color: 'var(--accent)',
                    fontWeight: 600,
                    textAlign: 'center',
                }}
            >
                {label}
            </Typography>
            <Box sx={{ display: 'flex', gap: 0.75 }}>
                <ActionBtn
                    tone="primary"
                    icon={<Check size={15} />}
                    label="Accept"
                    onClick={onAccept}
                />
                <ActionBtn
                    tone="neutral"
                    icon={<X size={15} />}
                    label="Decline"
                    onClick={onDecline}
                />
            </Box>
        </Box>
    )
}

function resultText(g: LiveGameState): string {
    if (g.reason === 'aborted' || g.status === 'aborted') return 'Game aborted'
    if (g.status === 'disconnected') return 'Disconnected'
    if (g.result === '1/2-1/2') return g.reason === 'agreement' ? 'Draw · by agreement' : 'Draw'
    if (g.result === '1-0' || g.result === '0-1') {
        const winner: Color = g.result === '1-0' ? 'w' : 'b'
        const won = winner === g.color
        const how = reasonText(g.reason)
        return `${won ? 'You won' : 'You lost'}${how ? ` · ${how}` : ''}`
    }
    return 'Game over'
}

function reasonText(reason: string | null): string {
    switch (reason) {
        case 'resign':
            return 'resignation'
        case 'timeout':
            return 'on time'
        case 'abandon':
            return 'abandonment'
        case 'checkmate':
            return 'checkmate'
        default:
            return reason ?? ''
    }
}
