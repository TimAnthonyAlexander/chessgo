import { type ReactNode, useState } from 'react'
import {
  Alert,
  Box,
  Button,
  CircularProgress,
  Paper,
  Slider,
  ToggleButton,
  ToggleButtonGroup,
  Typography,
} from '@mui/material'
import { Flag, RotateCcw } from 'lucide-react'
import Board from '../components/Board'
import MoveList from '../components/MoveList'
import { type BotGame as Game, type Color, createBotGame, playMove } from '../api/client'
import { applyUciVisually, type BoardMap, parseFen, statusLabel } from '../lib/chess'

const START_FEN = 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1'

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

  const orientation: Color = game?.human_color ?? (colorChoice === 'random' ? 'w' : colorChoice)
  const fen = game?.fen ?? START_FEN
  const over = game != null && game.status !== 'ongoing'
  const interactive = !!game && game.status === 'ongoing' && game.your_turn && !thinking

  const lastEntry = game && game.moves.length ? game.moves[game.moves.length - 1] : null
  const lastMove =
    optimisticLast ??
    (lastEntry ? { from: lastEntry.uci.slice(0, 2), to: lastEntry.uci.slice(2, 4) } : null)

  async function newGame() {
    setError(null)
    setCreating(true)
    setOverride(null)
    setOptimisticLast(null)
    const color: Color = colorChoice === 'random' ? (Math.random() < 0.5 ? 'w' : 'b') : colorChoice
    try {
      const g = await createBotGame(level, color)
      setGame(g)
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not start a game.')
    } finally {
      setCreating(false)
    }
  }

  async function onMove(uci: string) {
    if (!game) return
    setError(null)
    setOverride(applyUciVisually(parseFen(game.fen), uci))
    setOptimisticLast({ from: uci.slice(0, 2), to: uci.slice(2, 4) })
    setThinking(true)
    try {
      const g = await playMove(game.id, uci)
      setGame(g)
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Move failed.')
    } finally {
      setOverride(null)
      setOptimisticLast(null)
      setThinking(false)
    }
  }

  return (
    <Box
      sx={{
        flex: 1,
        display: 'grid',
        gridTemplateColumns: { xs: '1fr', md: 'minmax(320px, 1fr) 340px' },
        gap: { xs: 3, md: 5 },
        alignItems: 'start',
        maxWidth: 1000,
        width: '100%',
        mx: 'auto',
        px: { xs: 2.5, md: 4 },
        py: { xs: 3, md: 6 },
      }}
    >
      <Box sx={{ minWidth: 0 }}>
        <Board
          fen={fen}
          orientation={orientation}
          sideToMove={game?.side_to_move ?? 'w'}
          legalMoves={game?.legal_moves ?? []}
          lastMove={lastMove}
          inCheck={false}
          interactive={interactive}
          onMove={onMove}
          {...(override ? { overrideBoard: override } : {})}
        />
      </Box>

      <Paper sx={{ p: 2.5, borderRadius: 3, display: 'flex', flexDirection: 'column', gap: 2.5 }}>
        <StatusBar game={game} thinking={thinking} over={over} />

        {error && (
          <Alert severity="error" variant="outlined" sx={{ fontSize: 13 }}>
            {error}
          </Alert>
        )}

        <Box>
          <Label>Difficulty · level {level}</Label>
          <Box sx={{ px: 0.5 }}>
            <Slider
              value={level}
              onChange={(_, v) => setLevel(v as number)}
              min={0}
              max={10}
              step={1}
              marks
              valueLabelDisplay="auto"
              sx={{ color: 'var(--accent)' }}
            />
          </Box>
          <Typography sx={{ fontSize: 12, color: 'var(--muted)', mt: -0.5 }}>
            {levelHint(level)}
          </Typography>
        </Box>

        <Box>
          <Label>Play as</Label>
          <ToggleButtonGroup
            exclusive
            fullWidth
            size="small"
            value={colorChoice}
            onChange={(_, v) => v && setColorChoice(v as ColorChoice)}
            sx={toggleSx}
          >
            <ToggleButton value="w">White</ToggleButton>
            <ToggleButton value="b">Black</ToggleButton>
            <ToggleButton value="random">Random</ToggleButton>
          </ToggleButtonGroup>
        </Box>

        <Button
          variant="contained"
          onClick={newGame}
          disabled={creating}
          startIcon={creating ? <CircularProgress size={16} color="inherit" /> : <RotateCcw size={16} />}
        >
          {game ? 'New game' : 'Start game'}
        </Button>

        <Box>
          <Label>Moves</Label>
          <MoveList moves={game?.moves ?? []} />
        </Box>
      </Paper>
    </Box>
  )
}

function StatusBar({ game, thinking, over }: { game: Game | null; thinking: boolean; over: boolean }) {
  let primary = 'Set up a game'
  let accent = false
  if (game) {
    if (over) {
      primary = statusLabel(game.status)
    } else if (thinking) {
      primary = 'Bot is thinking…'
    } else if (game.your_turn) {
      primary = 'Your move'
      accent = true
    } else {
      primary = `${game.side_to_move === 'w' ? 'White' : 'Black'} to move`
    }
  }

  return (
    <Box sx={{ display: 'flex', alignItems: 'center', gap: 1.5, minHeight: 30 }}>
      {over ? (
        <Flag size={18} color="var(--accent)" />
      ) : thinking ? (
        <CircularProgress size={16} sx={{ color: 'var(--accent)' }} />
      ) : (
        <Box
          sx={{
            width: 9,
            height: 9,
            borderRadius: '50%',
            background: accent ? 'var(--accent)' : 'var(--muted)',
            boxShadow: accent ? '0 0 0 4px var(--accent-soft)' : 'none',
          }}
        />
      )}
      <Typography
        sx={{
          fontFamily: 'var(--font-display)',
          fontSize: 20,
          fontWeight: 600,
          color: over ? 'var(--accent)' : 'var(--text)',
        }}
      >
        {primary}
      </Typography>
      {game && over && game.result && (
        <Typography sx={{ ml: 'auto', fontFamily: 'var(--font-mono)', color: 'var(--text-dim)' }}>
          {game.result}
        </Typography>
      )}
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
