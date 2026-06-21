import { useEffect, useRef, useState } from 'react'
import { Box, Slider, ToggleButton, ToggleButtonGroup, Typography } from '@mui/material'
import { Bot, Cpu, Pause, Play, RotateCcw, SquarePen, Telescope, Volume2, VolumeX } from 'lucide-react'
import { useLocation, useNavigate } from 'react-router-dom'
import Board from '../components/Board'
import EvalBar, { type WhiteEval } from '../components/EvalBar'
import MoveList from '../components/MoveList'
import { ActionBtn, ErrorBanner, NavBtn } from '../components/PanelUI'
import { analyze, type Color, engineVsMove, type EngineSide, type GameStatus, type MoveEntry } from '../api/client'
import { useAuth } from '../lib/auth'
import { statusLabel } from '../lib/chess'
import { playForSan, setSoundEnabled, soundEnabled, sounds } from '../lib/sounds'

const START_FEN = 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1'
const MAX_PLIES = 400 // hard stop so two shuffling engines can't loop forever
const MOVE_DELAY = 550 // ms between plies, so it's watchable

const sideToMoveOf = (fen: string): Color => (fen.split(' ')[1] === 'b' ? 'b' : 'w')

// The left-card settings persist to localStorage, so whatever you last set becomes
// your new defaults on the next visit.
const SETTINGS_KEY = 'eve.settings'
interface EveSettings {
  gomaRating: number
  sfElo: number
  gomaSide: Color
  budget: number
}
const DEFAULT_SETTINGS: EveSettings = { gomaRating: 2200, sfElo: 1500, gomaSide: 'w', budget: 300 }

function loadSettings(): EveSettings {
  try {
    const raw = localStorage.getItem(SETTINGS_KEY)
    if (!raw) return DEFAULT_SETTINGS
    const p = JSON.parse(raw) as Partial<EveSettings>
    return {
      gomaRating: typeof p.gomaRating === 'number' ? p.gomaRating : DEFAULT_SETTINGS.gomaRating,
      sfElo: typeof p.sfElo === 'number' ? p.sfElo : DEFAULT_SETTINGS.sfElo,
      gomaSide: p.gomaSide === 'b' ? 'b' : 'w',
      budget: typeof p.budget === 'number' ? p.budget : DEFAULT_SETTINGS.budget,
    }
  } catch {
    return DEFAULT_SETTINGS // unparseable / storage unavailable → fall back to defaults
  }
}

/** Admin-only: watch our engine (gomachine, at a target Elo rating) play Stockfish
 * (at a UCI_Elo). The browser drives the game ply-by-ply through the admin proxy;
 * the engines themselves stay stateless. */
