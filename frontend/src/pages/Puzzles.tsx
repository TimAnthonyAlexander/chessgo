import { type ReactNode, useCallback, useEffect, useRef, useState } from 'react'
import { Box, CircularProgress, MenuItem, Select, Typography } from '@mui/material'
import { Check, CheckCircle2, ChevronRight, RotateCcw, Target, X, XCircle } from 'lucide-react'
import Board from '../components/Board'
import { ActionBtn, ErrorBanner } from '../components/PanelUI'
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

const START_FEN = 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1'
const splitUci = (uci: string): Mark => ({ from: uci.slice(0, 2), to: uci.slice(2, 4) })

// Remember the last-picked theme across sessions so you don't keep re-selecting it.
const THEME_KEY = 'chessgo.puzzleTheme'
function readTheme(): string {
  try {
    const t = localStorage.getItem(THEME_KEY)
    if (t && THEMES.some((x) => x.value === t)) return t
  } catch {
    /* ignore */
  }
  return ''
}
function storeTheme(t: string): void {
  try {
    localStorage.setItem(THEME_KEY, t)
  } catch {
    /* ignore */
  }
}

export default function Puzzles() {
  const { user } = useAuth()
  const [theme, setTheme] = useState(readTheme)
  const [data, setData] = useState<PuzzleNext | null>(null)
  const [phase, setPhase] = useState<Phase>('loading')
  const [fen, setFen] = useState<string>('')
  const [legal, setLegal] = useState<string[]>([])
  const [ply, setPly] = useState(1)
  const [lastMove, setLastMove] = useState<Mark | null>(null)
  const [override, setOverride] = useState<BoardMap | null>(null)
  const [result, setResult] = useState<PuzzleMoveResult | null>(null)
  const [error, setError] = useState<string | null>(null)
  // In-memory (non-persisted) win/loss log for this session, newest last.
  const [history, setHistory] = useState<boolean[]>([])

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

  // Enter advances to the next puzzle once the current one is solved or failed.
  useEffect(() => {
    if (phase !== 'solved' && phase !== 'failed') return
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Enter') {
        e.preventDefault()
        void load(theme)
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [phase, theme, load])

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
        sounds.success()
        setHistory((h) => [...h, true])
        if (res.rating) void authStore.refresh()
        // Auto-advance to the next puzzle after a brief celebratory pause.
        later(() => void load(theme), 2000)
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
      setHistory((h) => [...h, false])
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
    storeTheme(next)
    void load(next)
  }

  return (
    <Box
      sx={{
        flex: 1,
        display: 'flex',
        justifyContent: 'center',
        alignItems: { xs: 'flex-start', md: 'center' },
        px: { xs: 2, md: 3 },
        py: { xs: 3, md: 2 },
      }}
    >
      <Box
        sx={{
          display: 'grid',
          // Same board sizing as the other pages, but Bot/Analysis put a ~46px
          // EvalBar (38px) + gap (8px) beside the board, shrinking it that much.
          // Puzzles has no eval bar, so trim the board column by 46px to match.
          gridTemplateColumns: {
            xs: '1fr',
            md: '320px min(calc(100vh - 166px), calc(100vw - 798px), 834px) 320px',
          },
          columnGap: { md: 4 },
          rowGap: 2.5,
          alignItems: { xs: 'center', md: 'stretch' },
          justifyContent: 'center',
          width: { xs: '100%', md: 'fit-content' },
          maxWidth: '100%',
          mx: 'auto',
        }}
      >
        {/* Left — about + theme filter (desktop) */}
        <Box sx={{ display: { xs: 'none', md: 'block' }, justifySelf: 'end', alignSelf: 'start', width: '100%' }}>
          <InfoCard user={user ? { rating: user.rating_puzzle, games: user.games_puzzle } : null} theme={theme} onThemeChange={onThemeChange} />
        </Box>

        {/* Center — board, top-aligned to line up with the side cards. The xs width
            trims the same ~34px (26px eval + gap) the other pages lose on mobile. */}
        <Box sx={{ alignSelf: 'start', width: { xs: 'calc(min(94vw, 64vh) - 34px)', md: '100%' } }}>
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
        <Box
          sx={{
            justifySelf: { md: 'start' },
            alignSelf: 'start',
            width: '100%',
            maxWidth: { xs: 'min(94vw, 64vh)', md: 'none' },
          }}
        >
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
          <HistoryStrip history={history} />
          {error && <ErrorBanner sx={{ mx: 0, mt: 1.5 }}>{error}</ErrorBanner>}
        </Box>
      </Box>
    </Box>
  )
}

