import { type ReactNode, useCallback, useEffect, useRef, useState } from 'react'
import { Alert, Box, Button, CircularProgress, MenuItem, Select, Typography } from '@mui/material'
import { CheckCircle2, ChevronRight, RotateCcw, XCircle } from 'lucide-react'
import Board from '../components/Board'
import {
  type Color,
  nextPuzzle,
  type PuzzleMoveResult,
  type PuzzleNext,
  submitPuzzleMove,
} from '../api/client'
import { applyUciVisually, type BoardMap, fileOf, parseFen } from '../lib/chess'
import { sounds } from '../lib/sounds'
import { authStore, useAuth } from '../lib/auth'

type Phase = 'loading' | 'intro' | 'solving' | 'checking' | 'solved' | 'failed' | 'empty'
type Square = string
interface Mark {
  from: Square
  to: Square
}

// A curated subset of Lichess theme tags for the v1 filter (incl. the classic
// "mate in N"). Empty value = any theme.
const THEMES: { value: string; label: string }[] = [
  { value: '', label: 'All puzzles' },
  { value: 'mateIn1', label: 'Mate in 1' },
  { value: 'mateIn2', label: 'Mate in 2' },
  { value: 'mateIn3', label: 'Mate in 3' },
  { value: 'fork', label: 'Fork' },
  { value: 'pin', label: 'Pin' },
  { value: 'skewer', label: 'Skewer' },
  { value: 'discoveredAttack', label: 'Discovered attack' },
  { value: 'sacrifice', label: 'Sacrifice' },
  { value: 'endgame', label: 'Endgame' },
  { value: 'rookEndgame', label: 'Rook endgame' },
  { value: 'crushing', label: 'Crushing' },
  { value: 'advantage', label: 'Advantage' },
]

const splitUci = (uci: string): Mark => ({ from: uci.slice(0, 2), to: uci.slice(2, 4) })

