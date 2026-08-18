import { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Box, Button, type SxProps, type Theme, Typography } from '@mui/material'
import {
    Check,
    ChevronLeft,
    ChevronRight,
    Crown,
    Flag,
    FlipVertical2,
    Handshake,
    Trophy,
    Undo2,
    User,
    Volume2,
    VolumeX,
    X,
} from 'lucide-react'
import { useNavigate } from 'react-router-dom'
import Board from '../components/Board'
import BoardPage, { useBoardLayout } from '../components/BoardPage'
import ChatPanel from '../components/ChatPanel'
import Clock, { ClockBar } from '../components/Clock'
import LiveModeCard from '../components/LiveModeCard'
import MoveList from '../components/MoveList'
import { ActionBtn, Avatar, NavBtn, PANEL_SHADOW } from '../components/PanelUI'
import TitleBadge from '../components/TitleBadge'
import {
    candidates,
    getGame,
    getGameAnalysis,
    type MoveEntry,
    type Opening,
    type Title,
    type User as AuthUser,
} from '../api/client'
import { buildBlunderPuzzles } from '../lib/blunderRewind'
import { type Color, gameSocket, type LiveGameState, liveRemaining } from '../lib/socket'
import { computeMaterial, type Material } from '../lib/material'
import { categoryFor } from '../lib/timeControl'
import { useGameSocketField } from '../lib/useGameSocket'
import { useBoardInteraction } from '../lib/useBoardInteraction'
import { useConfirmMove } from '../lib/useConfirmMove'
import PendingMoveBar from '../components/PendingMoveBar'
import { useDuckInteraction } from '../lib/useDuckInteraction'
import { useCrazyhouseDrops } from '../lib/useCrazyhouseDrops'
import PocketPanel from '../components/PocketPanel'
import { parsePocket } from '../lib/variants'
import { useMoveNavKeys } from '../lib/useMoveNavKeys'
import { applyUciVisually, type BoardMap, type Square, parseFen } from '../lib/chess'
import { playForSan, setSoundEnabled, soundEnabled, sounds } from '../lib/sounds'
import { type Variant, variantHasCheck } from '../lib/variants'
import {
    DesignationPanel,
    DesignationRibbon,
    randomSecretQueenSquare,
    secretQueenChoices,
} from '../components/SecretQueenDesignation'
import { authStore, useAuth } from '../lib/auth'
import { usePrefs, useSetting } from '../lib/settings'
import ConfirmDialog from '../components/ConfirmDialog'
import AdminBestMove from '../components/AdminBestMove'
import BoardActions from '../components/BoardActions'

const other = (c: Color): Color => (c === 'w' ? 'b' : 'w')

const START_FEN = 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1'

// Stable "no legal moves" reference — every "it isn't your turn" branch below
// used to hand Board (and the interaction hooks) a fresh `[]` on every render,
// which alone was enough to defeat Board's prop-identity memoization.
const NO_MOVES: string[] = []

// Full-move rows the move list shows before it starts scrolling. Fixed (not
// content-driven) so the right card keeps one height from move 1 to move 60.
const MOVE_LIST_ROWS = 7

