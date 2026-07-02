import { type ReactNode, useEffect, useState } from 'react'
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
import BoardPage from '../components/BoardPage'
import { ActionBtn, Avatar, ErrorBanner, NavBtn } from '../components/PanelUI'
import {
    analyze,
    type BotGame as Game,
    type Color,
    createBotGame,
    playMove,
    undoMove,
} from '../api/client'
import { statusLabel } from '../lib/chess'
import { useBoardInteraction } from '../lib/useBoardInteraction'
import { useDuckInteraction } from '../lib/useDuckInteraction'
import { playForSan, setSoundEnabled, soundEnabled, sounds } from '../lib/sounds'
import { useAuth } from '../lib/auth'
import AdminBestMove from '../components/AdminBestMove'
import BoardActions from '../components/BoardActions'
import VariantPicker from '../components/VariantPicker'
import { type Variant, random960 } from '../lib/variants'

const START_FEN = 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1'
const other = (c: Color): Color => (c === 'w' ? 'b' : 'w')
type ColorChoice = 'w' | 'b' | 'random'

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

export default function BotGame() {
    // A FEN carried over from the analysis board ("Play bot from this position").
    const navFen = (useLocation().state as { fen?: string } | null)?.fen ?? null

    const [game, setGame] = useState<Game | null>(null)
    const [startFen, setStartFen] = useState<string | null>(navFen)
    const [rating, setRating] = useState(1500)
    // Default to playing whichever side is to move in the carried-over position.
    const [colorChoice, setColorChoice] = useState<ColorChoice>(navFen ? sideToMoveOf(navFen) : 'w')
    const [variant, setVariant] = useState<Variant>('standard')
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

    const { user } = useAuth()
    const isAdmin = user?.role === 'admin'

    const humanColor: Color = game?.human_color ?? (colorChoice === 'random' ? 'w' : colorChoice)
    const orientation: Color = flipped ? other(humanColor) : humanColor
    const over = resigned || (game != null && game.status !== 'ongoing')
    const ongoing = !!game && !over

    const isDuck = game?.variant === 'duck'

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
        canPremove: true,
        submit: submitMove,
    })
    const duck = useDuckInteraction({
        fen: game?.fen ?? START_FEN,
        duck: game?.duck ?? null,
        myTurn: interactive && isDuck,
        legalMoves: interactive && isDuck && game ? game.legal_moves : [],
        submit: submitDuckMove,
    })

    // The optimistic overlay + last-move highlight come from whichever controller
    // is live for this variant.
    const activeOverride = isDuck ? duck.override : interaction.override
    const activeOptimisticLast = isDuck ? duck.optimisticLast : interaction.optimisticLast

    const boardFen = !game
        ? (startFen ?? START_FEN)
        : atLive
          ? game.fen
          : shownPly === 0
            ? START_FEN
            : game.moves[shownPly - 1].fen

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
        if (!game || game.variant === 'duck') {
            // Duck Chess has no check/checkmate and the /analyze engine doesn't
            // understand the duck — there's no meaningful eval bar to show.
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
    }, [game?.fen, game?.status, game?.side_to_move])

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
    // Duck Chess undo isn't supported (the duck-move engine is stateless).
    const canUndo = ongoing && !thinking && !isDuck && !!game?.moves.some((m) => m.by === 'human')
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

    const resultScore = resigned ? (humanColor === 'w' ? '0-1' : '1-0') : (game?.result ?? null)
    const caption = !atLive
        ? `Reviewing ${shownPly} / ${liveLen}`
        : over
          ? resigned
              ? `You resigned · ${resultScore}`
              : `${game ? statusLabel(game.status) : ''}${resultScore ? ` · ${resultScore}` : ''}`
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
                <Box sx={{ display: { xs: 'none', md: 'block' } }}>
                    <GameModeCard rating={game?.rating ?? rating} variant={game?.variant ?? variant} />
                </Box>
            }
            evalBar={<EvalBar ev={analyzedEval} orientation={orientation} />}
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
                        onResign={resign}
                        onNewGame={() => {
                            setGame(null)
                            setStartFen(null)
                        }}
                        isAdmin={isAdmin}
                        bestFen={boardFen}
                        bestMyTurn={interactive}
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
                            onVariant={setVariant}
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
                inCheck={false}
                interactive={interactive}
                onMove={isDuck ? duck.onMove : interaction.onMove}
                premoveColor={ongoing && atLive && !isDuck ? humanColor : null}
                premove={atLive && !isDuck ? interaction.premove : null}
                onCancelPremove={interaction.cancelPremove}
                duck={shownDuck}
                duckTargets={isDuck && atLive ? duck.duckTargets : null}
                onPlaceDuck={duck.onPlaceDuck}
                {...(activeOverride && atLive ? { overrideBoard: activeOverride } : {})}
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
    isAdmin,
    bestFen,
    bestMyTurn,
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
    isAdmin: boolean
    bestFen: string
    bestMyTurn: boolean
    gameStartFen: string
}) {
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
                    <Typography
                        sx={{ fontFamily: 'var(--font-display)', fontWeight: 700, fontSize: 15.5 }}
                    >
                        gomachine
                    </Typography>
                    <Typography sx={{ fontSize: 12.5, color: 'var(--text-dim)' }}>
                        Engine · ~{game.rating ?? rating} Elo
                    </Typography>
                </Box>
            </Box>

            {error && <ErrorBanner>{error}</ErrorBanner>}

            {/* Move grid (fills the panel) */}
            <MoveList fill moves={game.moves} currentPly={shownPly} onSelectPly={onSelectPly} />

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

                {isAdmin && <AdminBestMove fen={bestFen} myTurn={bestMyTurn} />}

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
                    standard start, so it gets position-level actions only. */}
                {!ongoing && game.variant !== 'duck' && (
                    <BoardActions
                        fen={game.fen}
                        analyzeGame={
                            game.variant === 'standard'
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
              : customStart
                ? 'Play the gomachine engine from this position.'
                : 'Play the gomachine engine.'
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
                        ~{rating} Elo
                    </Typography>
                </Box>
                <Box sx={{ px: 0.5 }}>
                    <Slider
                        value={rating}
                        onChange={(_, v) => onRating(v as number)}
                        min={700}
                        max={2900}
                        step={50}
                        valueLabelDisplay="auto"
                        sx={sliderSx}
                    />
                </Box>
                <Typography sx={{ fontSize: 12.5, color: 'var(--muted)', mt: 0.25 }}>
                    {ratingHint(rating)}
                </Typography>
            </Box>

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
    if (rating < 1000) return 'Beginner — frequent blunders, gentle.'
    if (rating < 1400) return 'Casual — a fair improver, the odd slip.'
    if (rating < 1800) return 'Club — punishes loose play.'
    if (rating < 2200) return 'Strong — accurate, hard to outplay.'
    if (rating < 2600) return 'Expert — deep, precise search.'
    return 'Master — the full engine, no mercy.'
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
