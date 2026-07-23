import { type ReactNode, useEffect, useMemo, useState } from 'react'
import { useLocation } from 'react-router-dom'
import {
    Box,
    CircularProgress,
    Slider,
    ToggleButton,
    ToggleButtonGroup,
    Typography,
} from '@mui/material'
import {
    Bot,
    ChevronFirst,
    ChevronLast,
    ChevronLeft,
    ChevronRight,
    Flag,
    FlipVertical2,
    Play,
    RotateCcw,
    Undo2,
    User,
    Volume2,
    VolumeX,
} from 'lucide-react'
import Board from '../components/Board'
import EvalBar, { type WhiteEval } from '../components/EvalBar'
import MoveList from '../components/MoveList'
import GameModeCard from '../components/GameModeCard'
import NewBadge from '../components/NewBadge'
import BoardPage from '../components/BoardPage'
import { ActionBtn, Avatar, ErrorBanner, NavBtn } from '../components/PanelUI'
import ConfirmDialog from '../components/ConfirmDialog'
import OpeningPanel from '../components/OpeningPanel'
import {
    analyze,
    type BotGame as Game,
    type Color,
    createBotGame,
    playMove,
    undoMove,
} from '../api/client'
import { statusLabel, type Square } from '../lib/chess'
import { computeMaterial } from '../lib/material'
import { buildFromMoves } from '../lib/analysisTree'
import { useBoardInteraction } from '../lib/useBoardInteraction'
import { useDuckInteraction } from '../lib/useDuckInteraction'
import { useCrazyhouseDrops } from '../lib/useCrazyhouseDrops'
import PocketPanel from '../components/PocketPanel'
import { useMoveNavKeys } from '../lib/useMoveNavKeys'
import {
    type ColorChoice,
    coordToRating,
    loadBotSettings,
    ratingLabel,
    ratingToCoord,
    RATING_SLIDER_MAX,
    RATING_SLIDER_MIN,
    saveBotSettings,
    UNLOSABLE_RATING,
} from '../lib/botSettings'
import { playForSan, setSoundEnabled, soundEnabled, sounds } from '../lib/sounds'
import { useAuth } from '../lib/auth'
import { usePrefs } from '../lib/settings'
import AdminBestMove from '../components/AdminBestMove'
import BoardActions from '../components/BoardActions'
import VariantPicker from '../components/VariantPicker'
import {
    type Variant,
    random960,
    parsePocket,
    pocketFromFen,
    stripCrazyhouseFen,
} from '../lib/variants'

const START_FEN = 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1'
const other = (c: Color): Color => (c === 'w' ? 'b' : 'w')

// Eval-bar depth ladder: a shallow first guess lands in a few ms (so the bar
// tracks the live position instead of lagging a full move behind), then deepens.
const EVAL_DEPTHS = [4, 8, 12, 16]

// Duck Chess only: the human move and the bot's reply come back in ONE response
// (the shared duck has already been relocated by the bot). Hold the player's own
// duck placement on screen for at least this long before revealing the bot's
// reply, so they actually see where their duck went instead of an instant jump.
const DUCK_REVEAL_MS = 550

// The side to move encoded in a FEN's active-color field (defaults to White).
const sideToMoveOf = (fen: string): Color => (fen.split(' ')[1] === 'b' ? 'b' : 'w')

// Fading and Glass Jaw run the engine at a strength the BACKEND computes per move
// (fading Elo / check-triggered Elo loss) — the setup slider has nothing to set,
// so it's hidden for these two.
const FIXED_STRENGTH_VARIANTS: Variant[] = ['fading', 'glassjaw']

// Whether `v` is played on the standard rules engine (movegen, checkmate, opening
// book) — true for everything here except Duck, Crazyhouse, and Antichess, which
// each have their own rules surface.
const usesStandardRules = (v: Variant): boolean =>
    v === 'standard' ||
    v === 'chess960' ||
    v === 'fading' ||
    v === 'glassjaw' ||
    v === 'doublemove'

// Whether `v` alternates one ply per side per turn. Double Move is the only
// exception (two human plies per Zugzwang reply), which breaks ply-indexed
// opening lookup and standard-game replay/analysis.
const isAlternating = (v: Variant): boolean => v !== 'doublemove'

