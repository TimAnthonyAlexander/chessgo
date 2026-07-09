import { useEffect, useMemo, useRef, useState } from 'react'
import { Box, Button, type SxProps, type Theme, Typography } from '@mui/material'
import {
    Check,
    Flag,
    FlipVertical2,
    Handshake,
    Undo2,
    User,
    Volume2,
    VolumeX,
    X,
} from 'lucide-react'
import { useNavigate } from 'react-router-dom'
import Board from '../components/Board'
import BoardPage from '../components/BoardPage'
import ChatPanel from '../components/ChatPanel'
import Clock from '../components/Clock'
import LiveModeCard from '../components/LiveModeCard'
import MoveList from '../components/MoveList'
import { ActionBtn, Avatar, NavBtn, PANEL_SHADOW } from '../components/PanelUI'
import { candidates, getGame, type MoveEntry, type Opening, type User as AuthUser } from '../api/client'
import { type Color, gameSocket, type LiveGameState, liveRemaining } from '../lib/socket'
import { computeMaterial, type Material } from '../lib/material'
import { categoryFor } from '../lib/timeControl'
import { useGameSocket } from '../lib/useGameSocket'
import { useBoardInteraction } from '../lib/useBoardInteraction'
import { useDuckInteraction } from '../lib/useDuckInteraction'
import { useCrazyhouseDrops } from '../lib/useCrazyhouseDrops'
import PocketPanel from '../components/PocketPanel'
import { parsePocket } from '../lib/variants'
import { useMoveNavKeys } from '../lib/useMoveNavKeys'
import { applyUciVisually, type BoardMap, parseFen } from '../lib/chess'
import { playForSan, setSoundEnabled, soundEnabled, sounds } from '../lib/sounds'
import { type Variant, VARIANT_LABEL } from '../lib/variants'
import { authStore, useAuth } from '../lib/auth'
import { usePrefs } from '../lib/settings'
import ConfirmDialog from '../components/ConfirmDialog'
import AdminBestMove from '../components/AdminBestMove'
import BoardActions from '../components/BoardActions'

const other = (c: Color): Color => (c === 'w' ? 'b' : 'w')

const START_FEN = 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1'

// The signed-in user's rating for THIS game's rated pool: variant games map to
// their own rating (duck / crazyhouse), everything else to the pool's time-control
// category. Null when signed out — anonymous players have no rating to show.
function userRatingFor(user: AuthUser | null, variant: Variant, pool: string): number | null {
    if (!user) return null
    if (variant === 'duck') return user.rating_duck
    if (variant === 'crazyhouse') return user.rating_crazyhouse
    switch (categoryFor(pool)) {
        case 'Bullet':
            return user.rating_bullet
        case 'Blitz':
            return user.rating_blitz
        case 'Rapid':
            return user.rating_rapid
        case 'Classical':
            return user.rating_classical
    }
}

// Per-time-control "low time" threshold: ~1/10 of the base clock, clamped to a
// sane 8s–60s window (bullet warns late, classical not absurdly early).
function lowTimeThreshold(baseMs: number): number {
    return Math.min(60_000, Math.max(8_000, baseMs / 10))
}

// Fire the low-time cue once when our own clock crosses the threshold; re-arm if
// an increment lifts us back above it. Reads the latest game via a ref (the
// authoritative clock advances outside React) and checks on a light interval.
function useLowTimeWarning(g: LiveGameState | null, enabled: boolean): void {
    const armed = useRef(true)
    const gRef = useRef(g)
    gRef.current = g
    useEffect(() => {
        armed.current = true
    }, [g?.id])
    useEffect(() => {
        if (!g || g.ended || !enabled) return
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
    }, [g?.id, g?.ended, enabled])
}

