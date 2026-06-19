import { type ReactNode, useCallback, useEffect, useRef, useState } from 'react'
import { Box, CircularProgress, MenuItem, Select, Typography } from '@mui/material'
import {
  Check,
  CheckCircle2,
  ChevronRight,
  Clock,
  Infinity as InfinityIcon,
  Play,
  RotateCcw,
  Square as StopIcon,
  Target,
  Trophy,
  X,
  XCircle,
} from 'lucide-react'
import Board from '../components/Board'
import { ActionBtn, ErrorBanner } from '../components/PanelUI'
import {
  type Color,
  nextPuzzle,
  type PuzzleMoveResult,
  type PuzzleNext,
  submitPuzzleMove,
} from '../api/client'
import { applyUciVisually, type BoardMap, parseFen } from '../lib/chess'
import { playForMove, sounds } from '../lib/sounds'
import { authStore, useAuth } from '../lib/auth'

type Phase = 'loading' | 'intro' | 'solving' | 'checking' | 'solved' | 'failed' | 'empty'
// A puzzle "session" runs across many puzzles under one fixed theme + time control:
//   setup   — the front page where you pick theme + time, then Start
//   running — solving puzzles; theme/time are locked, a clock counts down
//   over     — the session ended (clock hit 0 or you stopped); a summary + replay
type Mode = 'setup' | 'running' | 'over'
type Square = string
interface Mark {
  from: Square
  to: Square
}
interface Outcome {
  win: boolean
  delta: number | null // rating change; null when unrated (e.g. logged out)
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
const themeLabel = (v: string) => THEMES.find((t) => t.value === v)?.label ?? 'All puzzles'

// Session-wide countdown presets (Puzzle-Rush style): solve as many as you can
// before the clock runs out. `null` = untimed practice.
const TIME_FORMATS: { value: number | null; time: string; tag: string }[] = [
  { value: 60, time: '1:00', tag: 'Sprint' },
  { value: 180, time: '3:00', tag: 'Blitz' },
  { value: 300, time: '5:00', tag: 'Marathon' },
  { value: null, time: '∞', tag: 'Untimed' },
]

const START_FEN = 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1'
const splitUci = (uci: string): Mark => ({ from: uci.slice(0, 2), to: uci.slice(2, 4) })
const fmtClock = (ms: number): string => {
  const s = Math.max(0, Math.ceil(ms / 1000))
  return `${Math.floor(s / 60)}:${(s % 60).toString().padStart(2, '0')}`
}

// Remember the last-picked theme + time format across sessions so you don't keep
// re-selecting them.
const THEME_KEY = 'chessgo.puzzleTheme'
const TIME_KEY = 'chessgo.puzzleTime'
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
function readLimit(): number | null {
  try {
    const v = localStorage.getItem(TIME_KEY)
    if (v === 'none') return null
    const n = Number(v)
    if (v != null && TIME_FORMATS.some((f) => f.value === n)) return n
  } catch {
    /* ignore */
  }
  return 180 // default: 3-minute Blitz
}
function storeLimit(v: number | null): void {
  try {
    localStorage.setItem(TIME_KEY, v == null ? 'none' : String(v))
  } catch {
    /* ignore */
  }
}

export default function Puzzles() {
  const { user } = useAuth()
  const userStats = user
    ? { rating: user.rating_puzzle, games: user.games_puzzle, provisional: user.provisional?.puzzle ?? false }
    : null

  // Session selection (persisted defaults).
  const [mode, setMode] = useState<Mode>('setup')
  const [theme, setTheme] = useState(readTheme)
  const [limitSec, setLimitSec] = useState<number | null>(readLimit)

  // Clock: a wall-clock deadline + a ticking display value (timed sessions only).
  const [deadline, setDeadline] = useState<number | null>(null)
  const [remainingMs, setRemainingMs] = useState(0)

  // Per-puzzle solving state.
  const [data, setData] = useState<PuzzleNext | null>(null)
  const [phase, setPhase] = useState<Phase>('loading')
  const [fen, setFen] = useState<string>('')
  const [legal, setLegal] = useState<string[]>([])
  const [ply, setPly] = useState(1)
  const [lastMove, setLastMove] = useState<Mark | null>(null)
  const [override, setOverride] = useState<BoardMap | null>(null)
  const [result, setResult] = useState<PuzzleMoveResult | null>(null)
  const [error, setError] = useState<string | null>(null)
  // In-memory (non-persisted) win/loss log for the CURRENT session, newest last.
  const [history, setHistory] = useState<Outcome[]>([])

  // Timers for the staged opponent-move + auto-advance animations.
  const timers = useRef<ReturnType<typeof setTimeout>[]>([])
  const clearTimers = () => {
    timers.current.forEach(clearTimeout)
    timers.current = []
  }
  const later = (fn: () => void, ms: number) => {
    timers.current.push(setTimeout(fn, ms))
  }
  // A queued auto-advance must not fire after the session has ended (clock hit 0
  // mid-puzzle). `runningRef` mirrors `mode` synchronously for that guard, and
  // `lowTimeFiredRef` makes the 10-second warning sound play exactly once.
  const runningRef = useRef(false)
  const lowTimeFiredRef = useRef(false)
  useEffect(() => {
    runningRef.current = mode === 'running'
  }, [mode])

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

  const startSession = useCallback(
    (limit: number | null, forTheme: string) => {
      clearTimers()
      lowTimeFiredRef.current = false
      setHistory([])
      setError(null)
      setLimitSec(limit)
      setTheme(forTheme)
      storeLimit(limit)
      storeTheme(forTheme)
      if (limit != null) {
        setDeadline(Date.now() + limit * 1000)
        setRemainingMs(limit * 1000)
      } else {
        setDeadline(null)
        setRemainingMs(0)
      }
      setMode('running')
      void load(forTheme)
    },
    [load],
  )

  const endSession = useCallback(() => {
    clearTimers()
    setDeadline(null)
    setMode('over')
  }, [])

  // Countdown: tick the displayed clock, warn at 10s, end the session at 0.
  useEffect(() => {
    if (mode !== 'running' || deadline == null) return
    const tick = () => {
      const left = deadline - Date.now()
      if (left <= 0) {
        setRemainingMs(0)
        endSession()
        return
      }
      setRemainingMs(left)
      if (left <= 10_000 && !lowTimeFiredRef.current) {
        lowTimeFiredRef.current = true
        sounds.lowTime()
      }
    }
    tick()
    const id = setInterval(tick, 200)
    return () => clearInterval(id)
  }, [mode, deadline, endSession])

  // Enter = next puzzle (when one is solved/failed) or replay (on the summary).
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Enter') return
      if (mode === 'running' && (phase === 'solved' || phase === 'failed')) {
        e.preventDefault()
        void load(theme)
      } else if (mode === 'over') {
        e.preventDefault()
        startSession(limitSec, theme)
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [mode, phase, theme, limitSec, load, startSession])

  // Clear any pending timers on unmount.
  useEffect(() => clearTimers, [])

  // Advance to the next puzzle — but only if the session is still running (a
  // queued advance is dropped if the clock expired while this puzzle resolved).
  const advance = () => {
    if (runningRef.current) void load(theme)
  }

  async function onMove(uci: string) {
    if (phase !== 'solving' || !data) return
    const board = parseFen(fen)
    setOverride(applyUciVisually(board, uci))
    setLastMove(splitUci(uci))
    playForMove(board, uci)
    setPhase('checking')
    try {
      const res = await submitPuzzleMove(data.id, uci, fen, ply)

      if (res.correct && res.complete) {
        setOverride(null)
        setFen(res.fen ?? fen)
        setResult(res)
        setPhase('solved')
        sounds.success()
        setHistory((h) => [...h, { win: true, delta: res.rating?.delta ?? null }])
        if (res.rating) void authStore.refresh()
        // Timed: keep momentum (short pause). Untimed: a longer celebratory beat.
        later(advance, limitSec == null ? 2000 : 650)
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
      setHistory((h) => [...h, { win: false, delta: res.rating?.delta ?? null }])
      if (res.rating) void authStore.refresh()
      // Timed: auto-advance after a glimpse of the solution. Untimed: wait for the
      // player (Enter / "Next") so they can study it.
      if (limitSec != null) later(advance, 1300)
    } catch (e) {
      // Network/server error — revert the optimistic move, let them retry.
      setOverride(null)
      setLastMove(null)
      setPhase('solving')
      setError(e instanceof Error ? e.message : 'Move failed.')
    }
  }

  if (mode === 'setup') {
    return (
      <CenteredScreen>
        <SetupScreen
          theme={theme}
          limitSec={limitSec}
          user={userStats}
          onTheme={(t) => {
            setTheme(t)
            storeTheme(t)
          }}
          onLimit={(l) => {
            setLimitSec(l)
            storeLimit(l)
          }}
          onStart={() => startSession(limitSec, theme)}
        />
      </CenteredScreen>
    )
  }

  if (mode === 'over') {
    return (
      <CenteredScreen>
        <SummaryScreen
          history={history}
          theme={theme}
          limitSec={limitSec}
          loggedIn={!!user}
          onPlayAgain={() => startSession(limitSec, theme)}
          onChange={() => setMode('setup')}
        />
      </CenteredScreen>
    )
  }

  const orientation: Color = data?.color ?? 'w'
  const displayFen = phase === 'intro' || !data ? (data?.start_fen ?? START_FEN) : fen
  const interactive = phase === 'solving'

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
        {/* Left — session info (desktop) */}
        <Box sx={{ display: { xs: 'none', md: 'block' }, justifySelf: 'end', alignSelf: 'start', width: '100%' }}>
          <RunningAside user={userStats} theme={theme} limitSec={limitSec} />
        </Box>

        {/* Center — board, top-aligned to line up with the side cards. */}
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

        {/* Right — clock / status / controls */}
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
            user={userStats}
            theme={theme}
            limitSec={limitSec}
            remainingMs={remainingMs}
            onNext={() => void load(theme)}
            onStop={endSession}
          />
          <HistoryStrip history={history} />
          {error && <ErrorBanner sx={{ mx: 0, mt: 1.5 }}>{error}</ErrorBanner>}
        </Box>
      </Box>
    </Box>
  )
}

function CenteredScreen({ children }: { children: ReactNode }) {
  return (
    <Box
      sx={{
        flex: 1,
        display: 'flex',
        justifyContent: 'center',
        alignItems: { xs: 'flex-start', md: 'center' },
        px: { xs: 2, md: 3 },
        py: { xs: 4, md: 2 },
      }}
    >
      <Box sx={{ width: '100%', maxWidth: 460 }}>{children}</Box>
    </Box>
  )
}

function Card({ children, sx }: { children: ReactNode; sx?: object }) {
  return (
    <Box
      sx={{
        bgcolor: 'var(--surface)',
        border: '1px solid var(--line-soft)',
        borderRadius: '16px',
        boxShadow: '0 18px 50px -28px rgba(0,0,0,0.8)',
        ...sx,
      }}
    >
      {children}
    </Box>
  )
}

function SetupScreen({
  theme,
  limitSec,
  user,
  onTheme,
  onLimit,
  onStart,
}: {
  theme: string
  limitSec: number | null
  user: { rating: number; games: number; provisional: boolean } | null
  onTheme: (t: string) => void
  onLimit: (l: number | null) => void
  onStart: () => void
}) {
  return (
    <Card sx={{ p: { xs: 3, md: 3.5 } }}>
      <Box sx={{ display: 'flex', alignItems: 'center', gap: 1.5 }}>
        <Box
          sx={{
            width: 40,
            height: 40,
            borderRadius: '12px',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            bgcolor: 'var(--accent-soft)',
            border: '1px solid var(--accent-line)',
            color: 'var(--accent)',
          }}
        >
          <Target size={20} />
        </Box>
        <Box>
          <Typography sx={{ fontFamily: 'var(--font-display)', fontWeight: 700, fontSize: 24, lineHeight: 1.1 }}>
            Puzzles
          </Typography>
          <Typography sx={{ fontSize: 13, color: 'var(--muted)' }}>
            Solve as many as you can before the clock runs out.
          </Typography>
        </Box>
      </Box>

      <Box sx={{ mt: 3 }}>
        <Label>Theme</Label>
        <ThemeSelect value={theme} onChange={onTheme} />
      </Box>

      <Box sx={{ mt: 2.75 }}>
        <Label>Time</Label>
        <TimeFormatPicker value={limitSec} onChange={onLimit} />
      </Box>

      <Box sx={{ mt: 3 }}>
        <ActionBtn tone="primary" large icon={<Play size={17} />} label="Start session" onClick={onStart} />
      </Box>

      <Typography sx={{ fontSize: 12.5, color: 'var(--muted)', mt: 2, textAlign: 'center' }}>
        {user ? (
          <>
            Your puzzle rating{' '}
            <Box component="span" sx={{ fontFamily: 'var(--font-mono)', color: 'var(--accent)' }}>
              {user.rating}{user.provisional ? '?' : ''}
            </Box>{' '}
            · {user.games} solved
          </>
        ) : (
          'Log in to track your puzzle rating.'
        )}
      </Typography>
    </Card>
  )
}

function TimeFormatPicker({ value, onChange }: { value: number | null; onChange: (v: number | null) => void }) {
  return (
    <Box sx={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 1 }}>
      {TIME_FORMATS.map((f) => {
        const active = f.value === value
        return (
          <Box
            component="button"
            key={String(f.value)}
            onClick={() => onChange(f.value)}
            sx={{
              display: 'flex',
              flexDirection: 'column',
              alignItems: 'center',
              justifyContent: 'center',
              gap: 0.25,
              py: 1.4,
              cursor: 'pointer',
              borderRadius: '12px',
              transition: 'background .15s, color .15s, border-color .15s',
              color: active ? 'var(--accent)' : 'var(--text)',
              bgcolor: active ? 'var(--accent-soft)' : 'var(--surface-2)',
              border: `1px solid ${active ? 'var(--accent-line)' : 'var(--line)'}`,
              '&:hover': { borderColor: 'var(--accent-line)' },
              '&:active': { transform: 'translateY(1px)' },
            }}
          >
            <Typography sx={{ fontFamily: 'var(--font-mono)', fontSize: 21, fontWeight: 700, lineHeight: 1 }}>
              {f.time}
            </Typography>
            <Typography sx={{ fontSize: 11, color: active ? 'var(--accent)' : 'var(--muted)' }}>{f.tag}</Typography>
          </Box>
        )
      })}
    </Box>
  )
}