// The signed-in user's rating for THIS game's rated pool: every variant maps to
// its own isolated rating, standard to the pool's time-control category. Null when
// signed out — anonymous players have no rating to show.
function userRatingFor(user: AuthUser | null, variant: Variant, pool: string): number | null {
    if (!user) return null
    if (variant === 'chess960') return user.rating_chess960
    if (variant === 'duck') return user.rating_duck
    if (variant === 'crazyhouse') return user.rating_crazyhouse
    if (variant === 'antichess') return user.rating_antichess
    if (variant === 'secretqueen') return user.rating_secretqueen
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
    // Field-level subscriptions: LiveGame only ever reads the socket's `game` and
    // `conn` slices, so subscribing to those two fields (instead of the whole
    // SocketState, which GameSocket.set() replaces wholesale on every message —
    // including chat/presence/arena/challenge events unrelated to this game)
    // keeps this page from re-rendering for events it doesn't care about.
    const g = useGameSocketField('game')
    const conn = useGameSocketField('conn')
    const { user } = useAuth()
    const prefs = usePrefs()
    const isAdmin = user?.role === 'admin'

    // WHERE the player rows go is the one thing that genuinely differs between the
    // two page layouts: the centered layout stacks them inside the right panel, top
    // and bottom, with the move list between; the side rail hangs them off the board
    // as full-width strips. Same two components either way — built once below and
    // handed to whichever slot the active layout wants, so the arrangements can't
    // drift apart. Read HERE, above the `if (!g)` early return further down: a hook
    // placed after a conditional return runs on some renders and not others.
    const chesscom = useBoardLayout() === 'chesscom'
    const [sound, setSound] = useState(soundEnabled())
    // Resign confirmation modal (only used when the confirmResign pref is on).
    const [confirmResignOpen, setConfirmResignOpen] = useState(false)
    // Manual board flip — mirror the opponent's view. Independent of your color.
    const [flipped, setFlipped] = useState(false)
    // Admin best-move hint (squares + the UCI 'G' plays), drawn as near-invisible
    // pixel dots on the board while peeking. Fetched regardless of the readout
    // toggle; null when it isn't our move.
    const [bestHint, setBestHint] = useState<{ from: Square; to: Square; uci: string } | null>(null)
    // The rating change once a rated game ends (new rating + signed delta), keyed to
    // the game it belongs to so a stale delta never bleeds into the next game.
    const [ratingDelta, setRatingDelta] = useState<{
        id: string
        after: number
        delta: number
    } | null>(null)

    // When a rematch is accepted, the hub sends `matched` with a fresh game ID.
    // If we're already on the LiveGame page showing the ended game, navigate to the
    // new game's URL so the route matches the game being played.
    const prevGameId = useRef<string | null>(null)
    useEffect(() => {
        if (g && !g.ended && prevGameId.current && prevGameId.current !== g.id) {
            navigate(`/game/${g.id}`, { replace: true })
        }
        prevGameId.current = g?.id ?? null
    }, [g?.id, g?.ended])

    function toggleSound() {
        const next = !sound
        setSound(next)
        setSoundEnabled(next)
        if (next) sounds.move()
    }

    // The local player can move when it's their turn and the socket is live.
    const myTurn = !!g && !g.ended && g.sideToMove === g.color && conn === 'open'
    const isDuck = g?.variant === 'duck'
    const isCrazyhouse = g?.variant === 'crazyhouse'
    // Antichess plays on a normal board — no pockets, no duck placement, and (like
    // Duck) no check concept: `variantHasCheck` keeps the king glow off for both.
    const isAntichess = g?.variant === 'antichess'
    // Secret Queen: the pre-game step where each side picks which of its own
    // pawns is the queen. `needsDesignation` is OUR obligation only — the hub
    // never says whether the opponent has chosen, because the choice is
    // simultaneous and the timing would leak. See docs/tasks/open/secret-queen.md.
    const isSecretQueen = g?.variant === 'secretqueen'
    const designating = !!g && isSecretQueen && g.needsDesignation && !g.ended

    // The pawn we've clicked during designation, held locally until the hub
    // echoes it back as `secretSquare`. Cleared whenever we stop designating so
    // a rematch starts blank.
    const [pick, setPick] = useState<Square | null>(null)
    useEffect(() => {
        if (!designating) setPick(null)
    }, [designating])

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

    const historyLast = useMemo(
        () =>
            g && !atLive && shownPly > 0
                ? {
                      from: g.moves[shownPly - 1].uci.slice(0, 2),
                      to: g.moves[shownPly - 1].uci.slice(2, 4),
                  }
                : null,
        // g.moves keeps its reference across updates that don't touch it (chat,
        // presence, offers — see GameSocket.set's shallow spread), so this only
        // recomputes when the move list, view position, or game itself changes.
        [g?.moves, atLive, shownPly],
    )

    // History navigation (client-side review only). Memoized so MoveList's own
    // memo() (which already gets a stable `moves` prop) actually bites — a fresh
    // onSelectPly every render defeated it regardless of moves/currentPly being
    // unchanged.
    const goFirst = useCallback(() => setViewIndex(0), [])
    const goPrev = useCallback(() => setViewIndex(Math.max(0, shownPly - 1)), [shownPly])
    const goNext = useCallback(() => {
        const n = Math.min(liveLen, shownPly + 1)
        setViewIndex(n >= liveLen ? null : n)
    }, [liveLen, shownPly])
    const goLast = useCallback(() => setViewIndex(null), [])
    const selectPly = useCallback((p: number) => setViewIndex(p >= liveLen ? null : p), [liveLen])
    useMoveNavKeys({ onPrev: goPrev, onNext: goNext, onFirst: goFirst, onLast: goLast, enabled: !!g })

    // Two board controllers, both hooks called unconditionally (only one is ever
    // "live" — the other is inert with myTurn:false). Standard/Chess960 use the
    // shared optimistic+premove controller; Duck Chess uses the two-phase
    // piece-then-duck controller. Both submit over the SAME socket move call — the
    // hub accepts a plain UCI or a composite "<pieceUci>:<duckSquare>". Unlike the
    // bot page there's no reveal delay: the opponent is a human whose reply arrives
    // asynchronously, so the player sees their own duck placement immediately.
    // gameSocket is a page-lifetime singleton, so this closure never needs to
    // change — one stable reference shared by every controller below, instead
    // of a fresh arrow function per hook call on every render (which would
    // otherwise cascade into their internal useCallbacks re-creating too).
    const submitMove = useCallback((uci: string) => gameSocket.move(uci), [])
    // Same reasoning as submitMove: gameSocket is a page-lifetime singleton, so
    // this can be a stable empty-deps callback — lets memo(ChatPanel) actually
    // bail on renders that don't touch the chat (a move, a clock tick, ...).
    const sendChat = useCallback((t: string) => gameSocket.sendChat(t), [])
    const interaction = useBoardInteraction({
        fen: g?.fen ?? '',
        myTurn: boardInteractive && !isDuck,
        legalMoves: g && boardInteractive && !isDuck ? g.legalMoves : NO_MOVES,
        submit: submitMove,
        canPremove: prefs.premoves,
    })
    const duck = useDuckInteraction({
        fen: g?.fen ?? '',
        duck: g?.duck ?? null,
        myTurn: boardInteractive && isDuck,
        legalMoves: g && boardInteractive && isDuck ? g.legalMoves : NO_MOVES,
        submit: submitMove,
    })
    // Crazyhouse drops: submitted as a plain "<P>@<sq>" move over the same socket
    // call (the hub treats a drop like any other move).
    const drops = useCrazyhouseDrops(
        g && boardInteractive && isCrazyhouse ? g.legalMoves : NO_MOVES,
        boardInteractive && isCrazyhouse,
        submitMove,
    )

    // confirmMove: hold a real (on-turn) move for an explicit Confirm/Cancel
    // before it reaches the socket. 'slow' only fires for Classical (this app has
    // no correspondence). Only the standard piece-move path (`interaction.onMove`,
    // also used by Crazyhouse's own piece moves) is wrapped — Duck Chess's
    // two-phase piece+duck controller and Crazyhouse drops go straight through,
    // matching the task's own framing (wrap what feeds `<Board onMove>`).
    const confirmMove = useConfirmMove(
        prefs.confirmMove,
        g ? categoryFor(g.pool) : null,
        interaction.onMove,
    )
    // Board's raw move intent: a premove (made while it isn't our turn) bypasses
    // confirmation entirely — it's already a deliberate commitment — and goes
    // straight to the real submit. A real (on-turn) move runs through the gate.
    const handleBoardMove = useCallback(
        (uci: string) => {
            if (!boardInteractive) {
                interaction.onMove(uci)
                return
            }
            confirmMove.onMove(uci)
        },
        [boardInteractive, interaction.onMove, confirmMove.onMove],
    )

    // The optimistic overlay + last-move highlight come from whichever controller
    // is live for this variant.
    const activeOverride = isDuck ? duck.override : interaction.override
    const activeOptimisticLast = isDuck ? duck.optimisticLast : interaction.optimisticLast
    // Crazyhouse pockets (the hub sends the live pocket string). History review
    // shows the live pocket — the socket doesn't retain per-ply pockets.
    const pockets = parsePocket(isCrazyhouse && g ? g.pocket : '')

    // Board's pending-confirm arrow — memoized so it's a stable `null` (not a
    // fresh object) whenever nothing is pending.
    const confirmArrow = useMemo(
        () =>
            confirmMove.pending
                ? { from: confirmMove.pending.from, to: confirmMove.pending.to }
                : null,
        [confirmMove.pending],
    )

    // Board's overrideBoard — collapsed from the old conditional prop-spread (which
    // changed prop SHAPE, not just value, defeating shallow prop comparison) into a
    // single stable value. `overrideBoard?: BoardMap` on Board already treats an
    // explicit `undefined` identically to the prop being absent.
    const overrideBoard = useMemo<BoardMap | undefined>(
        () => (atLive ? activeOverride ?? undefined : historyBoard ?? undefined),
        [atLive, activeOverride, historyBoard],
    )

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

    // Secret Queen: announce a reveal. The hub sends `reveal` — the square a
    // hidden queen was just unmasked on — with the move that did it; by then it
    // IS a queen on everyone's board, so this is public and safe to narrate.
    // Whose it was follows from who moved: the mover unmasked their own, unless
    // they captured it, in which case it was the victim's. We can't tell those
    // apart from the wire alone, so the copy stays neutral about it and names
    // only the square, which is what the player can see anyway.
    const [revealNote, setRevealNote] = useState<string | null>(null)
    const revealSeen = useRef<string>('')
    useEffect(() => {
        const sq = g?.reveal ?? ''
        if (!sq || sq === revealSeen.current) return
        revealSeen.current = sq
        setRevealNote(`A secret queen was revealed on ${sq}.`)
        sounds.promote()
        const t = window.setTimeout(() => setRevealNote(null), 4500)
        return () => window.clearTimeout(t)
    }, [g?.reveal])

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

    // Blunder count for the game-over "Review N blunders" CTA. Fetched once per
    // game, right after it ends — never blocks the game-over screen; a slow or
    // failed fetch just means the CTA doesn't show. Skipped for Duck Chess (no
    // full-game analyzer) and aborted games (nothing to review). The hub persists
    // the game fire-and-forget, so the Game record backing the analysis may not
    // exist for a beat after `ended` flips — retry through that same window the
    // rating-delta fetch above already handles.
    const blunderFetched = useRef<string | null>(null)
    const [blunderCount, setBlunderCount] = useState<{ id: string; count: number } | null>(null)
    useEffect(() => {
        if (!g || !g.ended || g.variant === 'duck') return
        if (g.reason === 'aborted' || g.status === 'aborted') return
        if (blunderFetched.current === g.id) return
        blunderFetched.current = g.id
        const id = g.id
        const myColor = g.color
        let cancelled = false

        void (async () => {
            for (let attempt = 0; attempt < 8 && !cancelled; attempt++) {
                try {
                    const a = await getGameAnalysis(id)
                    if (cancelled) return
                    if (!a.unsupported) {
                        setBlunderCount({ id, count: buildBlunderPuzzles(a, myColor).length })
                    }
                    return
                } catch {
                    // Not persisted yet (404) or a transient error — retry shortly.
                }
                await new Promise((r) => setTimeout(r, 600))
            }
        })()

        return () => {
            cancelled = true
        }
    }, [g?.id, g?.ended, g?.variant, g?.reason, g?.status])

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

    // The hooks below sit ABOVE the `if (!g)` bail-out on purpose: a hook after an
    // early return is a conditional hook. The render with no game would skip them
    // and the render where one arrives would call them, which is React's "Rendered
    // more hooks than during the previous render" crash — reachable by reloading
    // /game/:id, where the "No active game" branch paints first and the socket's
    // resume lands a moment later. So each one tolerates a null `g` instead.

    // Captured material (approximate, from the live FEN) for the player-bar readouts.
    // Memoized so PlayerBar/CapturedPanel don't get a fresh object on every render
    // that doesn't touch the position (chat, presence, offers, …).
    const mat = useMemo(() => computeMaterial(g?.fen ?? START_FEN), [g?.fen])

    // Clock.tsx's effect re-arms its interval whenever `getMs`'s identity changes
    // (see its `[getMs, active, running]` deps), so a fresh closure here — as this
    // used to be, created inline in the JSX below — tore down and restarted BOTH
    // players' clock intervals on every LiveGame render, including ones with no
    // clock-relevant change (chat, a draw offer, presence). liveRemaining only
    // reads clock/ended/moves.length/sideToMove/clockAt off `g`, plus the color
    // argument, so those are the only deps that matter — this closure stays
    // stable across e.g. a chat message (which doesn't touch any of them) and
    // only changes when the position/clock genuinely advances.
    const opponentGetMs = useCallback(
        () => (g ? liveRemaining(g, other(g.color)) : 0),
        [g?.clock, g?.ended, g?.moves.length, g?.sideToMove, g?.clockAt, g?.color],
    )
    const myGetMs = useCallback(
        () => (g ? liveRemaining(g, g.color) : 0),
        [g?.clock, g?.ended, g?.moves.length, g?.sideToMove, g?.clockAt, g?.color],
    )

    // Secret Queen designation: the set of squares Board should treat as pickable.
    // secretQueenChoices(color) is pure (only reads its argument), so this is a
    // fresh `Set` only when designation starts/ends or the color changes — not on
    // every render, which used to defeat memo(Board) outright while designating.
    const pickTargets = useMemo(
        () => (designating && g ? secretQueenChoices(g.color) : null),
        [designating, g?.color],
    )

    // Memoized so MoveList's own memo() actually bites — its `moves` prop used to
    // be a fresh array of fresh objects every render.
    const moveEntries: MoveEntry[] = useMemo(
        () =>
            (g?.moves ?? []).map((m, i) => ({
                ply: i + 1,
                san: m.san,
                uci: m.uci,
                by: 'human' as const,
                fen: '',
            })),
        [g?.moves],
    )

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

    // The player's own rating for this pool (shown in the "You" bar; hidden under zen).
    const myRating = userRatingFor(user, g.variant, g.pool)

    const barVariant = chesscom ? 'strip' : 'rail'
    const opponentBar = (
        <PlayerBar
            name={g.opponent.name}
            title={g.opponent.title}
            rating={g.opponent.anon || !prefs.showOpponentRating ? null : g.opponent.rating}
            getMs={opponentGetMs}
            active={!g.ended && g.sideToMove === other(g.color)}
            running={!g.ended && g.moves.length >= 2}
            initialMs={g.timeControl.base}
            mat={mat}
            color={other(g.color)}
            online={g.opponentOnline}
            divider="bottom"
            zen={zen}
            variant={barVariant}
        />
    )
    const myBar = (
        <PlayerBar
            name="You"
            title={user?.title}
            rating={myRating}
            getMs={myGetMs}
            active={myTurn}
            running={!g.ended && g.moves.length >= 2}
            initialMs={g.timeControl.base}
            mat={mat}
            color={g.color}
            divider="top"
            zen={zen}
            variant={barVariant}
        />
    )

    return (
        <BoardPage
            // Right card is compact by design (a fixed 7-row move list), so it shrinks
            // to its content and centres against the board. The LEFT column stays full
            // board-height with the chat filling whatever the cards above it leave —
            // Lichess's live layout. Ignored by the chess.com layout, whose rail is
            // always full height.
            rightFit
            // Board-hugging player strips — chess.com only. Left undefined for Lichess,
            // where the same two bars live inside the right panel instead.
            top={chesscom ? opponentBar : undefined}
            bottom={chesscom ? myBar : undefined}
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
                    {/* Not in the side-rail layout: there this is the move panel's own
                        header row, so the two read as one continuous box rather than
                        two cards stacked in the rail. */}
                    {!zen && !chesscom && (
                        <LiveModeCard pool={g.pool} rated={g.rated} variant={g.variant} />
                    )}
                    {!zen && g.variant === 'standard' && <LiveOpening fen={g.fen} />}
                    {/* Not in the chess.com layout: there the player strips carry the
                        captured pieces themselves, and this panel would just repeat
                        them a second time in the rail. */}
                    {!zen && prefs.showCaptured && !chesscom && (
                        <CapturedPanel
                            mat={mat}
                            opponentColor={other(g.color)}
                            humanColor={g.color}
                        />
                    )}
                    {/* Grows to eat whatever the game cards above don't use, pinning the
                        chat to the bottom half. */}
                    <Box sx={{ flex: 1, minHeight: 0 }} />
                    {/* The chat is exactly the bottom half of the column (which is the
                        board's height), regardless of how many cards sit above it.
                        `0 0 50%` — no grow, no shrink, so it's a fixed half rather than
                        whatever is left over. */}
                    <Box sx={{ flex: '0 0 50%', minHeight: 0, display: 'flex' }}>
                        <ChatPanel messages={g.messages} onSend={sendChat} disabled={g.ended} />
                    </Box>
                </Box>
                </>
            }
            right={
                designating ? (
                    // The designation step replaces the game panel entirely: there
                    // is no move list, clock action or offer to show until both
                    // sides have chosen, and the choice is the only thing to do.
                    <DesignationPanel
                        color={g.color}
                        picked={pick}
                        opponentName={g.opponent.name || 'Your opponent'}
                        deadline={g.designationDeadline || null}
                        onSurprise={() => {
                            const sq = randomSecretQueenSquare(g.color)
                            setPick(sq)
                            gameSocket.designate(sq)
                        }}
                        onConfirm={() => pick && gameSocket.designate(pick)}
                    />
                ) : (
                <Box
                    sx={{
                        // Sized by its content (the 7-row move list plus the header and
                        // controls), NOT stretched to the column: the column is `rightFit`
                        // and centres this card against the board.
                        flex: '0 0 auto',
                        minHeight: 0,
                        display: 'flex',
                        flexDirection: 'column',
                        bgcolor: 'var(--surface)',
                        border: '1px solid var(--line-soft)',
                        borderRadius: 'var(--panel-radius)',
                        overflow: 'hidden',
                        boxShadow: PANEL_SHADOW,
                        alignSelf: { md: 'stretch' },
                        width: '100%',
                    }}
                >
                    {/* Side-rail layout: the game's mode (category, time control,
                        rated/casual) heads the panel instead of standing as its own
                        card in the rail — one continuous box, mode first, then the
                        moves. The centered layout keeps it as a left-column card. */}
                    {!zen && chesscom && (
                        <LiveModeCard flat pool={g.pool} rated={g.rated} variant={g.variant} />
                    )}

                    {/* This game is one of a tournament's pairings — a prominent,
                        always-reachable way back, since the arena only pairs us
                        again once we ask from that page (never automatically).
                        Deliberately not gated on zen mode: it's the reason this
                        game exists, not incidental chrome, and stays reachable
                        mid-game as well as after. */}
                    {g.tournamentId && (
                        <Box
                            component="button"
                            onClick={() => navigate(`/tournaments/${g.tournamentId}`)}
                            sx={{
                                display: 'flex',
                                alignItems: 'center',
                                gap: 0.75,
                                width: '100%',
                                px: 1.75,
                                py: 0.85,
                                border: 'none',
                                borderBottom: '1px solid var(--accent-line)',
                                bgcolor: 'var(--accent-soft)',
                                color: 'var(--accent)',
                                cursor: 'pointer',
                                fontFamily: 'var(--font-mono)',
                                fontSize: 11.5,
                                fontWeight: 700,
                                letterSpacing: '0.06em',
                                textTransform: 'uppercase',
                                transition: 'background-color .15s',
                                '&:hover': { bgcolor: 'var(--accent-line)' },
                            }}
                        >
                            <Trophy size={13} />
                            Tournament
                            <ChevronRight size={14} style={{ marginLeft: 'auto' }} />
                        </Box>
                    )}

                    {/* Opponent — in the chess.com layout this same bar is a strip
                        above the board instead, so the panel omits it here. */}
                    {!chesscom && opponentBar}

                    {/* Moves — a FIXED 7 rows: padded with empty rows when the game is
                        shorter and scrolling (auto-following the latest move) once it's
                        longer, so the panel height never jumps mid-game. Hidden under
                        zen mode or when the showMoveList pref is off, in which case the
                        panel simply loses that height rather than holding a blank gap. */}
                    {!zen && prefs.showMoveList && (
                        <MoveList
                            visibleRows={MOVE_LIST_ROWS}
                            moves={moveEntries}
                            currentPly={shownPly}
                            onSelectPly={selectPly}
                        />
                    )}

                    {/* Board + history controls, directly under the move list: flip and
                        sound, then step back/forward through the game — the same
                        handlers the arrow keys use, so the two paths can't diverge. */}
                    <Box
                        sx={{
                            display: 'flex',
                            alignItems: 'center',
                            gap: 1,
                            px: 1.25,
                            py: 0.75,
                            borderTop: '1px solid var(--line-soft)',
                            bgcolor: 'var(--bg-2)',
                        }}
                    >
                        <NavBtn small label="Flip board" onClick={() => setFlipped((f) => !f)}>
                            <FlipVertical2 size={18} />
                        </NavBtn>
                        <NavBtn small label={sound ? 'Mute' : 'Unmute'} onClick={toggleSound}>
                            {sound ? <Volume2 size={18} /> : <VolumeX size={18} />}
                        </NavBtn>
                        <Box sx={{ ml: 'auto', display: 'flex', gap: 1 }}>
                            <NavBtn
                                small
                                label="Previous move"
                                onClick={goPrev}
                                disabled={shownPly === 0}
                            >
                                <ChevronLeft size={18} />
                            </NavBtn>
                            <NavBtn small label="Next move" onClick={goNext} disabled={atLive}>
                                <ChevronRight size={18} />
                            </NavBtn>
                        </Box>
                    </Box>

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
                            {/* Draw / takeback / resign as equal thirds. `flex: 1` +
                                `minWidth: 0` on each child so the three stay exactly
                                even regardless of label length ("Requested…" is much
                                wider than "Draw"). */}
                            <Box
                                sx={{
                                    display: 'flex',
                                    gap: 1,
                                    '& > *': { flex: 1, minWidth: 0 },
                                }}
                            >
                                {g.drawOffer === 'mine' ? (
                                    <ActionBtn
                                        tone="neutral"
                                        icon={<Handshake size={15} />}
                                        label="Cancel"
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
                                        label="Cancel"
                                        onClick={() => gameSocket.cancelTakeback()}
                                    />
                                ) : (
                                    <ActionBtn
                                        tone="neutral"
                                        icon={<Undo2 size={15} />}
                                        label="Undo"
                                        onClick={() => gameSocket.offerTakeback()}
                                        disabled={
                                            g.takebackOffer === 'theirs' || g.moves.length === 0
                                        }
                                    />
                                )}
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
                            {/* Blunder Rewind CTA: a count baked into the button once it's
                                ready, or a quiet one-liner instead of a dead button when the
                                player had none. Nothing renders while the fetch is in flight. */}
                            {blunderCount && blunderCount.id === g.id && blunderCount.count === 0 && (
                                <Typography
                                    sx={{
                                        fontSize: 13,
                                        textAlign: 'center',
                                        color: 'var(--text-dim)',
                                    }}
                                >
                                    No blunders this game.
                                </Typography>
                            )}
                            {/* A tournament game: the arena won't pair us again on
                                its own (see socket.ts's arenaGameEnded handling) —
                                say plainly that going back is how the next game
                                happens, since nothing else on screen implies it. */}
                            {g.tournamentId && (
                                <Typography
                                    sx={{
                                        fontSize: 12.5,
                                        color: 'var(--text-dim)',
                                        textAlign: 'center',
                                    }}
                                >
                                    Head back to the tournament for your next pairing.
                                </Typography>
                            )}
                            {g.rematchOffer === 'theirs' && (
                                <OfferBanner
                                    label="Opponent wants a rematch"
                                    onAccept={() => gameSocket.acceptRematch()}
                                    onDecline={() => gameSocket.declineRematch()}
                                />
                            )}
                            <Box sx={{ display: 'flex', gap: 1 }}>
                                {g.tournamentId && (
                                    <ActionBtn
                                        tone="primary"
                                        icon={<Trophy size={15} />}
                                        label="Back to tournament"
                                        onClick={() => navigate(`/tournaments/${g.tournamentId}`)}
                                    />
                                )}
                                {g.rematchOffer === 'mine' ? (
                                    <ActionBtn
                                        tone="primary"
                                        label="Offered…"
                                        onClick={() => gameSocket.cancelRematch()}
                                    />
                                ) : g.rematchOffer === 'theirs' ? null : (
                                    <ActionBtn
                                        tone="primary"
                                        label="Rematch"
                                        onClick={() => gameSocket.offerRematch()}
                                    />
                                )}
                                {blunderCount && blunderCount.id === g.id && blunderCount.count > 0 && (
                                    <ActionBtn
                                        tone="primary"
                                        label={`Review ${blunderCount.count} blunder${blunderCount.count === 1 ? '' : 's'}`}
                                        onClick={() => navigate(`/analysis/${g.id}?rewind=1`)}
                                    />
                                )}
                                <ActionBtn
                                    tone="neutral"
                                    label="Lobby"
                                    onClick={() => {
                                        gameSocket.leave()
                                        navigate('/')
                                    }}
                                />
                                {!g.tournamentId && (
                                    <ActionBtn
                                        tone="primary"
                                        label="New game"
                                        onClick={() => {
                                            gameSocket.queue(g.pool)
                                            navigate('/')
                                        }}
                                    />
                                )}
                            </Box>
                            {/* Post-game only — carry the finished game/position into
                                analysis, the editor, a bot game, or an engine match.
                                Never mid-game (no engine assistance while playing).
                                Duck Chess has no analysable standard position, and
                                Secret Queen's reveal moves aren't legal standard chess,
                                so neither replays through the standard analyzer. The
                                game replays server-side by id, so Chess960 works too. */}
                            {g.variant !== 'duck' && !isSecretQueen && (
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

                    {/* Admin-only: engine best move toggle for the current position.
                        Sits below the action row so it never pushes the buttons around. */}
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
                                myTurn={!g.ended && g.sideToMove === g.color && !isSecretQueen}
                                isDuck={isDuck}
                                isAntichess={isAntichess}
                                duck={g.duck ?? null}
                                onHint={setBestHint}
                            />
                        </Box>
                    )}

                    {/* You — a strip below the board in the chess.com layout. */}
                    {!chesscom && myBar}

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
                )
            }
        >
            <Box sx={{ position: 'relative', width: '100%' }}>
            <Board
                fen={g.fen}
                orientation={orientation}
                sideToMove={g.sideToMove}
                legalMoves={
                    boardInteractive && !confirmMove.pending && !designating ? g.legalMoves : NO_MOVES
                }
                lastMove={atLive ? (activeOptimisticLast ?? g.lastMove) : historyLast}
                showCheck={variantHasCheck(g.variant)}
                interactive={boardInteractive && !confirmMove.pending && !designating}
                onMove={isDuck ? duck.onMove : handleBoardMove}
                hint={atLive ? bestHint : null}
                hintReveal={isAdmin}
                arrow={confirmArrow}
                premoveColor={
                    confirmMove.pending || g.ended || isDuck || !atLive || !prefs.premoves
                        ? null
                        : g.color
                }
                premoves={isDuck || !atLive ? null : interaction.premoves}
                onCancelPremove={interaction.cancelPremove}
                duck={atLive ? shownDuck : null}
                duckTargets={isDuck && atLive ? duck.duckTargets : null}
                onPlaceDuck={duck.onPlaceDuck}
                dropTargets={isCrazyhouse && atLive ? drops.dropTargets : null}
                onDrop={drops.drop}
                onDropCancel={drops.cancel}
                overrideBoard={overrideBoard}
                secretQueenSquare={
                    designating ? pick : isSecretQueen && g.secretSquare ? (g.secretSquare as Square) : null
                }
                pickTargets={pickTargets}
                onPick={setPick}
            />
            {designating && <DesignationRibbon picked={pick} />}
            {!designating && revealNote && (
                <Box
                    sx={{
                        position: 'absolute',
                        top: 0,
                        left: 0,
                        right: 0,
                        display: 'flex',
                        justifyContent: 'center',
                        pointerEvents: 'none',
                        zIndex: 6,
                        p: 1.25,
                    }}
                >
                    <Box
                        sx={{
                            px: 1.75,
                            py: 0.9,
                            borderRadius: '999px',
                            bgcolor: 'rgba(16,17,21,0.86)',
                            border: '1px solid rgba(255,255,255,0.14)',
                            boxShadow: '0 10px 30px -12px rgba(0,0,0,0.9)',
                            display: 'flex',
                            alignItems: 'center',
                            gap: 0.9,
                        }}
                    >
                        <Crown size={15} style={{ color: '#e9c168', flexShrink: 0 }} />
                        <Typography
                            sx={{
                                fontFamily: 'var(--font-display)',
                                fontWeight: 600,
                                fontSize: 13.5,
                                color: '#f3eee2',
                                whiteSpace: 'nowrap',
                            }}
                        >
                            {revealNote}
                        </Typography>
                    </Box>
                </Box>
            )}
            {confirmMove.pending && (
                <PendingMoveBar
                    pending={confirmMove.pending}
                    onConfirm={confirmMove.confirm}
                    onCancel={confirmMove.cancel}
                />
            )}

            {/* The ONLY connection-state indicator. The side panel used to carry a
                second "Reconnecting…" banner under the same condition — same message,
                same form, twice on screen, and its appearing/disappearing shifted the
                panel's height mid-game. This overlay is unmissable; don't re-add it. */}
            {conn !== 'open' && !g.ended && (
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

// This bar's own captured pieces, derived from the shared FEN-based material read
// (same logic the spectator info card uses). No numeric advantage: the pieces
// themselves say who is up and by what.
function sideMaterial(mat: Material, color: Color): { captured: string[]; glyphColor: Color } {
    const captured = color === 'w' ? mat.capturedByWhite : mat.capturedByBlack
    return { captured, glyphColor: color === 'w' ? 'b' : 'w' }
}

// Captured-piece glyph row: overlapping cburnett SVGs for the pieces a side has
// captured. Shared by the player bar (mobile) and the desktop CapturedPanel.
// Renders nothing when there's nothing to show.
function CapturedGlyphs({
    captured,
    glyphColor,
    size = 16,
    sx,
}: {
    captured: string[]
    glyphColor: Color
    size?: number
    sx?: SxProps<Theme>
}) {
    if (captured.length === 0) return null
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
        </Box>
    )
}

// Desktop captured-material panel for the left column: both players' captured
// pieces with room to breathe (the narrow player bar wraps after ~2 glyphs).
// Renders nothing until the first capture so it never shifts the layout early.
//
// memo()'d: every prop is either a primitive (opponentColor/humanColor, always
// 'w'/'b') or `mat`, which LiveGame already memoizes on `g.fen` — so this only
// re-renders when the material actually changes, not on chat/offers/presence.
const CapturedPanel = memo(function CapturedPanel({
    mat,
    opponentColor,
    humanColor,
}: {
    mat: Material
    opponentColor: Color
    humanColor: Color
}) {
    const opp = sideMaterial(mat, opponentColor)
    const you = sideMaterial(mat, humanColor)
    if (opp.captured.length === 0 && you.captured.length === 0) return null
    // Unlabelled, opponent row first — the same top-to-bottom order as the player
    // bars beside the board, and each row's pieces are the colour it captured, so a
    // name would only repeat what the glyphs and the layout already say.
    const rows = [opp, you]
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
                borderRadius: 'var(--panel-radius)',
                boxShadow: PANEL_SHADOW,
            }}
        >
            {rows.map((side, i) => (
                <Box key={i} sx={{ display: 'flex', alignItems: 'center', gap: 1, minHeight: 20 }}>
                    <CapturedGlyphs
                        captured={side.captured}
                        glyphColor={side.glyphColor}
                        size={18}
                    />
                </Box>
            ))}
        </Box>
    )
})