export default function LiveGame() {
    const navigate = useNavigate()
    const s = useGameSocket()
    const g = s.game
    const { user } = useAuth()
    const prefs = usePrefs()
    const isAdmin = user?.role === 'admin'

    const [sound, setSound] = useState(soundEnabled())
    // Resign confirmation modal (only used when the confirmResign pref is on).
    const [confirmResignOpen, setConfirmResignOpen] = useState(false)
    // Manual board flip — mirror the opponent's view. Independent of your color.
    const [flipped, setFlipped] = useState(false)
    // The rating change once a rated game ends (new rating + signed delta), keyed to
    // the game it belongs to so a stale delta never bleeds into the next game.
    const [ratingDelta, setRatingDelta] = useState<{
        id: string
        after: number
        delta: number
    } | null>(null)

    function toggleSound() {
        const next = !sound
        setSound(next)
        setSoundEnabled(next)
        if (next) sounds.move()
    }

    // The local player can move when it's their turn and the socket is live.
    const myTurn = !!g && !g.ended && g.sideToMove === g.color && s.conn === 'open'
    const isDuck = g?.variant === 'duck'
    const isCrazyhouse = g?.variant === 'crazyhouse'

    // Board orientation: your own color at the bottom, flipped on demand.
    const orientation: Color = g ? (flipped ? other(g.color) : g.color) : 'w'

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
        canPremove: prefs.premoves,
    })
    const duck = useDuckInteraction({
        fen: g?.fen ?? '',
        duck: g?.duck ?? null,
        myTurn: boardInteractive && isDuck,
        legalMoves: g && boardInteractive && isDuck ? g.legalMoves : [],
        submit: (composite) => gameSocket.move(composite),
    })
    // Crazyhouse drops: submitted as a plain "<P>@<sq>" move over the same socket
    // call (the hub treats a drop like any other move).
    const drops = useCrazyhouseDrops(
        g && boardInteractive && isCrazyhouse ? g.legalMoves : [],
        boardInteractive && isCrazyhouse,
        (uci) => gameSocket.move(uci),
    )

    // The optimistic overlay + last-move highlight come from whichever controller
    // is live for this variant.
    const activeOverride = isDuck ? duck.override : interaction.override
    const activeOptimisticLast = isDuck ? duck.optimisticLast : interaction.optimisticLast
    // Crazyhouse pockets (the hub sends the live pocket string). History review
    // shows the live pocket — the socket doesn't retain per-ply pockets.
    const pockets = parsePocket(isCrazyhouse && g ? g.pocket : '')

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
    useLowTimeWarning(g, prefs.soundLowTime)

    // Sound: one game-over tone when the game ends (once per game).
    const endedSound = useRef<string | null>(null)
    useEffect(() => {
        if (g && g.ended && endedSound.current !== g.id) {
            endedSound.current = g.id
            sounds.end()
        }
    }, [g?.id, g?.ended])

    // A rated game's rating change is AUTHORITATIVE on the persisted Game record
    // (white/black_rating_before/after) — the very same source the profile reads,
    // so it always matches and can never show the wrong sign. Read it from there
    // rather than diffing a live client snapshot against a post-game refresh, which
    // races the hub's fire-and-forget persist and produced bogus (even negative-on-a-
    // win) deltas. The hub saves the game just after we see it end, so poll a few
    // times to cover the brief not-yet-persisted window. Also refresh the cached user
    // (once per game) so the navbar rating isn't stale.
    const ratedRefresh = useRef<string | null>(null)
    useEffect(() => {
        if (!g || !g.ended || !g.rated || ratedRefresh.current === g.id) return
        ratedRefresh.current = g.id
        const id = g.id
        const myColor = g.color
        let cancelled = false

        void authStore.refresh()

        void (async () => {
            for (let attempt = 0; attempt < 8 && !cancelled; attempt++) {
                try {
                    const rec = await getGame(id)
                    const before =
                        myColor === 'w' ? rec.white_rating_before : rec.black_rating_before
                    const after =
                        myColor === 'w' ? rec.white_rating_after : rec.black_rating_after
                    if (before != null && after != null) {
                        if (!cancelled) setRatingDelta({ id, after, delta: after - before })
                        return
                    }
                } catch {
                    // Not persisted yet (404) or a transient error — retry shortly.
                }
                await new Promise((r) => setTimeout(r, 600))
            }
        })()

        return () => {
            cancelled = true
        }
    }, [g?.id, g?.ended, g?.rated])

    // Tab-title nudge: when the tab is backgrounded AND it's your move, flag the
    // title so a waiting player notices from another tab; clear it on focus or once
    // it's no longer your move. Self-contained — no socket/notification changes.
    const myMove = !!g && !g.ended && g.sideToMove === g.color
    useEffect(() => {
        const apply = () => {
            document.title = document.hidden && myMove ? '● Your move — chessgo' : 'chessgo'
        }
        apply()
        document.addEventListener('visibilitychange', apply)
        return () => {
            document.removeEventListener('visibilitychange', apply)
            document.title = 'chessgo'
        }
    }, [myMove])

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

    // Zen mode hides distraction chrome (ratings, clocks, move list, mode card) while
    // a game is in progress. It lapses once the game ends so the result shows normally.
    const zen = prefs.zenMode && !g.ended

    // Captured material (approximate, from the live FEN) for the player-bar readouts.
    const mat = computeMaterial(g.fen)

    // The player's own rating for this pool (shown in the "You" bar; hidden under zen).
    const myRating = userRatingFor(user, g.variant, g.pool)

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
                <>
                {isCrazyhouse && (
                    <PocketPanel
                        orientation={orientation}
                        humanColor={g.color}
                        pockets={pockets}
                        selected={drops.selected}
                        myTurn={boardInteractive && isCrazyhouse}
                        onSelect={drops.selectPocket}
                    />
                )}
                <Box
                    sx={{
                        display: { xs: 'none', md: 'flex' },
                        flexDirection: 'column',
                        gap: 2,
                        minHeight: 0,
                        flex: 1,
                    }}
                >
                    {!zen && (
                        <LiveModeCard
                            pool={g.pool}
                            rated={g.rated}
                            color={g.color}
                            opponent={g.opponent}
                            variant={g.variant}
                        />
                    )}
                    {!zen && g.variant === 'standard' && <LiveOpening fen={g.fen} />}
                    {!zen && (
                        <CapturedPanel
                            mat={mat}
                            opponentColor={other(g.color)}
                            opponentName={g.opponent.name}
                            humanColor={g.color}
                        />
                    )}
                    <ChatPanel
                        messages={g.messages}
                        onSend={(t) => gameSocket.sendChat(t)}
                        disabled={g.ended}
                    />
                </Box>
                </>
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
                        <NavBtn small label="Flip board" onClick={() => setFlipped((f) => !f)}>
                            <FlipVertical2 size={18} />
                        </NavBtn>
                        <NavBtn small label={sound ? 'Mute' : 'Unmute'} onClick={toggleSound}>
                            {sound ? <Volume2 size={18} /> : <VolumeX size={18} />}
                        </NavBtn>
                    </Box>

                    {/* Opponent */}
                    <PlayerBar
                        name={g.opponent.name}
                        rating={
                            g.opponent.anon || !prefs.showOpponentRating
                                ? null
                                : g.opponent.rating
                        }
                        getMs={() => liveRemaining(g, other(g.color))}
                        active={!g.ended && g.sideToMove === other(g.color)}
                        running={!g.ended && g.moves.length >= 2}
                        mat={mat}
                        color={other(g.color)}
                        online={g.opponentOnline}
                        divider="bottom"
                        zen={zen}
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

                    {/* Moves (fills the panel). Hidden under zen mode or when the
                        showMoveList pref is off; a flex spacer then keeps the panel's
                        bottom controls anchored where the list would have pushed them. */}
                    {!zen && prefs.showMoveList ? (
                        <MoveList
                            fill
                            moves={moveEntries}
                            currentPly={shownPly}
                            onSelectPly={selectPly}
                        />
                    ) : (
                        <Box sx={{ flex: 1, minHeight: 0 }} />
                    )}

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
                                onClick={() =>
                                    prefs.confirmResign
                                        ? setConfirmResignOpen(true)
                                        : gameSocket.resign()
                                }
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
                            {g.rated && ratingDelta && ratingDelta.id === g.id && (
                                <Typography
                                    sx={{
                                        fontFamily: 'var(--font-mono)',
                                        fontSize: 14,
                                        fontWeight: 700,
                                        textAlign: 'center',
                                        color: 'var(--text-dim)',
                                        mt: -0.5,
                                    }}
                                >
                                    {ratingDelta.after}{' '}
                                    <Box
                                        component="span"
                                        sx={{
                                            color:
                                                ratingDelta.delta > 0
                                                    ? 'var(--good, #7bb661)'
                                                    : ratingDelta.delta < 0
                                                      ? 'var(--danger, #e07a5f)'
                                                      : 'var(--text-dim)',
                                        }}
                                    >
                                        ({ratingDelta.delta > 0 ? '+' : ''}
                                        {ratingDelta.delta})
                                    </Box>
                                </Typography>
                            )}
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
                        rating={myRating}
                        getMs={() => liveRemaining(g, g.color)}
                        active={myTurn}
                        running={!g.ended && g.moves.length >= 2}
                        mat={mat}
                        color={g.color}
                        divider="top"
                        zen={zen}
                    />

                    <ConfirmDialog
                        open={confirmResignOpen}
                        title="Resign this game?"
                        message="You'll lose the game. This can't be undone."
                        confirmLabel="Resign"
                        danger
                        onConfirm={() => gameSocket.resign()}
                        onClose={() => setConfirmResignOpen(false)}
                    />
                </Box>
            }
        >
            <Box sx={{ position: 'relative', width: '100%' }}>
            <Board
                fen={g.fen}
                orientation={orientation}
                sideToMove={g.sideToMove}
                legalMoves={boardInteractive ? g.legalMoves : []}
                lastMove={atLive ? (activeOptimisticLast ?? g.lastMove) : historyLast}
                inCheck={!atLive || isDuck ? false : g.check}
                interactive={boardInteractive}
                onMove={isDuck ? duck.onMove : interaction.onMove}
                premoveColor={g.ended || isDuck || !atLive || !prefs.premoves ? null : g.color}
                premove={isDuck || !atLive ? null : interaction.premove}
                onCancelPremove={interaction.cancelPremove}
                duck={atLive ? shownDuck : null}
                duckTargets={isDuck && atLive ? duck.duckTargets : null}
                onPlaceDuck={duck.onPlaceDuck}
                dropTargets={isCrazyhouse && atLive ? drops.dropTargets : null}
                onDrop={drops.drop}
                onDropCancel={drops.cancel}
                {...(atLive
                    ? activeOverride
                        ? { overrideBoard: activeOverride }
                        : {}
                    : { overrideBoard: historyBoard ?? undefined })}
            />
            {s.conn !== 'open' && !g.ended && (
                <Box
                    sx={{
                        position: 'absolute',
                        inset: 0,
                        zIndex: 5,
                        display: 'flex',
                        alignItems: 'flex-start',
                        justifyContent: 'center',
                        pt: '14%',
                        pointerEvents: 'none',
                    }}
                >
                    <Box
                        sx={{
                            display: 'flex',
                            alignItems: 'center',
                            gap: 1,
                            px: 2,
                            py: 1,
                            borderRadius: '10px',
                            bgcolor: 'rgba(0,0,0,0.74)',
                            border: '1px solid var(--accent-line)',
                            boxShadow: '0 10px 34px -12px rgba(0,0,0,0.75)',
                        }}
                    >
                        <Box
                            sx={{
                                width: 9,
                                height: 9,
                                borderRadius: '50%',
                                bgcolor: 'var(--accent)',
                                animation: 'pulse 1.1s ease-in-out infinite',
                                '@keyframes pulse': {
                                    '0%, 100%': { opacity: 0.35 },
                                    '50%': { opacity: 1 },
                                },
                            }}
                        />
                        <Typography
                            sx={{
                                fontSize: 13.5,
                                fontWeight: 600,
                                color: 'var(--text)',
                                fontFamily: 'var(--font-mono)',
                            }}
                        >
                            Connection lost — reconnecting…
                        </Typography>
                    </Box>
                </Box>
            )}
            </Box>
        </BoardPage>
    )
}