function SummaryScreen({
  history,
  theme,
  limitSec,
  loggedIn,
  onPlayAgain,
  onChange,
}: {
  history: Outcome[]
  theme: string
  limitSec: number | null
  loggedIn: boolean
  onPlayAgain: () => void
  onChange: () => void
}) {
  const wins = history.filter((h) => h.win).length
  const losses = history.length - wins
  const net = history.reduce((s, h) => s + (h.delta ?? 0), 0)
  const fmt = TIME_FORMATS.find((f) => f.value === limitSec)

  return (
    <Card sx={{ p: { xs: 3, md: 3.5 } }}>
      <Box sx={{ display: 'flex', alignItems: 'center', gap: 1.5 }}>
        <Box
          sx={{
            width: 40,
            height: 40,
            borderRadius: '12px',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            bgcolor: 'var(--accent-soft)',
            border: '1px solid var(--accent-line)',
            color: 'var(--accent)',
          }}
        >
          <Trophy size={20} />
        </Box>
        <Box>
          <Typography sx={{ fontFamily: 'var(--font-display)', fontWeight: 700, fontSize: 24, lineHeight: 1.1 }}>
            Session complete
          </Typography>
          <Typography sx={{ fontSize: 13, color: 'var(--muted)' }}>
            {themeLabel(theme)} · {fmt ? fmt.tag : 'Untimed'}
          </Typography>
        </Box>
      </Box>

      <Box sx={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: 1, mt: 3 }}>
        <Stat value={String(wins)} label="Solved" color="#7bb661" />
        <Stat value={String(losses)} label="Missed" color="#e0796b" />
        {loggedIn && (
          <Stat
            value={`${net >= 0 ? '+' : ''}${net}`}
            label="Rating"
            color={net >= 0 ? '#7bb661' : '#e0796b'}
          />
        )}
      </Box>

      {history.length > 0 && (
        <Box sx={{ mt: 2.5 }}>
          <Label>This session</Label>
          <HistoryBoxes history={history} />
        </Box>
      )}

      <Box sx={{ display: 'flex', gap: 1, mt: 3 }}>
        <ActionBtn tone="primary" large icon={<RotateCcw size={16} />} label="Play again" onClick={onPlayAgain} />
        <ActionBtn tone="neutral" large icon={<Target size={16} />} label="Change" onClick={onChange} />
      </Box>
    </Card>
  )
}