export default function EngineVsEngine() {
  const { user, status: authStatus } = useAuth()
  const navigate = useNavigate()
  // A starting position carried over from the board editor ("Engine vs Engine
  // from this position"). Falls back to the standard start.
  const navFen = (useLocation().state as { fen?: string } | null)?.fen ?? null
  const startFen = navFen ?? START_FEN

  // Settings — initialised from (and persisted back to) localStorage.
  const [gomaRating, setGomaRating] = useState(() => loadSettings().gomaRating)
  const [sfElo, setSfElo] = useState(() => loadSettings().sfElo)
  const [gomaSide, setGomaSide] = useState<Color>(() => loadSettings().gomaSide)
  const [budget, setBudget] = useState(() => loadSettings().budget) // ms per move, both engines

  useEffect(() => {
    try {
      localStorage.setItem(SETTINGS_KEY, JSON.stringify({ gomaRating, sfElo, gomaSide, budget }))
    } catch {
      // storage unavailable / quota — settings just won't persist this session
    }
  }, [gomaRating, sfElo, gomaSide, budget])

  // Game
  const [fen, setFen] = useState(startFen)
  const [moves, setMoves] = useState<MoveEntry[]>([])
  const [status, setStatus] = useState<GameStatus>('ongoing')
  const [result, setResult] = useState<string | null>(null)
  const [lastMove, setLastMove] = useState<{ from: string; to: string } | null>(null)
  const [whiteEval, setWhiteEval] = useState<WhiteEval | null>(null)
  const [running, setRunning] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [sound, setSound] = useState(soundEnabled())
  const thinkingRef = useRef(false)

  const ply = moves.length
  const over = status !== 'ongoing'
  const sideToMove = sideToMoveOf(fen)
  const moverSide: EngineSide = sideToMove === gomaSide ? 'gomachine' : 'stockfish'

  // The engine loop: when running, fetch the side-to-move's move after a delay,
  // apply it (server returns the new FEN), and let the ply change re-trigger us.
  useEffect(() => {
    if (!running || over) return
    if (ply >= MAX_PLIES) {
      setRunning(false)
      setResult('1/2-1/2')
      return
    }
    let cancelled = false
    const id = setTimeout(async () => {
      thinkingRef.current = true
      try {
        const res = await engineVsMove({
          fen,
          side: moverSide,
          movetime: budget,
          ...(moverSide === 'gomachine' ? { rating: gomaRating } : { elo: sfElo }),
        })
        if (cancelled) return
        if (!res.bestmove || !res.fen) {
          setRunning(false)
          setError(res.reason ?? 'engine returned no move')
          return
        }
        setLastMove({ from: res.bestmove.slice(0, 2), to: res.bestmove.slice(2, 4) })
        setMoves((m) => [
          ...m,
          { ply: m.length + 1, uci: res.bestmove!, san: res.san ?? res.bestmove!, by: 'bot', fen: res.fen! },
        ])
        setFen(res.fen)
        const gameOver = res.status !== 'ongoing' || !!res.claimableDraws?.includes('fifty')
        playForSan(res.san ?? res.bestmove, gameOver) // move/capture/end cue
        if (res.status !== 'ongoing') {
          setStatus(res.status)
          setResult(res.result ?? null)
          setRunning(false)
        } else if (res.claimableDraws?.includes('fifty')) {
          setStatus('draw-fifty')
          setResult('1/2-1/2')
          setRunning(false)
        }
      } catch (e) {
        if (!cancelled) {
          setError(e instanceof Error ? e.message : 'move failed')
          setRunning(false)
        }
      } finally {
        thinkingRef.current = false
      }
    }, MOVE_DELAY)
    return () => {
      cancelled = true
      clearTimeout(id)
    }
  }, [running, ply, over, fen, sideToMove, moverSide, gomaRating, sfElo, budget])

  // Eval bar = ONE consistent evaluator: gomachine at full strength, re-reading the
  // current position after every ply regardless of who moved. We deliberately do NOT
  // use the mover's own search — gomachine's is rating-limited (and one-sided), and
  // Stockfish returns no eval at all. A fast (300ms) /analyze keeps the loop snappy
  // while still surfacing forced mates as M1/M2.
  useEffect(() => {
    if (over) {
      // Checkmate: the side to move has been mated, so it's lost. Other terminals
      // (stalemate / draws) are dead even.
      setWhiteEval(status === 'checkmate' ? { type: 'mate', white: sideToMove === 'w' ? -1 : 1 } : { type: 'cp', white: 0 })
      return
    }
    if (ply === 0) {
      setWhiteEval(null) // neutral bar on the idle start screen
      return
    }
    let cancelled = false
    analyze(fen, { movetime: 300 })
      .then((r) => {
        if (cancelled || !r.eval) return
        const white = sideToMove === 'w' ? r.eval.value : -r.eval.value
        setWhiteEval({ type: r.eval.type, white })
      })
      .catch(() => {}) // a transient analyze failure just leaves the last eval shown
    return () => {
      cancelled = true
    }
  }, [fen, status, over, sideToMove, ply])

  function reset() {
    setRunning(false)
    setFen(startFen)
    setMoves([])
    setStatus('ongoing')
    setResult(null)
    setLastMove(null)
    setWhiteEval(null)
    setError(null)
  }

  // Re-entering from the editor with a different position: adopt it and reset the
  // game (the initial state only reads navFen once).
  useEffect(() => {
    if (!navFen) return
    setRunning(false)
    setFen(navFen)
    setMoves([])
    setStatus('ongoing')
    setResult(null)
    setLastMove(null)
    setWhiteEval(null)
    setError(null)
  }, [navFen])

  function toggleRun() {
    if (over) reset()
    setRunning((r) => !r)
  }

  function toggleSound() {
    const next = !sound
    setSound(next)
    setSoundEnabled(next)
    if (next) sounds.move()
  }

  if (authStatus === 'loading') {
    return <Centered>Loading…</Centered>
  }
  if (user?.role !== 'admin') {
    return <Centered>This page is for admins only.</Centered>
  }

  const caption = over
    ? `${statusLabel(status)}${result ? ` · ${result}` : ''}`
    : running
      ? `${moverSide === 'gomachine' ? 'gomachine' : 'Stockfish'} to move…`
      : ply > 0
        ? 'Paused'
        : 'Set strengths and press Start'

  return (
    <Box sx={{ flex: 1, display: 'flex', justifyContent: 'center', alignItems: 'flex-start', px: { xs: 2, md: 3 }, py: 3 }}>
      <Box
        sx={{
          display: 'grid',
          gridTemplateColumns: { xs: '1fr', md: '320px min(calc(100vh - 120px), calc(100vw - 752px), 880px) 320px' },
          columnGap: { md: 4 },
          rowGap: 3,
          width: { xs: '100%', md: 'fit-content' },
          maxWidth: '100%',
          mx: 'auto',
          alignItems: 'start',
        }}
      >
        {/* Left — controls */}
        <Box sx={{ display: { xs: 'block', md: 'block' }, width: '100%' }}>
          <Controls
            gomaRating={gomaRating}
            sfElo={sfElo}
            gomaSide={gomaSide}
            budget={budget}
            running={running}
            disabledSettings={running}
            onRating={setGomaRating}
            onElo={setSfElo}
            onSide={setGomaSide}
            onBudget={setBudget}
            onToggleRun={toggleRun}
            onReset={reset}
            over={over}
          />
        </Box>

        {/* Center — board */}
        <Box sx={{ alignSelf: 'start', width: { xs: 'min(94vw, 64vh)', md: '100%' }, display: 'flex', gap: 1.25 }}>
          <EvalBar ev={whiteEval} orientation={gomaSide} />
          <Box sx={{ flex: 1, minWidth: 0 }}>
            <Board
              fen={fen}
              orientation={gomaSide}
              sideToMove={sideToMove}
              legalMoves={[]}
              lastMove={lastMove}
              inCheck={false}
              interactive={false}
              onMove={() => {}}
            />
          </Box>
        </Box>

        {/* Right — status + move list */}
        <Box sx={{ width: '100%', display: 'flex', flexDirection: 'column', gap: 1.5 }}>
          <Box
            sx={{
              bgcolor: 'var(--surface)',
              border: '1px solid var(--line-soft)',
              borderRadius: '14px',
              p: 1.75,
              display: 'flex',
              flexDirection: 'column',
              gap: 1,
            }}
          >
            <MatchupRow icon={<Cpu size={16} />} name="gomachine" detail={`~${gomaRating} Elo`} side={gomaSide} />
            <MatchupRow icon={<Bot size={16} />} name="Stockfish" detail={`${sfElo} Elo`} side={gomaSide === 'w' ? 'b' : 'w'} />
            <Box sx={{ display: 'flex', alignItems: 'center', gap: 1, mt: 0.5 }}>
              <Typography sx={{ fontSize: 13, fontWeight: 600, color: 'var(--text-dim)' }}>{caption}</Typography>
              <Box sx={{ flex: 1 }} />
              <NavBtn
                label="Edit start position"
                onClick={() => navigate('/editor', { state: { fen: startFen } })}
                disabled={running}
              >
                <SquarePen size={18} />
              </NavBtn>
              <NavBtn
                label="Analyse"
                onClick={() => navigate('/analysis', { state: { moves: moves.map((m) => m.uci), startFen } })}
                disabled={moves.length === 0}
              >
                <Telescope size={18} />
              </NavBtn>
              <NavBtn label={sound ? 'Mute' : 'Unmute'} onClick={toggleSound}>
                {sound ? <Volume2 size={18} /> : <VolumeX size={18} />}
              </NavBtn>
            </Box>
          </Box>
          {error && <ErrorBanner>{error}</ErrorBanner>}
          <Box sx={{ height: 420, display: 'flex' }}>
            <MoveList fill moves={moves} currentPly={ply} onSelectPly={() => {}} />
          </Box>
        </Box>
      </Box>
    </Box>
  )
}