// This bar's own captured pieces + material advantage, derived from the shared
// FEN-based material read (same logic the spectator info card uses).
function sideMaterial(
    mat: Material,
    color: Color,
): { captured: string[]; glyphColor: Color; adv: number } {
    const captured = color === 'w' ? mat.capturedByWhite : mat.capturedByBlack
    const adv = color === 'w' ? Math.max(0, mat.diff) : Math.max(0, -mat.diff)
    return { captured, glyphColor: color === 'w' ? 'b' : 'w', adv }
}

// Captured-piece glyph row: overlapping cburnett SVGs for the pieces a side has
// captured, plus its signed material advantage. Shared by the player bar (mobile)
// and the desktop CapturedPanel. Renders nothing when there's nothing to show.
function CapturedGlyphs({
    captured,
    glyphColor,
    adv,
    size = 16,
    sx,
}: {
    captured: string[]
    glyphColor: Color
    adv: number
    size?: number
    sx?: SxProps<Theme>
}) {
    if (captured.length === 0 && adv <= 0) return null
    return (
        <Box
            sx={[
                {
                    display: 'flex',
                    flexWrap: 'wrap',
                    alignItems: 'center',
                    gap: '1px',
                    minWidth: 0,
                },
                ...(Array.isArray(sx) ? sx : [sx]),
            ]}
        >
            {captured.map((t, i) => (
                <Box
                    key={i}
                    component="img"
                    src={`/piece/cburnett/${glyphColor}${t}.svg`}
                    alt={t}
                    sx={{
                        width: size,
                        height: size,
                        ml: i > 0 && captured[i - 1] === t ? `${-size * 0.375}px` : 0,
                    }}
                />
            ))}
            {adv > 0 && (
                <Typography
                    sx={{
                        ml: 0.5,
                        fontFamily: 'var(--font-mono)',
                        fontSize: 12,
                        fontWeight: 700,
                        color: 'var(--accent)',
                    }}
                >
                    +{adv}
                </Typography>
            )}
        </Box>
    )
}

