import { type ReactNode, useState } from 'react'
import {
  Alert,
  Box,
  Button,
  Chip,
  CircularProgress,
  Divider,
  IconButton,
  Slider,
  ToggleButton,
  ToggleButtonGroup,
  Tooltip,
  Typography,
} from '@mui/material'
import { Flag, FlipVertical2, RotateCcw, Volume2, VolumeX } from 'lucide-react'
import Board from '../components/Board'
import EvalBar, { type WhiteEval } from '../components/EvalBar'
import MoveList from '../components/MoveList'
import { type BotGame as Game, type Color, createBotGame, playMove } from '../api/client'
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

  const humanColor: Color = game?.human_color ?? (colorChoice === 'random' ? 'w' : colorChoice)
  const botColor = other(humanColor)
  const orientation: Color = flipped ? other(humanColor) : humanColor
  const fen = game?.fen ?? START_FEN
  const over = resigned || (game != null && game.status !== 'ongoing')
  const ongoing = !!game && !over
  const interactive = ongoing && game.your_turn && !thinking

  // Latest engine evaluation (from bot moves), converted to White's perspective.
  const evalState: WhiteEval | null = (() => {
    if (!game) return null
    for (let i = game.moves.length - 1; i >= 0; i--) {
      const m = game.moves[i]
      if (m.by === 'bot' && m.eval) {
        const sign = botColor === 'w' ? 1 : -1
        return { type: m.eval.type, white: m.eval.value * sign }
      }
    }
    return null
  })()

  const lastEntry = game && game.moves.length ? game.moves[game.moves.length - 1] : null
  const lastMove =
    optimisticLast ??
    (lastEntry ? { from: lastEntry.uci.slice(0, 2), to: lastEntry.uci.slice(2, 4) } : null)

  async function newGame() {
    setError(null)
    setCreating(true)
    setOverride(null)
    setOptimisticLast(null)
    setResigned(false)
    setFlipped(false)
    const color: Color = colorChoice === 'random' ? (Math.random() < 0.5 ? 'w' : 'b') : colorChoice
    try {
      const g = await createBotGame(level, color)
      setGame(g)
      // If the bot opened (human is Black), voice its move.
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

  // Immediate, optimistic sound for the human's move (no check info yet).
  function playHumanSound(board: BoardMap, uci: string) {
    const from = uci.slice(0, 2)
    const to = uci.slice(2, 4)
    const piece = board[from]?.toLowerCase()
    if (uci.length === 5) sounds.promote()
    else if (piece === 'k' && Math.abs(fileOf(to) - fileOf(from)) === 2) sounds.castle()
    else if (board[to] || (piece === 'p' && from[0] !== to[0])) sounds.capture()
    else sounds.move()
  }

  // After the server responds, voice whatever the bot played (or game end).
  function voiceServerReply(priorCount: number, g: Game) {
    const fresh = g.moves.slice(priorCount + 1) // skip our own move (already voiced)
    const gameOver = g.status !== 'ongoing'
    if (fresh.length > 0) {
      playForSan(fresh[fresh.length - 1].san, gameOver)
    } else if (gameOver) {
      sounds.end()
    }
  }

  function resign() {
    if (!ongoing) return
    setResigned(true)
    sounds.end()
  }

  function toggleSound() {
    const next = !sound
    setSound(next)
    setSoundEnabled(next)
    if (next) sounds.move()
  }

  const resultScore = resigned ? (humanColor === 'w' ? '0-1' : '1-0') : (game?.result ?? null)
  const statusText = over
    ? resigned
      ? 'You resigned'
      : game
        ? statusLabel(game.status)
        : ''
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
        display: 'flex',
        justifyContent: 'center',
        alignItems: { xs: 'flex-start', md: 'center' },
        px: { xs: 2, md: 4 },
        py: { xs: 3, md: 2 },
      }}
    >
      <Box
        sx={{
          display: 'grid',
          gridTemplateColumns: {
            xs: '1fr',
            md: 'min(calc(100vh - 116px), calc(100vw - 420px), 900px) 320px',
          },
          columnGap: { md: 5 },
          rowGap: 3,
          alignItems: 'center',
          width: '100%',
          maxWidth: 1280,
        }}
      >
        <Box sx={{ minWidth: 0, display: 'flex', gap: { xs: 0.75, md: 1.25 }, alignItems: 'stretch' }}>
          <EvalBar ev={evalState} orientation={orientation} />
          <Box sx={{ flex: 1, minWidth: 0 }}>
            <Board
              fen={fen}
              orientation={orientation}
              sideToMove={game?.side_to_move ?? 'w'}
              legalMoves={interactive ? game.legal_moves : []}
              lastMove={lastMove}
              inCheck={false}
              interactive={interactive}
              onMove={onMove}
              {...(override ? { overrideBoard: override } : {})}
            />
          </Box>
        </Box>

        {/* Right rail — vertically centered beside the board */}
        <Box sx={{ display: 'flex', flexDirection: 'column', gap: 1.75, alignSelf: 'center' }}>
          <PlayerRow
            name="gomachine"
            color={botColor}
            active={ongoing && game.side_to_move === botColor}
            trailing={
              <>
                <Chip
                  label={`Lv ${game?.level ?? level}`}
                  size="small"
                  sx={{
                    height: 22,
                    fontFamily: 'var(--font-mono)',
                    fontSize: 11,
                    bgcolor: 'var(--accent-soft)',
                    color: 'var(--accent)',
                    border: '1px solid var(--accent-line)',
                  }}
                />
                {thinking && <CircularProgress size={13} sx={{ color: 'var(--accent)' }} />}
              </>
            }
          />

          <Divider sx={{ borderColor: 'var(--line-soft)' }} />

          <Box sx={{ display: 'flex', alignItems: 'center', gap: 0.5 }}>
            <RailIcon label="Flip board" onClick={() => setFlipped((f) => !f)}>
              <FlipVertical2 size={17} />
            </RailIcon>
            <RailIcon label={sound ? 'Mute sounds' : 'Unmute sounds'} onClick={toggleSound}>
              {sound ? <Volume2 size={17} /> : <VolumeX size={17} />}
            </RailIcon>
            <Box sx={{ flex: 1 }} />
            {ongoing && (
              <RailIcon label="Resign" onClick={resign}>
                <Flag size={16} />
              </RailIcon>
            )}
          </Box>

          {game && (
            <Box
              sx={{
                bgcolor: 'var(--bg-2)',
                border: '1px solid var(--line-soft)',
                borderRadius: 2,
                px: 1.5,
                py: 1,
              }}
            >
              <MoveList moves={game.moves} />
            </Box>
          )}

          {error && (
            <Alert severity="error" variant="outlined" sx={{ fontSize: 13 }}>
              {error}
            </Alert>
          )}

          {(!game || over) && (
            <Box sx={{ display: 'flex', flexDirection: 'column', gap: 1.75 }}>
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
            </Box>
          )}

          <Divider sx={{ borderColor: 'var(--line-soft)' }} />

          <PlayerRow name="You" color={humanColor} active={ongoing && game.side_to_move === humanColor} />

          <Box sx={{ display: 'flex', alignItems: 'baseline', gap: 1, minHeight: 24 }}>
            <Typography
              sx={{
                fontFamily: 'var(--font-display)',
                fontSize: 17,
                fontWeight: 600,
                color: over ? 'var(--accent)' : ongoing && game.your_turn ? 'var(--text)' : 'var(--text-dim)',
              }}
            >
              {statusText}
            </Typography>
            {over && resultScore && (
              <Typography sx={{ ml: 'auto', fontFamily: 'var(--font-mono)', color: 'var(--text-dim)' }}>
                {resultScore}
              </Typography>
            )}
          </Box>

          {ongoing ? (
            <Button variant="outlined" color="inherit" onClick={() => setGame(null)} startIcon={<RotateCcw size={15} />}>
              New game
            </Button>
          ) : (
            <Button
              variant="contained"
              onClick={newGame}
              disabled={creating}
              startIcon={creating ? <CircularProgress size={15} color="inherit" /> : <RotateCcw size={15} />}
            >
              {game ? 'Play again' : 'Start game'}
            </Button>
          )}
        </Box>
      </Box>
    </Box>
  )
}