function Stat({ value, label, color }: { value: string; label: string; color: string }) {
  return (
    <Box
      sx={{
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
        gap: 0.25,
        py: 1.5,
        borderRadius: '12px',
        bgcolor: 'var(--surface-2)',
        border: '1px solid var(--line)',
      }}
    >
      <Typography sx={{ fontFamily: 'var(--font-mono)', fontSize: 26, fontWeight: 700, lineHeight: 1, color }}>
        {value}
      </Typography>
      <Typography sx={{ fontSize: 11, color: 'var(--muted)', textTransform: 'uppercase', letterSpacing: '0.1em' }}>
        {label}
      </Typography>
    </Box>
  )
}

function RunningAside({
  user,
  theme,
  limitSec,
}: {
  user: { rating: number; games: number; provisional: boolean } | null
  theme: string
  limitSec: number | null
}) {
  const fmt = TIME_FORMATS.find((f) => f.value === limitSec)
  return (
    <Card sx={{ p: 2.5 }}>
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

      <Box sx={{ borderTop: '1px solid var(--line-soft)', mt: 2.25, pt: 2.25 }}>
        <Label>Your puzzle rating</Label>
        {user ? (
          <Box sx={{ display: 'flex', alignItems: 'baseline', gap: 1 }}>
            <Typography sx={{ fontFamily: 'var(--font-mono)', fontSize: 30, fontWeight: 700, color: 'var(--accent)', lineHeight: 1 }}>
              {user.rating}{user.provisional ? '?' : ''}
            </Typography>
            <Typography sx={{ fontSize: 13, color: 'var(--muted)' }}>· {user.games} solved</Typography>
          </Box>
        ) : (
          <Typography sx={{ fontSize: 13, color: 'var(--text-dim)' }}>Log in to track your rating.</Typography>
        )}
      </Box>

      <Box sx={{ borderTop: '1px solid var(--line-soft)', mt: 2.25, pt: 2.25, display: 'flex', gap: 0.75 }}>
        <Chip>{themeLabel(theme)}</Chip>
        <Chip>
          {limitSec == null ? <InfinityIcon size={13} /> : <Clock size={13} />}
          {fmt ? fmt.tag : 'Untimed'}
        </Chip>
      </Box>
    </Card>
  )
}