function MatchupRow({ icon, name, detail, side }: { icon: React.ReactNode; name: string; detail: string; side: Color }) {
  return (
    <Box sx={{ display: 'flex', alignItems: 'center', gap: 1 }}>
      <Box sx={{ color: 'var(--accent)' }}>{icon}</Box>
      <Typography sx={{ fontWeight: 700, fontSize: 14 }}>{name}</Typography>
      <Typography sx={{ fontSize: 12.5, color: 'var(--text-dim)' }}>{detail}</Typography>
      <Box sx={{ flex: 1 }} />
      <Typography sx={{ fontSize: 11, color: 'var(--muted)', fontFamily: 'var(--font-mono)' }}>
        {side === 'w' ? 'White' : 'Black'}
      </Typography>
    </Box>
  )
}

function Controls({
  gomaRating,
  sfElo,
  gomaSide,
  budget,
  running,
  disabledSettings,
  onRating,
  onElo,
  onSide,
  onBudget,
  onToggleRun,
  onReset,
  over,
}: {
  gomaRating: number
  sfElo: number
  gomaSide: Color
  budget: number
  running: boolean
  disabledSettings: boolean
  onRating: (n: number) => void
  onElo: (n: number) => void
  onSide: (c: Color) => void
  onBudget: (n: number) => void
  onToggleRun: () => void
  onReset: () => void
  over: boolean
}) {
  return (
    <Box
      sx={{
        bgcolor: 'var(--surface)',
        border: '1px solid var(--line-soft)',
        borderRadius: '14px',
        p: 2.5,
        display: 'flex',
        flexDirection: 'column',
        gap: 2.5,
        boxShadow: '0 18px 50px -28px rgba(0,0,0,0.8)',
      }}
    >
      <Box>
        <Typography sx={{ fontFamily: 'var(--font-display)', fontSize: 22, fontWeight: 700, lineHeight: 1.1 }}>
          Engine vs Engine
        </Typography>
        <Typography sx={{ fontSize: 13, color: 'var(--text-dim)', mt: 0.5 }}>
          gomachine vs Stockfish — admin only.
        </Typography>
      </Box>

      <Box>
        <Label>gomachine rating</Label>
        <SettingValue>~{gomaRating} Elo</SettingValue>
        <Slider value={gomaRating} onChange={(_, v) => onRating(v as number)} min={700} max={2900} step={50} disabled={disabledSettings} sx={sliderSx} />
      </Box>

      <Box>
        <Label>Stockfish rating</Label>
        <SettingValue>{sfElo} Elo</SettingValue>
        <Slider value={sfElo} onChange={(_, v) => onElo(v as number)} min={1320} max={3190} step={10} disabled={disabledSettings} sx={sliderSx} />
      </Box>

      <Box>
        <Label>gomachine plays</Label>
        <ToggleButtonGroup
          exclusive
          fullWidth
          size="small"
          value={gomaSide}
          onChange={(_, v) => v && onSide(v as Color)}
          disabled={disabledSettings}
          sx={toggleSx}
        >
          <ToggleButton value="w">White</ToggleButton>
          <ToggleButton value="b">Black</ToggleButton>
        </ToggleButtonGroup>
      </Box>

      <Box>
        <Label>Move budget</Label>
        <SettingValue>{budget} ms / move</SettingValue>
        <Slider value={budget} onChange={(_, v) => onBudget(v as number)} min={50} max={3000} step={50} sx={sliderSx} />
        <Typography sx={{ fontSize: 11.5, color: 'var(--muted)', mt: 0.25 }}>
          Both engines think this long. Above ~2400, more time = stronger than the rating.
        </Typography>
      </Box>

      <Box sx={{ display: 'flex', gap: 1 }}>
        <ActionBtn
          tone="primary"
          icon={running ? <Pause size={15} /> : <Play size={15} />}
          label={running ? 'Pause' : over ? 'Play again' : 'Start'}
          onClick={onToggleRun}
        />
        <ActionBtn tone="danger" icon={<RotateCcw size={15} />} label="Reset" onClick={onReset} />
      </Box>
    </Box>
  )
}