// memo()'d: name/title/rating/active/running/initialMs/color/online/divider/zen
// are all primitives (rating and divider are recomputed inline at the call site
// but are primitive VALUES, which shallow-compare fine regardless), `mat` is
// LiveGame's fen-keyed useMemo, and `getMs` is now a useCallback keyed to the
// clock fields it actually reads — so this bails on chat/offers/presence, which
// used to re-render both player bars (and, via Clock's getMs-keyed effect,
// re-arm the countdown interval) on every one of those events.
const PlayerBar = memo(function PlayerBar({
    name,
    title,
    rating,
    getMs,
    active,
    running,
    initialMs,
    mat,
    color,
    online,
    divider,
    zen = false,
    variant = 'rail',
}: {
    name: string
    title?: Title | null
    rating: number | null
    getMs: () => number
    active: boolean
    running: boolean
    /** The time control's initial time (ms), forwarded to Clock for the
     * clockBar preference. */
    initialMs?: number
    /** Live material read (shared) + which side this bar is, for the captured strip. */
    mat: Material
    color: Color
    online?: boolean
    divider?: 'top' | 'bottom'
    /** Zen mode: suppress the rating badge, captured strip and clock (just the name). */
    zen?: boolean
    /** Where this bar is standing.
     *  `rail` — a narrow row inside the right panel, separated from its neighbours by
     *  a hairline. The Lichess arrangement, and the default.
     *  `strip` — a standalone board-width band hugging the board, with its own card
     *  chrome. The chess.com arrangement, used when BoardPage is in that layout. */
    variant?: 'rail' | 'strip'
}) {
    const { captured, glyphColor } = sideMaterial(mat, color)
    // Single-key subscription — only re-renders this bar when the preference
    // itself changes, not on every settings edit.
    const showCaptured = useSetting('showCaptured')
    const strip = variant === 'strip'
    return (
        <Box
            sx={{
                position: 'relative',
                display: 'flex',
                alignItems: 'center',
                gap: 1.25,
                px: 1.75,
                overflow: 'hidden',
                // A rail row is a band inside the panel, divided from its neighbours by
                // a hairline; a strip is a standalone card that fills the height the
                // layout reserved for it.
                ...(strip
                    ? {
                          height: { xs: 'auto', md: '100%' },
                          // Real vertical padding even at full height: the clock cell
                          // draws a border when active, and with no padding that border
                          // reaches the strip's top and bottom edges and covers the
                          // ClockBar along the bottom.
                          py: { xs: 1.25, md: 0.75 },
                          bgcolor: 'var(--surface)',
                          border: '1px solid var(--line-soft)',
                          borderRadius: 'var(--panel-radius)',
                      }
                    : {
                          py: 1.25,
                          bgcolor: 'var(--bg-2)',
                          borderTop: divider === 'top' ? '1px solid var(--line-soft)' : undefined,
                          borderBottom:
                              divider === 'bottom' ? '1px solid var(--line-soft)' : undefined,
                      }),
            }}
        >
            <Avatar small>
                <User size={15} />
            </Avatar>
            <Box sx={{ minWidth: 0 }}>
                <Box sx={{ display: 'flex', alignItems: 'baseline', gap: 0.75, minWidth: 0 }}>
                    {!zen && <TitleBadge title={title} />}
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
            {/* Rail: compact strip in the bar on MOBILE only — on desktop the captured
                pieces live in the roomy left-column CapturedPanel (no wrapping).
                Strip: shown at every breakpoint, because in that layout the strip IS
                where captured material lives — there's no column beside the board to
                defer to, and the board-width band has room for it. */}
            {!zen && showCaptured && (
                <CapturedGlyphs
                    captured={captured}
                    glyphColor={glyphColor}
                    sx={{
                        display: strip ? 'flex' : { xs: 'flex', md: 'none' },
                        maxWidth: strip ? 260 : 150,
                    }}
                />
            )}
            {!zen && (
                <Box sx={{ ml: 'auto' }}>
                    <Clock getMs={getMs} active={active} running={running} compact={strip} />
                </Box>
            )}
            {/* Full-bleed along the bottom of the whole row, not just under the
                digits — so the remaining-time line reads as the row's own meter. */}
            {!zen && (
                <ClockBar
                    getMs={getMs}
                    active={active}
                    running={running}
                    initialMs={initialMs}
                />
            )}
        </Box>
    )
})

// A subtle opening-name strip for live play. Self-fetches the position's opening
// name (ECO + name) as the game develops, showing NOTHING until one is known so it
// never shifts the layout. Renders only the name — never candidate moves or evals —
// so it gives no engine assistance during the game.
//
// The name is STICKY: once an opening has been identified it stays for the rest of
// the game. Every game leaves book eventually, and letting the label vanish at that
// moment both loses the one bit of context worth keeping ("this was a Najdorf") and
// shifts the column. A later, more specific name still replaces an earlier one —
// only the drop back to "no opening" is ignored.
//
// memo()'d: its one prop, `fen`, is a primitive string — this only re-renders
// (and re-fires its fetch effect) when the position actually changes, not on
// every LiveGame render in between.
const LiveOpening = memo(function LiveOpening({ fen }: { fen: string }) {
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
                if (alive && res.opening) setOpening(res.opening)
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
                borderRadius: 'var(--panel-radius)',
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
})

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