export default function Puzzles() {
  const { user } = useAuth()
  const [theme, setTheme] = useState('')
  const [data, setData] = useState<PuzzleNext | null>(null)
  const [phase, setPhase] = useState<Phase>('loading')
  const [fen, setFen] = useState<string>('')
  const [legal, setLegal] = useState<string[]>([])
  const [ply, setPly] = useState(1)
  const [lastMove, setLastMove] = useState<Mark | null>(null)
  const [override, setOverride] = useState<BoardMap | null>(null)
  const [result, setResult] = useState<PuzzleMoveResult | null>(null)
  const [error, setError] = useState<string | null>(null)

  // Timers for the staged opponent-move animations; cleared on unmount / reload.
  const timers = useRef<ReturnType<typeof setTimeout>[]>([])
  const clearTimers = () => {
    timers.current.forEach(clearTimeout)
    timers.current = []
  }
  const later = (fn: () => void, ms: number) => {
    timers.current.push(setTimeout(fn, ms))
  }

  const load = useCallback(async (forTheme: string) => {
    clearTimers()
    setError(null)
    setResult(null)
    setOverride(null)
    setLastMove(null)
    setPhase('loading')
    try {
      const p = await nextPuzzle(forTheme || undefined)
      setData(p)
      setFen(p.fen)
      setLegal(p.legal_moves)
      setPly(p.ply)
      setLastMove(null)
      setPhase('intro')
      // Show the pre-move position briefly, then "play" the opponent's setup move.
      later(() => {
        setLastMove(splitUci(p.opponent_move))
        sounds.move()
        setPhase('solving')
      }, 480)
    } catch (e) {
      setData(null)
      setPhase('empty')
      setError(e instanceof Error ? e.message : 'Could not load a puzzle.')
    }
  }, [])

  useEffect(() => {
    void load(theme)
    return clearTimers
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  function moveSound(board: BoardMap, uci: string) {
    const from = uci.slice(0, 2)
    const to = uci.slice(2, 4)
    const piece = board[from]?.toLowerCase()
    if (uci.length === 5) sounds.promote()
    else if (piece === 'k' && Math.abs(fileOf(to) - fileOf(from)) === 2) sounds.castle()
    else if (board[to] || (piece === 'p' && from[0] !== to[0])) sounds.capture()
    else sounds.move()
  }

  async function onMove(uci: string) {
    if (phase !== 'solving' || !data) return
    const board = parseFen(fen)
    setOverride(applyUciVisually(board, uci))
    setLastMove(splitUci(uci))
    moveSound(board, uci)
    setPhase('checking')
    try {
      const res = await submitPuzzleMove(data.id, uci, fen, ply)

      if (res.correct && res.complete) {
        setOverride(null)
        setFen(res.fen ?? fen)
        setResult(res)
        setPhase('solved')
        sounds.end()
        if (res.rating) void authStore.refresh()
        return
      }

      if (res.correct && res.opponent_move && res.fen) {
        // Hold the player's move on the board, then play the scripted reply.
        const reply = res.opponent_move
        const nextFen = res.fen
        const nextLegal = res.legal_moves ?? []
        const nextPly = res.ply ?? ply + 2
        later(() => {
          setOverride(null)
          setFen(nextFen)
          setLegal(nextLegal)
          setPly(nextPly)
          setLastMove(splitUci(reply))
          sounds.move()
          setPhase('solving')
        }, 360)
        return
      }

      // Wrong move: reveal the correct continuation on the board.
      setResult(res)
      const correct = res.solution?.[0]
      if (correct) {
        setOverride(applyUciVisually(board, correct))
        setLastMove(splitUci(correct))
      } else {
        setOverride(null)
      }
      setPhase('failed')
      sounds.end()
      if (res.rating) void authStore.refresh()
    } catch (e) {
      // Network/server error — revert the optimistic move, let them retry.
      setOverride(null)
      setLastMove(null)
      setPhase('solving')
      setError(e instanceof Error ? e.message : 'Move failed.')
    }
  }

  const orientation: Color = data?.color ?? 'w'
  const displayFen = phase === 'intro' || !data ? (data?.start_fen ?? START_FEN) : fen
  const interactive = phase === 'solving'

  function onThemeChange(next: string) {
    setTheme(next)
    void load(next)
  }

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
      {/* Left — heading + theme filter (desktop) */}
      <Box sx={{ display: { xs: 'none', lg: 'block' }, justifySelf: 'end', width: '100%', maxWidth: 290 }}>
        <Box sx={{ bgcolor: '#1b1e24', border: '1px solid var(--line)', borderRadius: 2.5, p: 2.5 }}>
          <Typography sx={{ fontFamily: 'var(--font-display)', fontWeight: 600, fontSize: 22, mb: 0.5 }}>
            Puzzles
          </Typography>
          <Typography sx={{ fontSize: 13, color: 'var(--muted)', mb: 2 }}>
            Find the best move. Puzzles are matched to your rating.
          </Typography>
          <Label>Theme</Label>
          <ThemeSelect value={theme} onChange={onThemeChange} />
        </Box>
      </Box>

      {/* Center — board */}
      <Box
        sx={{
          width: { xs: 'min(94vw, 64vh)', lg: 'min(calc(100vh - 100px), calc(100vw - 780px), 820px)' },
        }}
      >
        <Board
          fen={displayFen}
          orientation={orientation}
          sideToMove={orientation}
          legalMoves={interactive ? legal : []}
          lastMove={lastMove}
          inCheck={false}
          interactive={interactive}
          onMove={onMove}
          {...(override ? { overrideBoard: override } : {})}
        />
      </Box>

      {/* Right — status / controls */}
      <Box sx={{ justifySelf: { lg: 'start' }, width: '100%', maxWidth: { xs: 'min(94vw, 64vh)', lg: 320 } }}>
        <StatusCard
          phase={phase}
          orientation={orientation}
          puzzleRating={data?.rating ?? null}
          result={result}
          user={user ? { rating: user.rating_puzzle, games: user.games_puzzle } : null}
          theme={theme}
          onThemeChange={onThemeChange}
          onNext={() => void load(theme)}
        />
        {error && (
          <Alert severity="error" variant="outlined" sx={{ mt: 2, fontSize: 13 }}>
            {error}
          </Alert>
        )}
      </Box>
    </Box>
  )
}

const START_FEN = 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1'

function StatusCard({
  phase,
  orientation,
  puzzleRating,
  result,
  user,
  theme,
  onThemeChange,
  onNext,
}: {
  phase: Phase
  orientation: Color
  puzzleRating: number | null
  result: PuzzleMoveResult | null
  user: { rating: number; games: number } | null
  theme: string
  onThemeChange: (t: string) => void
  onNext: () => void
}) {
  const terminal = phase === 'solved' || phase === 'failed'
  const delta = result?.rating?.delta ?? null
  const toMove = orientation === 'w' ? 'White' : 'Black'

  return (
    <Box sx={{ bgcolor: '#1b1e24', border: '1px solid var(--line)', borderRadius: 2.5, overflow: 'hidden' }}>
      {/* Headline */}
      <Box sx={{ px: 2.25, py: 2 }}>
        {phase === 'loading' && (
          <Row>
            <CircularProgress size={16} sx={{ color: 'var(--muted)' }} />
            <Typography sx={{ fontSize: 15, color: 'var(--text-dim)' }}>Loading puzzle…</Typography>
          </Row>
        )}
        {phase === 'empty' && (
          <Typography sx={{ fontSize: 15, color: 'var(--text-dim)' }}>
            No puzzle found for this filter. Try another theme.
          </Typography>
        )}
        {(phase === 'intro' || phase === 'solving' || phase === 'checking') && (
          <>
            <Typography sx={{ fontFamily: 'var(--font-display)', fontWeight: 700, fontSize: 19, color: 'var(--text)' }}>
              {toMove} to move
            </Typography>
            <Typography sx={{ fontSize: 13.5, color: 'var(--muted)', mt: 0.25 }}>
              Find the best move{theme ? '' : ' for ' + toMove.toLowerCase()}.
            </Typography>
          </>
        )}
        {phase === 'solved' && (
          <Row>
            <CheckCircle2 size={22} color="#7bb661" />
            <Box>
              <Typography sx={{ fontFamily: 'var(--font-display)', fontWeight: 700, fontSize: 19, color: '#7bb661' }}>
                Solved!
              </Typography>
              {puzzleRating != null && (
                <Typography sx={{ fontSize: 13, color: 'var(--muted)' }}>Puzzle rating {puzzleRating}</Typography>
              )}
            </Box>
          </Row>
        )}
        {phase === 'failed' && (
          <Row>
            <XCircle size={22} color="#e0796b" />
            <Box>
              <Typography sx={{ fontFamily: 'var(--font-display)', fontWeight: 700, fontSize: 19, color: '#e0796b' }}>
                Incorrect
              </Typography>
              {puzzleRating != null && (
                <Typography sx={{ fontSize: 13, color: 'var(--muted)' }}>Puzzle rating {puzzleRating}</Typography>
              )}
            </Box>
          </Row>
        )}

        {terminal && delta != null && (
          <Typography sx={{ mt: 1.25, fontFamily: 'var(--font-mono)', fontSize: 13.5, color: delta >= 0 ? '#7bb661' : '#e0796b' }}>
            Puzzle rating {result?.rating?.value} ({delta >= 0 ? '+' : ''}
            {delta})
          </Typography>
        )}
        {terminal && result?.themes && result.themes.length > 0 && (
          <Typography sx={{ mt: 0.75, fontSize: 12, color: 'var(--muted)' }}>
            {result.themes.slice(0, 6).join(' · ')}
          </Typography>
        )}
      </Box>

      {/* Next */}
      <Box sx={{ px: 2.25, pb: 2, display: 'flex', flexDirection: 'column', gap: 1.25 }}>
        <Button
          variant="contained"
          onClick={onNext}
          endIcon={phase === 'solved' || phase === 'failed' ? <ChevronRight size={16} /> : <RotateCcw size={15} />}
          sx={{ alignSelf: 'stretch' }}
        >
          {terminal ? 'Next puzzle' : 'Skip'}
        </Button>

        {/* Theme filter (always available; mirrors the desktop panel for mobile) */}
        <Box sx={{ display: { xs: 'block', lg: 'none' } }}>
          <Label>Theme</Label>
          <ThemeSelect value={theme} onChange={onThemeChange} />
        </Box>

        {user ? (
          <Typography sx={{ fontSize: 12.5, color: 'var(--muted)', mt: 0.5 }}>
            Your puzzle rating:{' '}
            <Box component="span" sx={{ fontFamily: 'var(--font-mono)', color: 'var(--text-dim)' }}>
              {user.rating}
            </Box>{' '}
            · {user.games} solved
          </Typography>
        ) : (
          <Typography sx={{ fontSize: 12.5, color: 'var(--muted)', mt: 0.5 }}>
            Log in to track your puzzle rating.
          </Typography>
        )}
      </Box>
    </Box>
  )
}

function ThemeSelect({ value, onChange }: { value: string; onChange: (v: string) => void }) {
  return (
    <Select
      value={value}
      onChange={(e) => onChange(e.target.value)}
      size="small"
      fullWidth
      displayEmpty
      sx={{
        color: 'var(--text)',
        fontSize: 14,
        '.MuiOutlinedInput-notchedOutline': { borderColor: 'var(--line)' },
        '&:hover .MuiOutlinedInput-notchedOutline': { borderColor: 'var(--accent-line)' },
        '.MuiSvgIcon-root': { color: 'var(--text-dim)' },
      }}
      MenuProps={{ slotProps: { paper: { sx: { bgcolor: 'var(--surface)', border: '1px solid var(--line)' } } } }}
    >
      {THEMES.map((t) => (
        <MenuItem key={t.value} value={t.value} sx={{ fontSize: 13.5 }}>
          {t.label}
        </MenuItem>
      ))}
    </Select>
  )
}

function Row({ children }: { children: ReactNode }) {
  return <Box sx={{ display: 'flex', alignItems: 'center', gap: 1.25 }}>{children}</Box>
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