function PlayerRow({
  name,
  color,
  active,
  trailing,
}: {
  name: string
  color: Color
  active?: boolean
  trailing?: ReactNode
}) {
  return (
    <Box sx={{ display: 'flex', alignItems: 'center', gap: 1.25 }}>
      <Box
        sx={{
          width: 14,
          height: 14,
          borderRadius: '50%',
          flexShrink: 0,
          background: color === 'w' ? '#f1ece0' : '#15181e',
          border: '1px solid rgba(255,255,255,0.22)',
          boxShadow: active ? '0 0 0 3px var(--accent-soft)' : 'none',
        }}
      />
      <Typography
        sx={{
          fontWeight: 600,
          fontSize: 15,
          color: active ? 'var(--text)' : 'var(--text-dim)',
        }}
      >
        {name}
      </Typography>
      <Box sx={{ ml: 'auto', display: 'flex', alignItems: 'center', gap: 0.75 }}>{trailing}</Box>
    </Box>
  )
}

function RailIcon({ label, onClick, children }: { label: string; onClick: () => void; children: ReactNode }) {
  return (
    <Tooltip title={label} arrow>
      <IconButton
        onClick={onClick}
        size="small"
        sx={{
          color: 'var(--text-dim)',
          borderRadius: 1.5,
          '&:hover': { color: 'var(--accent)', bgcolor: 'var(--accent-soft)' },
        }}
      >
        {children}
      </IconButton>
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