// Desktop captured-material panel for the left column: both players' captured
// pieces with room to breathe (the narrow player bar wraps after ~2 glyphs).
// Renders nothing until the first capture so it never shifts the layout early.
function CapturedPanel({
    mat,
    opponentColor,
    opponentName,
    humanColor,
}: {
    mat: Material
    opponentColor: Color
    opponentName: string
    humanColor: Color
}) {
    const opp = sideMaterial(mat, opponentColor)
    const you = sideMaterial(mat, humanColor)
    if (
        opp.captured.length === 0 &&
        opp.adv === 0 &&
        you.captured.length === 0 &&
        you.adv === 0
    ) {
        return null
    }
    const rows = [
        { label: opponentName, side: opp },
        { label: 'You', side: you },
    ]
    return (
        <Box
            sx={{
                display: 'flex',
                flexDirection: 'column',
                gap: 0.75,
                px: 1.5,
                py: 1.25,
                bgcolor: 'var(--surface)',
                border: '1px solid var(--line-soft)',
                borderRadius: '12px',
                boxShadow: PANEL_SHADOW,
            }}
        >
            {rows.map(({ label, side }, i) => (
                <Box key={i} sx={{ display: 'flex', alignItems: 'center', gap: 1, minHeight: 20 }}>
                    <Typography
                        noWrap
                        sx={{
                            fontFamily: 'var(--font-mono)',
                            fontSize: 11,
                            color: 'var(--text-dim)',
                            width: 64,
                            flexShrink: 0,
                        }}
                    >
                        {label}
                    </Typography>
                    <CapturedGlyphs
                        captured={side.captured}
                        glyphColor={side.glyphColor}
                        adv={side.adv}
                        size={18}
                    />
                </Box>
            ))}
        </Box>
    )
}

