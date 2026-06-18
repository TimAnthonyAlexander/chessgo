import { type ReactNode, useEffect, useState } from 'react'
import {
  Alert,
  Box,
  Button,
  CircularProgress,
  Slider,
  ToggleButton,
  ToggleButtonGroup,
  Tooltip,
  Typography,
} from '@mui/material'
import {
  ChevronFirst,
  ChevronLast,
  ChevronLeft,
  ChevronRight,
  Flag,
  FlipVertical2,
  RotateCcw,
  Volume2,
  VolumeX,
} from 'lucide-react'
import Board from '../components/Board'
import EvalBar, { type WhiteEval } from '../components/EvalBar'
import MoveList from '../components/MoveList'
import GameModeCard from '../components/GameModeCard'
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
    ? `Reviewing move ${shownPly} / ${liveLen}`
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

  return (
    <Box
      sx={{
        flex: 1,
        display: 'grid',
        gridTemplateColumns: { xs: '1fr', lg: '1fr auto 1fr' },
        alignItems: 'center',
        justifyItems: 'center',
        columnGap: { lg: 4 },
        rowGap: 3,
        px: { xs: 2, md: 3 },
        py: { xs: 3, lg: 2 },
      }}
    >
      {/* Left — game mode (desktop only) */}
      <Box sx={{ display: { xs: 'none', lg: 'block' }, justifySelf: 'end', width: '100%', maxWidth: 290 }}>
        <GameModeCard level={game?.level ?? level} />
      </Box>

      {/* Center — perfectly centered board (auto column with equal 1fr gutters) */}
      <Box
        sx={{
          width: { xs: 'min(94vw, 64vh)', lg: 'min(calc(100vh - 100px), calc(100vw - 780px), 820px)' },
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

      {/* Right — move panel / setup */}
      <Box sx={{ justifySelf: { lg: 'start' }, width: '100%', maxWidth: { xs: 'min(94vw, 64vh)', lg: 320 } }}>
        {game ? (
          <MovePanel
            game={game}
            level={level}
            ongoing={ongoing}
            shownPly={shownPly}
            sound={sound}
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
          <Setup
            level={level}
            colorChoice={colorChoice}
            creating={creating}
            onLevel={setLevel}
            onColor={setColorChoice}
            onStart={newGame}
          />
        )}

        {error && (
          <Alert severity="error" variant="outlined" sx={{ mt: 2, fontSize: 13 }}>
            {error}
          </Alert>
        )}

        <Typography
          sx={{
            mt: 1.75,
            fontFamily: 'var(--font-display)',
            fontSize: 17,
            fontWeight: 600,
            color: !atLive ? 'var(--text-dim)' : over ? 'var(--accent)' : ongoing && game!.your_turn ? 'var(--text)' : 'var(--text-dim)',
          }}
        >
          {caption}
        </Typography>
      </Box>
    </Box>
  )
}

function MovePanel({
  game,
  level,
  ongoing,
  shownPly,
  sound,
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
        bgcolor: '#1b1e24',
        border: '1px solid var(--line)',
        borderRadius: 2.5,
        overflow: 'hidden',
      }}
    >
      {/* Header strip */}
      <Box sx={{ display: 'flex', alignItems: 'center', gap: 1, px: 1.75, py: 1.25, bgcolor: '#23272f' }}>
        <Dot color="#7bb661" />
        <Typography sx={{ fontWeight: 600, fontSize: 14.5 }}>gomachine</Typography>
        <Typography sx={{ ml: 'auto', fontFamily: 'var(--font-mono)', fontSize: 12, color: 'var(--text-dim)' }}>
          level {game.level ?? level}
        </Typography>
      </Box>

      {/* Navigation toolbar */}
      <Box
        sx={{
          display: 'flex',
          alignItems: 'center',
          px: 0.5,
          py: 0.25,
          borderBottom: '1px solid var(--line-soft)',
        }}
      >
        <PanelIcon label="Flip board" onClick={onFlip}>
          <FlipVertical2 size={16} />
        </PanelIcon>
        <PanelIcon label={sound ? 'Mute' : 'Unmute'} onClick={onToggleSound}>
          {sound ? <Volume2 size={16} /> : <VolumeX size={16} />}
        </PanelIcon>
        <Box sx={{ flex: 1 }} />
        <PanelIcon label="First move" onClick={onFirst}>
          <ChevronFirst size={17} />
        </PanelIcon>
        <PanelIcon label="Previous" onClick={onPrev}>
          <ChevronLeft size={17} />
        </PanelIcon>
        <PanelIcon label="Next" onClick={onNext}>
          <ChevronRight size={17} />
        </PanelIcon>
        <PanelIcon label="Latest" onClick={onLast}>
          <ChevronLast size={17} />
        </PanelIcon>
      </Box>

      {/* Move grid */}
      <MoveList moves={game.moves} currentPly={shownPly} onSelectPly={onSelectPly} />

      {/* Actions */}
      <Box
        sx={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          gap: 1,
          py: 0.75,
          borderTop: '1px solid var(--line-soft)',
        }}
      >
        {ongoing && (
          <PanelIcon label="Resign" onClick={onResign}>
            <Flag size={15} />
          </PanelIcon>
        )}
        <PanelIcon label="New game" onClick={onNewGame}>
          <RotateCcw size={15} />
        </PanelIcon>
      </Box>

      {/* Footer */}
      <Box sx={{ display: 'flex', alignItems: 'center', gap: 1, px: 1.75, py: 1.25, bgcolor: '#23272f' }}>
        <Dot color="#7bb661" />
        <Typography sx={{ fontWeight: 600, fontSize: 14.5 }}>You</Typography>
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
        bgcolor: '#1b1e24',
        border: '1px solid var(--line)',
        borderRadius: 2.5,
        p: 2.5,
        display: 'flex',
        flexDirection: 'column',
        gap: 2.5,
      }}
    >
      <Box>
        <Label>Difficulty · level {level}</Label>
        <Box sx={{ px: 0.5 }}>
          <Slider
            value={level}
            onChange={(_, v) => onLevel(v as number)}
            min={0}
            max={10}
            step={1}
            marks
            valueLabelDisplay="auto"
            sx={{ color: 'var(--accent)' }}
          />
        </Box>
        <Typography sx={{ fontSize: 12, color: 'var(--muted)', mt: -0.5 }}>{levelHint(level)}</Typography>
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

      <Button
        variant="contained"
        onClick={onStart}
        disabled={creating}
        startIcon={creating ? <CircularProgress size={15} color="inherit" /> : <RotateCcw size={15} />}
      >
        Start game
      </Button>
    </Box>
  )
}

function Dot({ color }: { color: string }) {
  return <Box sx={{ width: 9, height: 9, borderRadius: '50%', background: color, flexShrink: 0 }} />
}

function PanelIcon({ label, onClick, children }: { label: string; onClick: () => void; children: ReactNode }) {
  return (
    <Tooltip title={label} arrow>
      <Box
        component="button"
        onClick={onClick}
        sx={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          width: 32,
          height: 30,
          border: 'none',
          background: 'transparent',
          color: 'var(--text-dim)',
          borderRadius: 1.5,
          cursor: 'pointer',
          '&:hover': { color: 'var(--accent)', background: 'var(--accent-soft)' },
        }}
      >
        {children}
      </Box>
    </Tooltip>
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
        mb: 1,
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

const toggleSx = {
  '& .MuiToggleButton-root': {
    color: 'var(--text-dim)',
    border: '1px solid var(--line)',
    textTransform: 'none',
    fontWeight: 600,
    fontSize: 13,
    py: 0.7,
    '&.Mui-selected': {
      color: 'var(--accent)',
      background: 'var(--accent-soft)',
      borderColor: 'var(--accent-line)',
      '&:hover': { background: 'var(--accent-soft)' },
    },
  },
}