function InfoCard({
  user,
  theme,
  onThemeChange,
}: {
  user: { rating: number; games: number } | null
  theme: string
  onThemeChange: (t: string) => void
}) {
  return (
    <Box
      sx={{
        bgcolor: 'var(--surface)',
        border: '1px solid var(--line-soft)',
        borderRadius: '16px',
        p: 2.5,
        boxShadow: '0 18px 50px -28px rgba(0,0,0,0.8)',
      }}
    >
      <Box sx={{ display: 'flex', alignItems: 'center', gap: 1.25 }}>
        <Box
          sx={{
            width: 34,
            height: 34,
            borderRadius: '10px',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            bgcolor: 'var(--accent-soft)',
            border: '1px solid var(--accent-line)',
            color: 'var(--accent)',
          }}
        >
          <Target size={18} />
        </Box>
        <Typography sx={{ fontFamily: 'var(--font-display)', fontWeight: 700, fontSize: 22 }}>Puzzles</Typography>
      </Box>
      <Typography sx={{ fontSize: 13, color: 'var(--muted)', mt: 1.25 }}>
        Find the best move. Each puzzle is matched to your rating.
      </Typography>

      <Box sx={{ borderTop: '1px solid var(--line-soft)', mt: 2.25, pt: 2.25 }}>
        <Label>Your puzzle rating</Label>
        {user ? (
          <Box sx={{ display: 'flex', alignItems: 'baseline', gap: 1 }}>
            <Typography sx={{ fontFamily: 'var(--font-mono)', fontSize: 30, fontWeight: 700, color: 'var(--accent)', lineHeight: 1 }}>
              {user.rating}
            </Typography>
            <Typography sx={{ fontSize: 13, color: 'var(--muted)' }}>· {user.games} solved</Typography>
          </Box>
        ) : (
          <Typography sx={{ fontSize: 13, color: 'var(--text-dim)' }}>Log in to track your rating.</Typography>
        )}
      </Box>

      <Box sx={{ borderTop: '1px solid var(--line-soft)', mt: 2.25, pt: 2.25 }}>
        <Label>Theme</Label>
        <ThemeSelect value={theme} onChange={onThemeChange} />
      </Box>
    </Box>
  )
}

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
    <Box
      sx={{
        bgcolor: 'var(--surface)',
        border: '1px solid var(--line-soft)',
        borderRadius: '16px',
        overflow: 'hidden',
        boxShadow: '0 18px 50px -28px rgba(0,0,0,0.8)',
      }}
    >
      {/* Headline */}
      <Box sx={{ px: 2.25, py: 2.25 }}>
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
            <Typography sx={{ fontFamily: 'var(--font-display)', fontWeight: 700, fontSize: 20, color: 'var(--text)' }}>
              {toMove} to move
            </Typography>
            <Typography sx={{ fontSize: 13.5, color: 'var(--muted)', mt: 0.25 }}>
              Find the best move{theme ? '' : ' for ' + toMove.toLowerCase()}.
            </Typography>
          </>
        )}
        {phase === 'solved' && (
          <Row>
            <CheckCircle2 size={24} color="#7bb661" />
            <Box>
              <Typography sx={{ fontFamily: 'var(--font-display)', fontWeight: 700, fontSize: 20, color: '#7bb661' }}>
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
            <XCircle size={24} color="#e0796b" />
            <Box>
              <Typography sx={{ fontFamily: 'var(--font-display)', fontWeight: 700, fontSize: 20, color: '#e0796b' }}>
                Incorrect
              </Typography>
              {puzzleRating != null && (
                <Typography sx={{ fontSize: 13, color: 'var(--muted)' }}>Puzzle rating {puzzleRating}</Typography>
              )}
            </Box>
          </Row>
        )}

        {terminal && delta != null && (
          <Typography
            sx={{ mt: 1.5, fontFamily: 'var(--font-mono)', fontSize: 13.5, color: delta >= 0 ? '#7bb661' : '#e0796b' }}
          >
            Your rating {result?.rating?.value} ({delta >= 0 ? '+' : ''}
            {delta})
          </Typography>
        )}
        {terminal && result?.themes && result.themes.length > 0 && (
          <Box sx={{ display: 'flex', flexWrap: 'wrap', gap: 0.6, mt: 1.25 }}>
            {result.themes.slice(0, 6).map((t) => (
              <Box
                key={t}
                sx={{
                  px: 0.85,
                  py: 0.3,
                  borderRadius: '6px',
                  fontSize: 11,
                  color: 'var(--text-dim)',
                  bgcolor: 'var(--surface-2)',
                  border: '1px solid var(--line)',
                }}
              >
                {t}
              </Box>
            ))}
          </Box>
        )}
      </Box>

      {/* Controls */}
      <Box sx={{ px: 2.25, pb: 2.25, display: 'flex', flexDirection: 'column', gap: 1.5 }}>
        <ActionBtn
          tone={terminal ? 'primary' : 'neutral'}
          icon={terminal ? <ChevronRight size={16} /> : <RotateCcw size={15} />}
          label={terminal ? 'Next puzzle' : 'Skip'}
          onClick={onNext}
        />

        {/* Theme + rating mirror the desktop panel for mobile (where it's hidden). */}
        <Box sx={{ display: { xs: 'block', md: 'none' } }}>
          <Label>Theme</Label>
          <ThemeSelect value={theme} onChange={onThemeChange} />
          <Typography sx={{ fontSize: 12.5, color: 'var(--muted)', mt: 1.5 }}>
            {user ? (
              <>
                Your rating:{' '}
                <Box component="span" sx={{ fontFamily: 'var(--font-mono)', color: 'var(--text-dim)' }}>
                  {user.rating}
                </Box>{' '}
                · {user.games} solved
              </>
            ) : (
              'Log in to track your puzzle rating.'
            )}
          </Typography>
        </Box>
      </Box>
    </Box>
  )
}