function PlayerBar({
    name,
    rating,
    getMs,
    active,
    running,
    mat,
    color,
    online,
    divider,
    zen = false,
}: {
    name: string
    rating: number | null
    getMs: () => number
    active: boolean
    running: boolean
    /** Live material read (shared) + which side this bar is, for the captured strip. */
    mat: Material
    color: Color
    online?: boolean
    divider?: 'top' | 'bottom'
    /** Zen mode: suppress the rating badge, captured strip and clock (just the name). */
    zen?: boolean
}) {
    const { captured, glyphColor, adv } = sideMaterial(mat, color)
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
                    {!zen && rating != null && (
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
            {/* Compact strip in the bar on MOBILE only — on desktop the captured
                pieces live in the roomy left-column CapturedPanel (no wrapping). */}
            {!zen && (
                <CapturedGlyphs
                    captured={captured}
                    glyphColor={glyphColor}
                    adv={adv}
                    sx={{ display: { xs: 'flex', md: 'none' }, maxWidth: 150 }}
                />
            )}
            {!zen && (
                <Box sx={{ ml: 'auto' }}>
                    <Clock getMs={getMs} active={active} running={running} />
                </Box>
            )}
        </Box>
    )
}

// A subtle opening-name strip for live play. Self-fetches the position's opening
// name (ECO + name) as the game develops, showing NOTHING until one is known so it
// never shifts the layout. Renders only the name — never candidate moves or evals —
// so it gives no engine assistance during the game.
function LiveOpening({ fen }: { fen: string }) {
    const [opening, setOpening] = useState<Opening | null>(null)
    useEffect(() => {
        // The starting position has no opening to name yet.
        if (fen.split(' ')[0] === START_FEN.split(' ')[0]) {
            setOpening(null)
            return
        }
        const ac = new AbortController()
        let alive = true
        void candidates(fen, { multipv: 1, movetime: 120, signal: ac.signal })
            .then((res) => {
                if (alive) setOpening(res.opening)
            })
            .catch(() => {
                /* aborted / transient — keep the last shown name */
            })
        return () => {
            alive = false
            ac.abort()
        }
    }, [fen])

    if (!opening) return null
    return (
        <Box
            sx={{
                display: 'flex',
                alignItems: 'center',
                gap: 1,
                px: 1.5,
                py: 1,
                bgcolor: 'var(--surface)',
                border: '1px solid var(--line-soft)',
                borderRadius: '12px',
                boxShadow: PANEL_SHADOW,
            }}
        >
            <Box
                component="span"
                sx={{
                    fontFamily: 'var(--font-mono)',
                    fontSize: 11,
                    fontWeight: 700,
                    letterSpacing: 0.5,
                    color: 'var(--accent)',
                    bgcolor: 'var(--accent-soft)',
                    border: '1px solid var(--accent-line)',
                    borderRadius: '5px',
                    px: 0.6,
                    py: '1px',
                    flexShrink: 0,
                }}
            >
                {opening.eco}
            </Box>
            <Typography
                title={opening.name}
                sx={{
                    fontSize: 13,
                    fontWeight: 600,
                    color: 'var(--text)',
                    whiteSpace: 'nowrap',
                    overflow: 'hidden',
                    textOverflow: 'ellipsis',
                    minWidth: 0,
                }}
            >
                {opening.name}
            </Typography>
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
