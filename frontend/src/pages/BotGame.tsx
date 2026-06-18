import { type ReactNode, useEffect, useState } from 'react'
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
  User,
  Volume2,
  VolumeX,
} from 'lucide-react'
import Board from '../components/Board'
import EvalBar, { type WhiteEval } from '../components/EvalBar'
import MoveList from '../components/MoveList'
import GameModeCard from '../components/GameModeCard'
import { ActionBtn, Avatar, ErrorBanner, NavBtn } from '../components/PanelUI'
import { analyze, type BotGame as Game, type Color, createBotGame, playMove } from '../api/client'
import { applyUciVisually, type BoardMap, fileOf, parseFen, statusLabel } from '../lib/chess'
import { playForSan, setSoundEnabled, soundEnabled, sounds } from '../lib/sounds'

const START_FEN = 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1'
const other = (c: Color): Color => (c === 'w' ? 'b' : 'w')
type ColorChoice = 'w' | 'b' | 'random'

export default function BotGame() {
  const [game, setGame] = useState<Game | null>(null)
  const [level, setLevel] = useState(4)
  const [colorChoice, setColorChoice] = useState<ColorChoice>('w')
  const [creating, setCreating] = useState(false)
  const [thinking, setThinking] = useState(false)
  const [override, setOverride] = useState<BoardMap | null>(null)
  const [optimisticLast, setOptimisticLast] = useState<{ from: string; to: string } | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [flipped, setFlipped] = useState(false)
  const [resigned, setResigned] = useState(false)
  const [sound, setSound] = useState(soundEnabled())
  const [analyzedEval, setAnalyzedEval] = useState<WhiteEval | null>(null)
  const [viewIndex, setViewIndex] = useState<number | null>(null) // null = live

  const humanColor: Color = game?.human_color ?? (colorChoice === 'random' ? 'w' : colorChoice)
  const orientation: Color = flipped ? other(humanColor) : humanColor
  const over = resigned || (game != null && game.status !== 'ongoing')
  const ongoing = !!game && !over

  const liveLen = game?.moves.length ?? 0
  const shownPly = viewIndex === null ? liveLen : Math.min(viewIndex, liveLen)
  const atLive = shownPly === liveLen
  const interactive = ongoing && atLive && game.your_turn && !thinking

  const boardFen = !game
    ? START_FEN
    : atLive
      ? game.fen
      : shownPly === 0
        ? START_FEN
        : game.moves[shownPly - 1].fen

  const lastMove =
    override && atLive && optimisticLast
      ? optimisticLast
      : game && shownPly > 0
        ? {
            from: game.moves[shownPly - 1].uci.slice(0, 2),
            to: game.moves[shownPly - 1].uci.slice(2, 4),
          }
        : null

  // Eval bar — full-strength analysis of the live position, level-independent.
  useEffect(() => {
    if (!game) {
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
    let cancelled = false
    analyze(game.fen)
      .then((r) => {
        if (cancelled || !r.eval) return
        const white = game.side_to_move === 'w' ? r.eval.value : -r.eval.value
        setAnalyzedEval({ type: r.eval.type, white })
      })
      .catch(() => {})
    return () => {
      cancelled = true
    }
  }, [game?.fen, game?.status, game?.side_to_move])

  async function newGame() {
    setError(null)
    setCreating(true)
    setOverride(null)
    setOptimisticLast(null)
    setResigned(false)
    setFlipped(false)
    setViewIndex(null)
    const color: Color = colorChoice === 'random' ? (Math.random() < 0.5 ? 'w' : 'b') : colorChoice
    try {
      const g = await createBotGame(level, color)
      setGame(g)
      const opener = g.moves[g.moves.length - 1]
      if (opener) playForSan(opener.san, g.status !== 'ongoing')
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not start a game.')
    } finally {
      setCreating(false)
    }
  }

  async function onMove(uci: string) {
    if (!game) return
    setError(null)
    setViewIndex(null)
    const before = parseFen(game.fen)
    setOverride(applyUciVisually(before, uci))
    setOptimisticLast({ from: uci.slice(0, 2), to: uci.slice(2, 4) })
    setThinking(true)
    playHumanSound(before, uci)
    try {
      const g = await playMove(game.id, uci)
      setGame(g)
      voiceServerReply(game.moves.length, g)
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Move failed.')
    } finally {
      setOverride(null)
      setOptimisticLast(null)
      setThinking(false)
    }
  }

  function playHumanSound(board: BoardMap, uci: string) {
    const from = uci.slice(0, 2)
    const to = uci.slice(2, 4)
    const piece = board[from]?.toLowerCase()
    if (uci.length === 5) sounds.promote()
    else if (piece === 'k' && Math.abs(fileOf(to) - fileOf(from)) === 2) sounds.castle()
    else if (board[to] || (piece === 'p' && from[0] !== to[0])) sounds.capture()
    else sounds.move()
  }

  function voiceServerReply(priorCount: number, g: Game) {
    const fresh = g.moves.slice(priorCount + 1)
    const gameOver = g.status !== 'ongoing'
    if (fresh.length > 0) playForSan(fresh[fresh.length - 1].san, gameOver)
    else if (gameOver) sounds.end()
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
          : 'Choose a level and start'
  const statusTone: StatusTone = !atLive ? 'dim' : over ? 'accent' : ongoing && game!.your_turn ? 'bright' : 'dim'

  return (
    <Box
      sx={{
        flex: 1,
        display: 'grid',
        // Same board sizing as LiveGame: 320px side columns, a board that fills
        // almost the full height. Equal gutters keep the board centered.
        gridTemplateColumns: {
          xs: '1fr',
          lg: '320px min(calc(100vh - 120px), calc(100vw - 752px), 880px) 320px',
        },
        alignItems: { xs: 'center', lg: 'stretch' },
        justifyItems: 'center',
        columnGap: { lg: 4 },
        rowGap: 3,
        px: { xs: 2, md: 3 },
        py: { xs: 3, lg: 2 },
      }}
    >
      {/* Left — game mode, top-aligned (mirrors the right column to center the board) */}
      <Box
        sx={{
          display: { xs: 'none', lg: 'block' },
          justifySelf: 'end',
          alignSelf: 'start',
          width: '100%',
        }}
      >
        <GameModeCard level={game?.level ?? level} />
      </Box>

      {/* Center — board, top-aligned so its top lines up with the side cards */}
      <Box
        sx={{
          alignSelf: 'start',
          width: { xs: 'min(94vw, 64vh)', lg: '100%' },
          display: 'flex',
          gap: { xs: 0.75, md: 1.25 },
          alignItems: 'stretch',
        }}
      >
        <EvalBar ev={analyzedEval} orientation={orientation} />
        <Box sx={{ flex: 1, minWidth: 0 }}>
          <Board
            fen={boardFen}
            orientation={orientation}
            sideToMove={game?.side_to_move ?? 'w'}
            legalMoves={interactive ? game.legal_moves : []}
            lastMove={lastMove}
            inCheck={false}
            interactive={interactive}
            onMove={onMove}
            {...(override && atLive ? { overrideBoard: override } : {})}
          />
        </Box>
      </Box>

      {/* Right — full-height move panel, or the setup card (top-aligned) */}
      <Box
        sx={{
          justifySelf: { lg: 'start' },
          alignSelf: { xs: 'auto', lg: game ? 'stretch' : 'start' },
          width: '100%',
          maxWidth: { xs: 'min(94vw, 64vh)', lg: 'none' },
          minHeight: 0,
          display: 'flex',
          flexDirection: 'column',
        }}
      >
        {game ? (
          <MovePanel
            game={game}
            level={level}
            ongoing={ongoing}
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
            onResign={resign}
            onNewGame={() => setGame(null)}
          />
        ) : (
          <>
            <Setup
              level={level}
              colorChoice={colorChoice}
              creating={creating}
              onLevel={setLevel}
              onColor={setColorChoice}
              onStart={newGame}
            />
            {error && <ErrorBanner sx={{ mt: 1.5 }}>{error}</ErrorBanner>}
          </>
        )}
      </Box>
    </Box>
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
  level,
  ongoing,
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
  onResign,
  onNewGame,
}: {
  game: Game
  level: number
  ongoing: boolean
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
  onResign: () => void
  onNewGame: () => void
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
        <Avatar><Bot size={18} /></Avatar>
        <Box sx={{ minWidth: 0, lineHeight: 1.2 }}>
          <Typography sx={{ fontFamily: 'var(--font-display)', fontWeight: 700, fontSize: 15.5 }}>gomachine</Typography>
          <Typography sx={{ fontSize: 12.5, color: 'var(--text-dim)' }}>Engine · Level {game.level ?? level}</Typography>
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
          <Avatar small><User size={15} /></Avatar>
          <Typography sx={{ fontFamily: 'var(--font-display)', fontWeight: 700, fontSize: 14.5 }}>You</Typography>
          <Box sx={{ flex: 1 }} />
          <Typography sx={{ fontSize: 13, fontWeight: 600, color: TONE_COLOR[statusTone] }}>{caption}</Typography>
        </Box>

        <Box sx={{ display: 'flex', alignItems: 'center', gap: 0.5 }}>
          <NavBtn label="First move" onClick={onFirst} grow><ChevronFirst size={21} /></NavBtn>
          <NavBtn label="Previous" onClick={onPrev} grow><ChevronLeft size={21} /></NavBtn>
          <NavBtn label="Next" onClick={onNext} grow><ChevronRight size={21} /></NavBtn>
          <NavBtn label="Latest" onClick={onLast} grow><ChevronLast size={21} /></NavBtn>
          <Box sx={{ width: '1px', height: 26, bgcolor: 'var(--line)', mx: 0.5 }} />
          <NavBtn label="Flip board" onClick={onFlip}><FlipVertical2 size={19} /></NavBtn>
          <NavBtn label={sound ? 'Mute' : 'Unmute'} onClick={onToggleSound}>
            {sound ? <Volume2 size={19} /> : <VolumeX size={19} />}
          </NavBtn>
        </Box>

        <Box sx={{ display: 'flex', gap: 1 }}>
          {ongoing && <ActionBtn tone="danger" icon={<Flag size={15} />} label="Resign" onClick={onResign} />}
          <ActionBtn tone="primary" icon={<RotateCcw size={15} />} label="New game" onClick={onNewGame} />
        </Box>
      </Box>
    </Box>
  )
}

function Setup({
  level,
  colorChoice,
  creating,
  onLevel,
  onColor,
  onStart,
}: {
  level: number
  colorChoice: ColorChoice
  creating: boolean
  onLevel: (n: number) => void
  onColor: (c: ColorChoice) => void
  onStart: () => void
}) {
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
        <Typography sx={{ fontFamily: 'var(--font-display)', fontSize: 24, fontWeight: 700, lineHeight: 1.1 }}>
          New game
        </Typography>
        <Typography sx={{ fontSize: 13.5, color: 'var(--text-dim)', mt: 0.5 }}>Play the gomachine engine.</Typography>
      </Box>

      <Box>
        <Box sx={{ display: 'flex', alignItems: 'baseline', justifyContent: 'space-between', mb: 0.5 }}>
          <Label>Difficulty</Label>
          <Typography sx={{ fontFamily: 'var(--font-mono)', fontSize: 15, fontWeight: 700, color: 'var(--accent)' }}>
            Level {level}
          </Typography>
        </Box>
        <Box sx={{ px: 0.5 }}>
          <Slider
            value={level}
            onChange={(_, v) => onLevel(v as number)}
            min={0}
            max={10}
            step={1}
            marks
            valueLabelDisplay="auto"
            sx={sliderSx}
          />
        </Box>
        <Typography sx={{ fontSize: 12.5, color: 'var(--muted)', mt: 0.25 }}>{levelHint(level)}</Typography>
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
        icon={creating ? <CircularProgress size={16} color="inherit" /> : <Play size={16} />}
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

function levelHint(level: number): string {
  if (level <= 1) return 'Gentle — short thinking, the odd blunder.'
  if (level <= 4) return 'Casual — a fair club-level opponent.'
  if (level <= 7) return 'Strong — punishes loose play.'
  if (level <= 9) return 'Very strong — deep, accurate search.'
  return 'Maximum — the full engine, no mercy.'
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