export default function BotGame() {
    // A FEN carried over from the analysis board ("Play bot from this position").
    const navFen = (useLocation().state as { fen?: string } | null)?.fen ?? null

    // Last-used setup, restored from localStorage so a refresh keeps the player's
    // rating / variant / color instead of snapping back to defaults.
    const saved = useState(loadBotSettings)[0]

    const [game, setGame] = useState<Game | null>(null)
    const [startFen, setStartFen] = useState<string | null>(navFen)
    const [rating, setRating] = useState(saved.rating)
    // A carried-over position dictates the side to play; otherwise use the saved choice.
    const [colorChoice, setColorChoice] = useState<ColorChoice>(
        navFen ? sideToMoveOf(navFen) : saved.colorChoice,
    )
    const [variant, setVariant] = useState<Variant>(saved.variant)
    const [creating, setCreating] = useState(false)
    const [thinking, setThinking] = useState(false)
    const [error, setError] = useState<string | null>(null)
    const [flipped, setFlipped] = useState(false)
    const [resigned, setResigned] = useState(false)
    const [sound, setSound] = useState(soundEnabled())
    const [analyzedEval, setAnalyzedEval] = useState<WhiteEval | null>(null)
    const [viewIndex, setViewIndex] = useState<number | null>(null) // null = live
    // Duck Chess: the human's just-placed duck square, shown during the brief
    // reveal hold before the bot's reply lands (null when not holding).
    const [duckReveal, setDuckReveal] = useState<string | null>(null)
    // Guarded-resign modal (only shown when the confirmResign preference is on).
    const [confirmResignOpen, setConfirmResignOpen] = useState(false)
    // Guarded "New game" modal — only shown when a game is still ongoing (starting
    // a fresh one would silently throw the live game away).
    const [confirmNewGameOpen, setConfirmNewGameOpen] = useState(false)
    // Admin best-move hint squares (from the AdminBestMove toggle in MovePanel),
    // drawn as near-invisible pixel dots on the board. Null when off/off-turn.
    const [bestHint, setBestHint] = useState<{ from: Square; to: Square } | null>(null)

    const { user } = useAuth()
    const isAdmin = user?.role === 'admin'
    const prefs = usePrefs()

    const humanColor: Color = game?.human_color ?? (colorChoice === 'random' ? 'w' : colorChoice)
    const over = resigned || (game != null && game.status !== 'ongoing')
    const ongoing = !!game && !over

    const isDuck = game?.variant === 'duck'
    const isCrazyhouse = game?.variant === 'crazyhouse'
    // Antichess plays on a normal board (no pockets, no duck placement) — it needs
    // none of the special interaction wiring below, only the standard controller
    // and a couple of display-only exclusions (eval bar, check highlight).
    const isAntichess = game?.variant === 'antichess'

    // Persist the setup whenever it changes, so it survives a refresh.
    useEffect(() => {
        saveBotSettings({ rating, colorChoice, variant })
    }, [rating, colorChoice, variant])

    const liveLen = game?.moves.length ?? 0
    const shownPly = viewIndex === null ? liveLen : Math.min(viewIndex, liveLen)
    const atLive = shownPly === liveLen
    const interactive = ongoing && atLive && game.your_turn && !thinking

    // Submit a move to the server and fold in the bot's reply. Shared by the
    // standard and Duck controllers — the move string is a plain UCI in normal
    // play and a composite "<pieceUci>:<duckSquare>" in Duck Chess; the API and
    // engine treat it opaquely, so this path is identical for both.
    const submitMove = async (uci: string) => {
        if (!game) return
        setError(null)
        setViewIndex(null)
        setThinking(true)
        try {
            const g = await playMove(game.id, uci)
            setGame(g)
            voiceServerReply(game.moves.length, g)
        } catch (e) {
            setError(e instanceof Error ? e.message : 'Move failed.')
        } finally {
            setThinking(false)
        }
    }

    // Duck Chess submit: the server returns the human move AND the bot's reply in a
    // single response (both sides relocate the one shared duck). Show the player's
    // own duck placement for a beat before revealing the reply — the optimistic
    // piece-move overlay + `duckReveal` render the completed human turn during the
    // hold, then setGame swaps in the bot's move.
    const submitDuckMove = async (composite: string) => {
        if (!game) return
        const placed = composite.split(':')[1] ?? null
        const priorCount = game.moves.length
        setError(null)
        setViewIndex(null)
        setThinking(true)
        setDuckReveal(placed)
        const started = performance.now()
        try {
            const g = await playMove(game.id, composite)
            const wait = DUCK_REVEAL_MS - (performance.now() - started)
            if (wait > 0) await new Promise((r) => setTimeout(r, wait))
            setGame(g)
            voiceServerReply(priorCount, g)
        } catch (e) {
            setError(e instanceof Error ? e.message : 'Move failed.')
        } finally {
            setDuckReveal(null)
            setThinking(false)
        }
    }

    // Two board controllers, both hooks called unconditionally (only one is ever
    // "live" — the other is inert with myTurn:false). Standard/Chess960 use the
    // shared optimistic+premove controller; Duck Chess uses the two-phase
    // piece-then-duck controller. The variant picks which one drives <Board>.
    const interaction = useBoardInteraction({
        fen: game?.fen ?? startFen ?? START_FEN,
        myTurn: interactive && !isDuck,
        legalMoves: interactive && !isDuck && game ? game.legal_moves : [],
        canPremove: prefs.premoves,
        submit: submitMove,
    })
    const duck = useDuckInteraction({
        fen: game?.fen ?? START_FEN,
        duck: game?.duck ?? null,
        myTurn: interactive && isDuck,
        legalMoves: interactive && isDuck && game ? game.legal_moves : [],
        submit: submitDuckMove,
    })
    // Crazyhouse drops coexist with the standard controller (piece moves use it):
    // a drop is submitted as a plain "<P>@<sq>" move via the same submitMove.
    const drops = useCrazyhouseDrops(
        interactive && isCrazyhouse && game ? game.legal_moves : [],
        interactive && isCrazyhouse,
        submitMove,
    )

    // The optimistic overlay + last-move highlight come from whichever controller
    // is live for this variant.
    const activeOverride = isDuck ? duck.override : interaction.override
    const activeOptimisticLast = isDuck ? duck.optimisticLast : interaction.optimisticLast

    // The FEN of the shown position (canonical — for Crazyhouse this still carries
    // the [pocket] and ~ marks). The board renderer wants a plain FEN, so strip
    // that markup; the pocket is parsed from the same raw FEN for the pocket strips.
    const rawShownFen = !game
        ? (startFen ?? START_FEN)
        : atLive
          ? game.fen
          : shownPly === 0
            ? START_FEN
            : game.moves[shownPly - 1].fen
    const boardFen = isCrazyhouse ? stripCrazyhouseFen(rawShownFen) : rawShownFen
    const pockets = parsePocket(isCrazyhouse ? pocketFromFen(rawShownFen) : '')

    // Board orientation. Auto-flip (a preference) OVERRIDES the manual flip button:
    // the board re-orients to the side to move each ply (in play and in review).
    // Otherwise the flip button toggles between the human's view and its mirror.
    const orientation: Color = prefs.autoFlip
        ? sideToMoveOf(rawShownFen)
        : flipped
          ? other(humanColor)
          : humanColor

    // Whether the side to move in the SHOWN position is in check — derived from the
    // last played move's SAN (a checking move ends in "+" / a mating one in "#"), so
    // the king glow works in bot games without any extra engine/network probe.
    const shownInCheck = shownPly > 0 && /[+#]$/.test(game?.moves[shownPly - 1]?.san ?? '')

    const lastMove =
        activeOverride && atLive && activeOptimisticLast
            ? activeOptimisticLast
            : game && shownPly > 0
              ? {
                    from: game.moves[shownPly - 1].uci.slice(0, 2),
                    to: game.moves[shownPly - 1].uci.slice(2, 4),
                }
              : null

    // The duck's square to render: at the live position it's the game's duck,
    // hidden while the local player's move is mid-flight (the duck is "in hand"
    // during placement and until the server reply lands). When reviewing history
    // it's the duck recorded on that ply.
    const shownDuck: string | null = isDuck
        ? duckReveal != null
            ? duckReveal // reveal hold: show the player's own just-placed duck
            : atLive
              ? activeOverride
                  ? null // mid-placement: the duck is "in hand"
                  : (game?.duck ?? null)
              : (game?.moves[shownPly - 1]?.duck ?? null)
        : null

    // Eval bar — full-strength analysis of the live position, level-independent.
    // Streams in layers (shallow depth first, then deeper) so a number lands almost
    // immediately and refines, instead of holding the previous position's eval for a
    // full ~1.5s search and only then snapping to the new one. The value is always
    // White-relative (+ = White better, − = Black better), matching every other bar.
    useEffect(() => {
        if (!prefs.showEvalBar) {
            // Bar hidden by preference — don't spend engine calls analyzing it.
            setAnalyzedEval(null)
            return
        }
        if (!game || isDuck || isCrazyhouse || isAntichess) {
            // Duck Chess, Crazyhouse, and Antichess aren't understood by the standard
            // /analyze engine (the duck, pockets/drops, and compulsory-capture rules
            // respectively) — no meaningful eval bar to show.
            setAnalyzedEval(null)
            return
        }
        if (game.status !== 'ongoing') {
            if (game.status === 'checkmate') {
                const winner: Color = game.side_to_move === 'w' ? 'b' : 'w'
                setAnalyzedEval({ type: 'mate', white: winner === 'w' ? 1 : -1 })
            } else {
                setAnalyzedEval({ type: 'cp', white: 0 })
            }
            return
        }
        const fen = game.fen
        const stm = game.side_to_move
        let cancelled = false
        // Abort the in-flight search when we leave this position, so the previous
        // position's trailing deep call doesn't hog an engine worker and delay the
        // new position's first shallow guess.
        const ac = new AbortController()
        const run = async () => {
            for (const depth of EVAL_DEPTHS) {
                if (cancelled) return
                let r: Awaited<ReturnType<typeof analyze>>
                try {
                    r = await analyze(fen, { depth, signal: ac.signal })
                } catch {
                    return // aborted or engine error — keep the last shown eval
                }
                if (cancelled || !r.eval) continue
                const white = stm === 'w' ? r.eval.value : -r.eval.value
                setAnalyzedEval({ type: r.eval.type, white })
                if (r.eval.type === 'mate') return // mate found — deeper won't change it
                if (r.depth != null && r.depth < depth) return // hit time ceiling — settled
            }
        }
        void run()
        return () => {
            cancelled = true
            ac.abort()
        }
    }, [game?.fen, game?.status, game?.side_to_move, prefs.showEvalBar])

    // Re-entering /bot from the analysis board with a different position: adopt it
    // and drop back to the setup screen (the initial state only reads navFen once).
    useEffect(() => {
        if (!navFen) return
        setStartFen(navFen)
        setColorChoice(sideToMoveOf(navFen))
        setGame(null)
    }, [navFen])

    async function newGame() {
        setError(null)
        setCreating(true)
        setResigned(false)
        setFlipped(false)
        setViewIndex(null)
        const color: Color =
            colorChoice === 'random' ? (Math.random() < 0.5 ? 'w' : 'b') : colorChoice
        // Chess960 gets a fresh random back-rank; Duck Chess always starts from the
        // standard position (its rules, not the layout, are what differ); Standard
        // honors a position carried over from the analysis board.
        const fen =
            variant === 'chess960'
                ? random960()
                : variant === 'standard'
                  ? (startFen ?? undefined)
                  : undefined
        try {
            const g = await createBotGame(rating, color, { variant, fen })
            setGame(g)
            const opener = g.moves[g.moves.length - 1]
            if (opener) playForSan(opener.san, g.status !== 'ongoing')
        } catch (e) {
            setError(e instanceof Error ? e.message : 'Could not start a game.')
        } finally {
            setCreating(false)
        }
    }

    function voiceServerReply(priorCount: number, g: Game) {
        const fresh = g.moves.slice(priorCount + 1)
        const gameOver = g.status !== 'ongoing'
        if (fresh.length > 0) playForSan(fresh[fresh.length - 1].san, gameOver)
        else if (gameOver) sounds.end()
    }

    // Take back the human's last move (plus any bot reply since). Available once
    // the human has actually moved, while the game is live and nothing's in flight.
    // Duck Chess and Double Move undo aren't supported (stateless duck-move engine;
    // Double Move's non-alternating plies, server-side).
    const canUndo =
        ongoing &&
        !thinking &&
        !isDuck &&
        game?.variant !== 'doublemove' &&
        !!game?.moves.some((m) => m.by === 'human')
    async function undo() {
        if (!game || thinking) return
        setError(null)
        setViewIndex(null)
        setThinking(true)
        try {
            const g = await undoMove(game.id)
            setGame(g)
            sounds.move()
        } catch (e) {
            setError(e instanceof Error ? e.message : 'Undo failed.')
        } finally {
            setThinking(false)
        }
    }

    function resign() {
        if (!ongoing) return
        setResigned(true)
        setAnalyzedEval({ type: 'mate', white: humanColor === 'w' ? -1 : 1 })
        sounds.end()
    }

    // Resign action for the UI: confirm first when the preference asks for it,
    // otherwise resign immediately. The dialog's onConfirm calls resign() directly.
    function requestResign() {
        if (!ongoing) return
        if (prefs.confirmResign) setConfirmResignOpen(true)
        else resign()
    }

    // Drop the current game and return to the setup screen.
    function discardGame() {
        setGame(null)
        setStartFen(null)
    }

    // "New game" action for the UI: confirm first when a game is still in progress
    // (one click would otherwise wipe it), otherwise return to setup immediately.
    function requestNewGame() {
        if (ongoing) setConfirmNewGameOpen(true)
        else discardGame()
    }

    function toggleSound() {
        const next = !sound
        setSound(next)
        setSoundEnabled(next)
        if (next) sounds.move()
    }

    // Move navigation
    const goFirst = () => setViewIndex(0)
    const goPrev = () => setViewIndex(Math.max(0, shownPly - 1))
    const goNext = () => {
        const n = Math.min(liveLen, shownPly + 1)
        setViewIndex(n >= liveLen ? null : n)
    }
    const goLast = () => setViewIndex(null)
    const selectPly = (p: number) => setViewIndex(p >= liveLen ? null : p)

    // Arrow keys scrub the move history (client-side review only; the live game is
    // untouched). Enabled once a game exists.
    useMoveNavKeys({
        onPrev: goPrev,
        onNext: goNext,
        onFirst: goFirst,
        onLast: goLast,
        enabled: !!game,
    })

    const resultScore = resigned ? (humanColor === 'w' ? '0-1' : '1-0') : (game?.result ?? null)
    const caption = !atLive
        ? `Reviewing ${shownPly} / ${liveLen}`
        : over
          ? resigned
              ? `You resigned · ${resultScore}`
              : `${game ? statusLabel(game.status, { variant: game.variant, fen: game.fen }) : ''}${resultScore ? ` · ${resultScore}` : ''}`
          : thinking
            ? 'Bot is thinking…'
            : game
              ? game.your_turn
                  ? 'Your turn'
                  : `${game.side_to_move === 'w' ? 'White' : 'Black'} to move`
              : 'Choose a rating and start'
    const statusTone: StatusTone = !atLive
        ? 'dim'
        : over
          ? 'accent'
          : ongoing && game!.your_turn
            ? 'bright'
            : 'dim'

    return (
        <BoardPage
            left={
                <>
                    {isCrazyhouse && game && (
                        <PocketPanel
                            orientation={orientation}
                            humanColor={humanColor}
                            pockets={pockets}
                            selected={drops.selected}
                            myTurn={interactive}
                            onSelect={drops.selectPocket}
                        />
                    )}
                    <Box sx={{ display: { xs: 'none', md: 'block' } }}>
                        <GameModeCard
                            rating={game?.rating ?? rating}
                            variant={game?.variant ?? variant}
                        />
                    </Box>
                </>
            }
            evalBar={
                prefs.showEvalBar && !(prefs.zenMode && ongoing) ? (
                    <EvalBar ev={analyzedEval} orientation={orientation} />
                ) : undefined
            }
            right={
                game ? (
                    <MovePanel
                        game={game}
                        rating={rating}
                        ongoing={ongoing}
                        canUndo={canUndo}
                        shownPly={shownPly}
                        sound={sound}
                        caption={caption}
                        statusTone={statusTone}
                        error={error}
                        onSelectPly={selectPly}
                        onFirst={goFirst}
                        onPrev={goPrev}
                        onNext={goNext}
                        onLast={goLast}
                        onFlip={() => setFlipped((f) => !f)}
                        onToggleSound={toggleSound}
                        onUndo={undo}
                        onResign={requestResign}
                        onNewGame={requestNewGame}
                        showMoveList={prefs.showMoveList}
                        zen={prefs.zenMode && ongoing}
                        isAdmin={isAdmin}
                        bestFen={boardFen}
                        bestMyTurn={interactive && !isCrazyhouse}
                        onBestHint={setBestHint}
                        gameStartFen={startFen ?? START_FEN}
                    />
                ) : (
                    <>
                        <Setup
                            rating={rating}
                            colorChoice={colorChoice}
                            variant={variant}
                            creating={creating}
                            customStart={!!startFen}
                            onRating={setRating}
                            onColor={setColorChoice}
                            onVariant={(v) => {
                                setVariant(v)
                                // "Unlosable" (worst-move) is a Standard-only strength;
                                // every other bot ignores rating 0 (Double Move forwards
                                // it to the engine, where 0 would mean worst-move), so
                                // leaving Standard at that stop must snap to a real rating.
                                if (v !== 'standard' && rating <= UNLOSABLE_RATING) setRating(1500)
                                // Fading/Glass Jaw are always full-force — the backend
                                // overrides strength per move regardless of the stored
                                // rating, but keep it a real (full-strength) value so
                                // GameModeCard's rating readout reads sensibly.
                                if (FIXED_STRENGTH_VARIANTS.includes(v)) setRating(3500)
                            }}
                            onStart={newGame}
                        />
                        {error && <ErrorBanner sx={{ mt: 1.5 }}>{error}</ErrorBanner>}
                    </>
                )
            }
        >
            <Board
                fen={boardFen}
                orientation={orientation}
                sideToMove={game?.side_to_move ?? 'w'}
                legalMoves={interactive ? game.legal_moves : []}
                lastMove={lastMove}
                inCheck={shownInCheck}
                interactive={interactive}
                hint={atLive ? bestHint : null}
                hintReveal={isAdmin}
                onMove={isDuck ? duck.onMove : interaction.onMove}
                premoveColor={ongoing && atLive && !isDuck && prefs.premoves ? humanColor : null}
                premoves={atLive && !isDuck ? interaction.premoves : null}
                onCancelPremove={interaction.cancelPremove}
                duck={shownDuck}
                duckTargets={isDuck && atLive ? duck.duckTargets : null}
                onPlaceDuck={duck.onPlaceDuck}
                dropTargets={isCrazyhouse && atLive ? drops.dropTargets : null}
                onDrop={drops.drop}
                onDropCancel={drops.cancel}
                {...(activeOverride && atLive ? { overrideBoard: activeOverride } : {})}
            />
            {/* Resign confirmation — only reached when the confirmResign preference
                is on (requestResign resigns directly otherwise). */}
            <ConfirmDialog
                open={confirmResignOpen}
                title="Resign this game?"
                message="You'll forfeit the game — this counts as a loss."
                confirmLabel="Resign"
                danger
                onConfirm={resign}
                onClose={() => setConfirmResignOpen(false)}
            />
            {/* "New game" guard — only opened mid-game (requestNewGame returns to
                setup directly once the game is over). */}
            <ConfirmDialog
                open={confirmNewGameOpen}
                title="Abandon this game?"
                message="Your game in progress will be discarded."
                confirmLabel="New game"
                onConfirm={discardGame}
                onClose={() => setConfirmNewGameOpen(false)}
            />
        </BoardPage>
    )
}

type StatusTone = 'bright' | 'accent' | 'dim'
const TONE_COLOR: Record<StatusTone, string> = {
    bright: 'var(--text)',
    accent: 'var(--accent)',
    dim: 'var(--text-dim)',
}

function MovePanel({
    game,
    rating,
    ongoing,
    canUndo,
    shownPly,
    sound,
    caption,
    statusTone,
    error,
    onSelectPly,
    onFirst,
    onPrev,
    onNext,
    onLast,
    onFlip,
    onToggleSound,
    onUndo,
    onResign,
    onNewGame,
    showMoveList,
    zen,
    isAdmin,
    bestFen,
    bestMyTurn,
    onBestHint,
    gameStartFen,
}: {
    game: Game
    rating: number
    ongoing: boolean
    canUndo: boolean
    shownPly: number
    sound: boolean
    caption: string
    statusTone: StatusTone
    error: string | null
    onSelectPly: (p: number) => void
    onFirst: () => void
    onPrev: () => void
    onNext: () => void
    onLast: () => void
    onFlip: () => void
    onToggleSound: () => void
    onUndo: () => void
    onResign: () => void
    onNewGame: () => void
    /** Show the SAN move grid (preference). Nav controls stay either way. */
    showMoveList: boolean
    /** Zen mode active for this (ongoing) game — hide rating chrome. */
    zen: boolean
    isAdmin: boolean
    bestFen: string
    bestMyTurn: boolean
    onBestHint: (hint: { from: Square; to: Square } | null) => void
    gameStartFen: string
}) {
    // Captured-material readout for the player rows, derived from the SHOWN board
    // (so it tracks history review, like the eval bar). `captured(c)` = the pieces
    // color `c` has taken (its opponent's color); `advantage(c)` = c's point lead.
    const mat = useMemo(() => computeMaterial(bestFen), [bestFen])
    const human = game.human_color
    const opp = other(human)
    const captured = (c: Color) => (c === 'w' ? mat.capturedByWhite : mat.capturedByBlack)
    const advantage = (c: Color) => {
        const d = c === 'w' ? mat.diff : -mat.diff
        return d > 0 ? d : 0
    }

    // A linear tree of the game so far, so the engine-owned OpeningPanel can name
    // the opening (and show candidate lines) for the live position during play.
    const book = useMemo(
        () =>
            buildFromMoves(
                gameStartFen,
                game.moves.map((m) => m.uci),
            ),
        [gameStartFen, game.moves],
    )

    return (
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
                boxShadow: '0 18px 50px -28px rgba(0,0,0,0.8)',
            }}
        >
            {/* Opponent */}
            <Box
                sx={{
                    display: 'flex',
                    alignItems: 'center',
                    gap: 1.25,
                    px: 1.75,
                    py: 1.5,
                    bgcolor: 'var(--bg-2)',
                    borderBottom: '1px solid var(--line-soft)',
                }}
            >
                <Avatar>
                    <Bot size={18} />
                </Avatar>
                <Box sx={{ minWidth: 0, lineHeight: 1.2 }}>
                    <Box sx={{ display: 'flex', alignItems: 'center', gap: 0.75 }}>
                        <Typography
                            sx={{
                                fontFamily: 'var(--font-display)',
                                fontWeight: 700,
                                fontSize: 15.5,
                            }}
                        >
                            Zugzwang
                        </Typography>
                        <NewBadge />
                    </Box>
                    {/* Zen mode hides the rating chrome (distraction-free play). */}
                    {!zen && (
                        <Typography sx={{ fontSize: 12.5, color: 'var(--text-dim)' }}>
                            Engine · {ratingLabel(game.rating ?? rating)}
                        </Typography>
                    )}
                </Box>
                <MaterialStrip pieces={captured(opp)} color={human} adv={advantage(opp)} />
            </Box>

            {error && <ErrorBanner>{error}</ErrorBanner>}

            {/* Move grid (fills the panel). Hidden by preference keeps the nav
                controls below — a flex spacer holds the footer at the bottom. */}
            {showMoveList ? (
                <MoveList fill moves={game.moves} currentPly={shownPly} onSelectPly={onSelectPly} />
            ) : (
                <Box sx={{ flex: 1, minHeight: 0 }} />
            )}

            {/* Opening name (+ candidate lines) for the live position. Standard-rules
                AND alternating only (the explorer/engine only understand standard,
                one-ply-per-side chess — Fading/Glass Jaw qualify, Double Move doesn't);
                hidden in zen mode, like the eval bar. Self-fetches, no layout shift. */}
            {usesStandardRules(game.variant) && isAlternating(game.variant) && (
                <OpeningPanel
                    tree={book.tree}
                    currentId={book.lastId}
                    engineOn={!zen}
                    onMove={() => {}}
                />
            )}

            {/* Footer: you + status, navigation, actions */}
            <Box
                sx={{
                    borderTop: '1px solid var(--line-soft)',
                    bgcolor: 'var(--bg-2)',
                    p: 1.25,
                    display: 'flex',
                    flexDirection: 'column',
                    gap: 1.25,
                }}
            >
                <Box sx={{ display: 'flex', alignItems: 'center', gap: 1.25 }}>
                    <Avatar small>
                        <User size={15} />
                    </Avatar>
                    <Typography
                        sx={{ fontFamily: 'var(--font-display)', fontWeight: 700, fontSize: 14.5 }}
                    >
                        You
                    </Typography>
                    <MaterialStrip pieces={captured(human)} color={opp} adv={advantage(human)} />
                    <Box sx={{ flex: 1 }} />
                    <Typography
                        sx={{ fontSize: 13, fontWeight: 600, color: TONE_COLOR[statusTone] }}
                    >
                        {caption}
                    </Typography>
                </Box>

                <Box sx={{ display: 'flex', alignItems: 'center', gap: 0.5 }}>
                    <NavBtn label="First move" onClick={onFirst} grow>
                        <ChevronFirst size={21} />
                    </NavBtn>
                    <NavBtn label="Previous" onClick={onPrev} grow>
                        <ChevronLeft size={21} />
                    </NavBtn>
                    <NavBtn label="Next" onClick={onNext} grow>
                        <ChevronRight size={21} />
                    </NavBtn>
                    <NavBtn label="Latest" onClick={onLast} grow>
                        <ChevronLast size={21} />
                    </NavBtn>
                    <Box sx={{ width: '1px', height: 26, bgcolor: 'var(--line)', mx: 0.5 }} />
                    <NavBtn label="Flip board" onClick={onFlip}>
                        <FlipVertical2 size={19} />
                    </NavBtn>
                    <NavBtn label={sound ? 'Mute' : 'Unmute'} onClick={onToggleSound}>
                        {sound ? <Volume2 size={19} /> : <VolumeX size={19} />}
                    </NavBtn>
                </Box>

                {isAdmin && (
                    <AdminBestMove
                        fen={bestFen}
                        myTurn={bestMyTurn}
                        isAntichess={game.variant === 'antichess'}
                        onHint={onBestHint}
                    />
                )}

                <Box sx={{ display: 'flex', gap: 1 }}>
                    {ongoing && (
                        <ActionBtn
                            tone="neutral"
                            icon={<Undo2 size={15} />}
                            label="Undo"
                            disabled={!canUndo}
                            onClick={onUndo}
                        />
                    )}
                    {ongoing && (
                        <ActionBtn
                            tone="danger"
                            icon={<Flag size={15} />}
                            label="Resign"
                            onClick={onResign}
                        />
                    )}
                    <ActionBtn
                        tone="primary"
                        icon={<RotateCcw size={15} />}
                        label="New game"
                        onClick={onNewGame}
                    />
                </Box>

                {/* Once the game is over, offer to carry the position elsewhere —
                    never mid-game (no engine crutch while playing). Duck Chess has
                    no analysable standard position; Chess960 can't replay from the
                    standard start, so it gets position-level actions only. Fading and
                    Glass Jaw alternate normally and replay as standard games; Double
                    Move's non-alternating plies don't. */}
                {!ongoing && game.variant !== 'duck' && (
                    <BoardActions
                        fen={game.fen}
                        analyzeGame={
                            isAlternating(game.variant) && usesStandardRules(game.variant)
                                ? { moves: game.moves.map((m) => m.uci), startFen: gameStartFen }
                                : null
                        }
                        omit={['play-bot']}
                        playDisabled={game.legal_moves.length === 0}
                    />
                )}
            </Box>
        </Box>
    )
}