function StatusCard({
  phase,
  orientation,
  puzzleRating,
  result,
  user,
  theme,
  limitSec,
  remainingMs,
  onNext,
  onStop,
}: {
  phase: Phase
  orientation: Color
  puzzleRating: number | null
  result: PuzzleMoveResult | null
  user: { rating: number; games: number; provisional: boolean } | null
  theme: string
  limitSec: number | null
  remainingMs: number
  onNext: () => void
  onStop: () => void
}) {
  const terminal = phase === 'solved' || phase === 'failed'
  const delta = result?.rating?.delta ?? null
  const toMove = orientation === 'w' ? 'White' : 'Black'
  const lowTime = limitSec != null && remainingMs <= 10_000

  return (
    <Card sx={{ overflow: 'hidden' }}>
      {/* Clock + theme */}
      <Box
        sx={{
          px: 2.25,
          py: 1.75,
          borderBottom: '1px solid var(--line-soft)',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
        }}
      >
        <Box sx={{ display: 'flex', alignItems: 'center', gap: 1, color: lowTime ? '#e0796b' : 'var(--text-dim)' }}>
          {limitSec == null ? <InfinityIcon size={18} /> : <Clock size={18} />}
          <Typography
            sx={{
              fontFamily: 'var(--font-mono)',
              fontSize: limitSec == null ? 18 : 24,
              fontWeight: 700,
              lineHeight: 1,
              color: limitSec == null ? 'var(--text-dim)' : lowTime ? '#e0796b' : 'var(--text)',
            }}
          >
            {limitSec == null ? 'Untimed' : fmtClock(remainingMs)}
          </Typography>
        </Box>
        <Chip>{themeLabel(theme)}</Chip>
      </Box>

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
              {result?.alternative && (
                <Typography sx={{ fontSize: 13, color: 'var(--muted)' }}>Not the puzzle line — but that works!</Typography>
              )}
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
      <Box sx={{ px: 2.25, pb: 2.25, display: 'flex', flexDirection: 'column', gap: 1.25 }}>
        <ActionBtn
          tone={terminal ? 'primary' : 'neutral'}
          icon={terminal ? <ChevronRight size={16} /> : <RotateCcw size={15} />}
          label={terminal ? 'Next puzzle' : 'Skip'}
          onClick={onNext}
        />
        <ActionBtn tone="danger" icon={<StopIcon size={14} />} label="Stop session" onClick={onStop} />

        {/* Mobile-only rating line (the desktop aside is hidden on xs). */}
        <Typography sx={{ display: { xs: 'block', md: 'none' }, fontSize: 12.5, color: 'var(--muted)', mt: 0.5 }}>
          {user ? (
            <>
              Your rating:{' '}
              <Box component="span" sx={{ fontFamily: 'var(--font-mono)', color: 'var(--text-dim)' }}>
                {user.rating}{user.provisional ? '?' : ''}
              </Box>{' '}
              · {user.games} solved
            </>
          ) : (
            'Log in to track your puzzle rating.'
          )}
        </Typography>
      </Box>
    </Card>
  )
}