function Centered({ children }: { children: React.ReactNode }) {
  return (
    <Box sx={{ flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center', p: 4 }}>
      <Typography sx={{ color: 'var(--text-dim)' }}>{children}</Typography>
    </Box>
  )
}

function Label({ children }: { children: React.ReactNode }) {
  return (
    <Typography sx={{ fontFamily: 'var(--font-mono)', fontSize: 11, letterSpacing: '0.16em', textTransform: 'uppercase', color: 'var(--muted)' }}>
      {children}
    </Typography>
  )
}

function SettingValue({ children }: { children: React.ReactNode }) {
  return (
    <Typography sx={{ fontFamily: 'var(--font-mono)', fontSize: 14, fontWeight: 700, color: 'var(--accent)', mb: 0.25 }}>
      {children}
    </Typography>
  )
}

const sliderSx = {
  color: 'var(--accent)',
  height: 5,
  '& .MuiSlider-rail': { opacity: 0.4, bgcolor: 'var(--line)' },
  '& .MuiSlider-track': { border: 'none' },
  '& .MuiSlider-thumb': { width: 16, height: 16, bgcolor: '#f3eee2' },
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
    py: 0.8,
    '&.Mui-selected': {
      color: '#15171c',
      background: 'linear-gradient(180deg, #e3b56a, #d8a657)',
      borderColor: 'var(--accent)',
    },
  },
}