/** A player row's captured pieces (opponent's color, overlapped) + a signed "+N"
 * material-advantage badge. Mirrors the SpectateInfoCard readout so material reads
 * the same across the app. Renders nothing when there's nothing captured and no lead. */
function MaterialStrip({ pieces, color, adv }: { pieces: string[]; color: Color; adv: number }) {
    if (pieces.length === 0 && adv <= 0) return null
    return (
        <Box
            sx={{
                display: 'flex',
                alignItems: 'center',
                flexWrap: 'wrap',
                gap: '1px',
                minWidth: 0,
            }}
        >
            {pieces.map((t, i) => (
                <Box
                    key={i}
                    component="img"
                    src={`/piece/cburnett/${color}${t}.svg`}
                    alt={t}
                    sx={{ width: 18, height: 18, ml: i > 0 && pieces[i - 1] === t ? '-6px' : 0 }}
                />
            ))}
            {adv > 0 && (
                <Typography
                    sx={{
                        ml: pieces.length > 0 ? 0.5 : 0,
                        fontFamily: 'var(--font-mono)',
                        fontSize: 12.5,
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

function Setup({
    rating,
    colorChoice,
    variant,
    creating,
    customStart,
    onRating,
    onColor,
    onVariant,
    onStart,
}: {
    rating: number
    colorChoice: ColorChoice
    variant: Variant
    creating: boolean
    customStart: boolean
    onRating: (n: number) => void
    onColor: (c: ColorChoice) => void
    onVariant: (v: Variant) => void
    onStart: () => void
}) {
    // The carried-over "play from this position" note only applies to a standard
    // game — Chess960 uses a random back-rank and Duck Chess always starts fresh.
    const subtitle =
        variant === 'chess960'
            ? 'Play a random Chess960 (Fischer Random) position.'
            : variant === 'duck'
              ? 'Play Duck Chess — capture the king; the duck blocks every square.'
              : variant === 'crazyhouse'
                ? 'Play Crazyhouse — captured pieces switch sides and can be dropped back in.'
                : variant === 'antichess'
                  ? 'Play Antichess — captures are compulsory; lose every piece (or get stalemated) to win.'
                  : variant === 'fading'
                    ? 'Play Fading — Zugzwang starts at full strength and loses 100 Elo with every move it makes.'
                    : variant === 'glassjaw'
                      ? 'Play Glass Jaw — full strength, but every check you land costs Zugzwang 300 Elo for good.'
                      : variant === 'doublemove'
                        ? "Play Double Move — two moves for every one of Zugzwang's; a check on your first move takes the king and wins."
                        : customStart
                          ? 'Play the Zugzwang engine from this position.'
                          : 'Play the Zugzwang engine.'
    return (
        <Box
            sx={{
                bgcolor: 'var(--surface)',
                border: '1px solid var(--line-soft)',
                borderRadius: '14px',
                p: 2.75,
                display: 'flex',
                flexDirection: 'column',
                gap: 2.75,
                boxShadow: '0 18px 50px -28px rgba(0,0,0,0.8)',
            }}
        >
            <Box>
                <Typography
                    sx={{
                        fontFamily: 'var(--font-display)',
                        fontSize: 24,
                        fontWeight: 700,
                        lineHeight: 1.1,
                    }}
                >
                    New game
                </Typography>
                <Typography sx={{ fontSize: 13.5, color: 'var(--text-dim)', mt: 0.5 }}>
                    {subtitle}
                </Typography>
            </Box>

            <Box>
                <Label>Mode</Label>
                <Box sx={{ mt: 1 }}>
                    <VariantPicker value={variant} onChange={onVariant} disabled={creating} />
                </Box>
            </Box>

            {FIXED_STRENGTH_VARIANTS.includes(variant) ? (
                // Fading and Glass Jaw are always full-force — the backend computes
                // their per-move strength itself, so the rating slider has nothing
                // to set.
                <Box>
                    <Label>Opponent rating</Label>
                    <Typography sx={{ fontSize: 12.5, color: 'var(--muted)', mt: 0.5 }}>
                        {variant === 'fading'
                            ? 'Full strength — Zugzwang weakens as the game goes on.'
                            : 'Full strength — until you start checking it.'}
                    </Typography>
                </Box>
            ) : (
                <Box>
                    <Box
                        sx={{
                            display: 'flex',
                            alignItems: 'baseline',
                            justifyContent: 'space-between',
                            mb: 0.5,
                        }}
                    >
                        <Label>Opponent rating</Label>
                        <Typography
                            sx={{
                                fontFamily: 'var(--font-mono)',
                                fontSize: 15,
                                fontWeight: 700,
                                color: 'var(--accent)',
                            }}
                        >
                            {ratingLabel(rating)}
                        </Typography>
                    </Box>
                    <Box sx={{ px: 0.5 }}>
                        {/* The slider works in "coordinate" space so its lowest stop can
                            be the Unlosable sentinel (stored as rating 0, one notch below
                            the 700 floor) without a dead 0..700 gap in the track. */}
                        <Slider
                            value={ratingToCoord(rating)}
                            onChange={(_, v) => onRating(coordToRating(v as number))}
                            // The Unlosable stop (below the 700 floor) is Standard-only;
                            // other variants start the track at the real-rating floor.
                            min={variant === 'standard' ? RATING_SLIDER_MIN : 700}
                            max={RATING_SLIDER_MAX}
                            step={50}
                            valueLabelDisplay="auto"
                            valueLabelFormat={(v) => ratingLabel(coordToRating(v))}
                            sx={sliderSx}
                        />
                    </Box>
                    <Typography sx={{ fontSize: 12.5, color: 'var(--muted)', mt: 0.25 }}>
                        {ratingHint(rating)}
                    </Typography>
                </Box>
            )}

            <Box>
                <Label>Play as</Label>
                <ToggleButtonGroup
                    exclusive
                    fullWidth
                    size="small"
                    value={colorChoice}
                    onChange={(_, v) => v && onColor(v as ColorChoice)}
                    sx={toggleSx}
                >
                    <ToggleButton value="w">White</ToggleButton>
                    <ToggleButton value="b">Black</ToggleButton>
                    <ToggleButton value="random">Random</ToggleButton>
                </ToggleButtonGroup>
            </Box>

            <ActionBtn
                tone="primary"
                large
                disabled={creating}
                icon={
                    creating ? <CircularProgress size={16} color="inherit" /> : <Play size={16} />
                }
                label={creating ? 'Starting…' : 'Start game'}
                onClick={onStart}
            />
        </Box>
    )
}

function Label({ children }: { children: ReactNode }) {
    return (
        <Typography
            sx={{
                fontFamily: 'var(--font-mono)',
                fontSize: 11,
                letterSpacing: '0.16em',
                textTransform: 'uppercase',
                color: 'var(--muted)',
            }}
        >
            {children}
        </Typography>
    )
}

function ratingHint(rating: number): string {
    if (rating <= UNLOSABLE_RATING)
        return 'Unlosable — the engine plays the worst move it can find. You cannot lose.'
    if (rating < 1000) return 'Beginner — frequent blunders, gentle.'
    if (rating < 1400) return 'Casual — a fair improver, the odd slip.'
    if (rating < 1800) return 'Club — punishes loose play.'
    if (rating < 2200) return 'Strong — accurate, hard to outplay.'
    if (rating < 2600) return 'Expert — sharp, rarely inaccurate.'
    if (rating < 2900) return 'Master — near-flawless play.'
    if (rating < 3500) return 'Grandmaster — superhuman, faint imperfections.'
    return 'Maximum — the full engine at full strength, no weakening at all.'
}

const sliderSx = {
    color: 'var(--accent)',
    height: 5,
    '& .MuiSlider-rail': { opacity: 0.4, bgcolor: 'var(--line)' },
    '& .MuiSlider-track': { border: 'none' },
    '& .MuiSlider-thumb': {
        width: 18,
        height: 18,
        bgcolor: '#f3eee2',
        boxShadow: '0 1px 4px rgba(0,0,0,0.5)',
        '&:hover, &.Mui-focusVisible': { boxShadow: '0 0 0 8px rgba(216,166,87,0.18)' },
        '&.Mui-active': { boxShadow: '0 0 0 12px rgba(216,166,87,0.22)' },
    },
    '& .MuiSlider-mark': { bgcolor: 'var(--muted)', height: 4, opacity: 0.6 },
    '& .MuiSlider-markActive': { bgcolor: 'var(--accent)', opacity: 1 },
    '& .MuiSlider-valueLabel': {
        bgcolor: 'var(--surface-2)',
        color: 'var(--text)',
        borderRadius: '6px',
        fontFamily: 'var(--font-mono)',
        fontWeight: 700,
    },
}

const toggleSx = {
    mt: 1,
    gap: 0.75,
    '& .MuiToggleButton-root': {
        color: 'var(--text-dim)',
        border: '1px solid var(--line)',
        borderRadius: '10px !important',
        textTransform: 'none',
        fontFamily: 'var(--font-display)',
        fontWeight: 600,
        fontSize: 13.5,
        py: 0.9,
        transition: 'color .15s, background .15s, border-color .15s',
        '&:hover': { background: 'var(--line)', color: 'var(--accent)' },
        '&.Mui-selected': {
            color: '#15171c',
            background: 'linear-gradient(180deg, #e3b56a, #d8a657)',
            borderColor: 'var(--accent)',
            '&:hover': { background: 'linear-gradient(180deg, #e7bd76, #dcab5d)' },
        },
    },
}