function HistoryStrip({ history }: { history: boolean[] }) {
  if (history.length === 0) return null
  const wins = history.filter(Boolean).length
  const losses = history.length - wins
  // Newest first so the most recent result is the easy-to-spot top-left box.
  const ordered = [...history].reverse()

  return (
    <Box
      sx={{
        bgcolor: 'var(--surface)',
        border: '1px solid var(--line-soft)',
        borderRadius: '16px',
        p: 2.25,
        mt: 1.5,
        boxShadow: '0 18px 50px -28px rgba(0,0,0,0.8)',
      }}
    >
      <Box sx={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', mb: 1.25 }}>
        <Label>History</Label>
        <Typography sx={{ fontFamily: 'var(--font-mono)', fontSize: 12 }}>
          <Box component="span" sx={{ color: '#7bb661' }}>{wins}W</Box>
          <Box component="span" sx={{ color: 'var(--muted)' }}> · </Box>
          <Box component="span" sx={{ color: '#e0796b' }}>{losses}L</Box>
        </Typography>
      </Box>
      <Box sx={{ display: 'flex', flexWrap: 'wrap', gap: 0.6 }}>
        {ordered.map((win, i) => (
          <Box
            key={history.length - 1 - i}
            sx={{
              width: 26,
              height: 26,
              borderRadius: '7px',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              color: win ? '#7bb661' : '#e0796b',
              bgcolor: win ? 'rgba(123,182,97,0.16)' : 'rgba(224,121,107,0.16)',
              border: `1px solid ${win ? 'rgba(123,182,97,0.4)' : 'rgba(224,121,107,0.4)'}`,
            }}
          >
            {win ? <Check size={15} /> : <X size={15} />}
          </Box>
        ))}
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
        bgcolor: 'var(--surface-2)',
        borderRadius: '10px',
        '.MuiOutlinedInput-notchedOutline': { borderColor: 'var(--line)' },
        '&:hover .MuiOutlinedInput-notchedOutline': { borderColor: 'var(--accent-line)' },
        '&.Mui-focused .MuiOutlinedInput-notchedOutline': { borderColor: 'var(--accent)' },
        '.MuiSvgIcon-root': { color: 'var(--text-dim)' },
      }}
      MenuProps={{
        slotProps: { paper: { sx: { bgcolor: 'var(--surface)', border: '1px solid var(--line)', borderRadius: '10px', mt: 0.5 } } },
      }}
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