function HistoryStrip({ history }: { history: Outcome[] }) {
  if (history.length === 0) return null
  const wins = history.filter((h) => h.win).length
  const losses = history.length - wins

  return (
    <Card sx={{ p: 2.25, mt: 1.5 }}>
      <Box sx={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', mb: 1.25 }}>
        <Label>History</Label>
        <Typography sx={{ fontFamily: 'var(--font-mono)', fontSize: 12 }}>
          <Box component="span" sx={{ color: '#7bb661' }}>{wins}W</Box>
          <Box component="span" sx={{ color: 'var(--muted)' }}> · </Box>
          <Box component="span" sx={{ color: '#e0796b' }}>{losses}L</Box>
        </Typography>
      </Box>
      <HistoryBoxes history={history} />
    </Card>
  )
}

function HistoryBoxes({ history }: { history: Outcome[] }) {
  // Newest first so the most recent result is the easy-to-spot top-left box.
  const ordered = [...history].reverse()
  return (
    <Box sx={{ display: 'flex', flexWrap: 'wrap', gap: 0.6 }}>
      {ordered.map(({ win, delta }, i) => (
        <Box
          key={history.length - 1 - i}
          sx={{
            minWidth: 26,
            height: 26,
            px: delta != null ? 0.85 : 0,
            borderRadius: '7px',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            gap: 0.4,
            fontFamily: 'var(--font-mono)',
            fontSize: 11.5,
            fontWeight: 600,
            color: win ? '#7bb661' : '#e0796b',
            bgcolor: win ? 'rgba(123,182,97,0.16)' : 'rgba(224,121,107,0.16)',
            border: `1px solid ${win ? 'rgba(123,182,97,0.4)' : 'rgba(224,121,107,0.4)'}`,
          }}
        >
          {win ? <Check size={13} /> : <X size={13} />}
          {delta != null && (
            <span>
              {delta >= 0 ? '+' : ''}
              {delta}
            </span>
          )}
        </Box>
      ))}
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

function Chip({ children }: { children: ReactNode }) {
  return (
    <Box
      sx={{
        display: 'inline-flex',
        alignItems: 'center',
        gap: 0.5,
        px: 1,
        py: 0.4,
        borderRadius: '8px',
        fontSize: 12.5,
        color: 'var(--text-dim)',
        bgcolor: 'var(--surface-2)',
        border: '1px solid var(--line)',
      }}
    >
      {children}
    </Box>
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
