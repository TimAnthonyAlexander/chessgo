import { useEffect, useRef, useState } from 'react'
import { Box, Button, Switch, Tooltip, Typography } from '@mui/material'
import { ArrowLeft, Gauge, Target, User } from 'lucide-react'
import { useNavigate, useParams } from 'react-router-dom'
import Board from '../components/Board'
import Clock from '../components/Clock'
import EvalBar, { type WhiteEval } from '../components/EvalBar'
import MoveList from '../components/MoveList'
import { Avatar, PANEL_SHADOW } from '../components/PanelUI'
import { analyze, type MoveEntry } from '../api/client'
import { pvToSan } from '../lib/analysisTree'
import { type SpectateGame, type SpectateSide, spectateRemaining, spectateSocket } from '../lib/spectate'
import { useSpectate } from '../lib/useSpectate'
import { useAuth } from '../lib/auth'
import { playForSan, sounds } from '../lib/sounds'

// Admins get a full-strength eval bar + best-move arrow over the spectated board,
// each independently toggleable (persisted in localStorage). Ordinary spectators
// see the board as-is — no analyze traffic for them.
const LS_EVAL = 'spectate-eval-bar'
const LS_ARROW = 'spectate-best-arrow'

function loadFlag(key: string): boolean {
  try {
    return localStorage.getItem(key) === '1'
  } catch {
    return false
  }
}

function saveFlag(key: string, on: boolean): void {
  try {
    localStorage.setItem(key, on ? '1' : '0')
  } catch {
    // ignore storage failures (private mode, quota)
  }
}

export default function Spectate() {
  const { id } = useParams<{ id: string }>()
  const navigate = useNavigate()
  const { user } = useAuth()
  const isAdmin = user?.role === 'admin'
  const s = useSpectate()
  const g = s.game
  const [, force] = useState(0)

  // Admin-only engine overlay: an eval bar and a best-move arrow, each toggled
  // independently (like the Analysis board). We re-read the position at full
  // strength whenever the FEN changes — i.e. only when a move lands, not on every
  // clock tick — and convert the side-to-move eval to White's perspective.
  const [showEval, setShowEval] = useState(() => loadFlag(LS_EVAL))
  const [showArrow, setShowArrow] = useState(() => loadFlag(LS_ARROW))
  const engineOn = isAdmin && (showEval || showArrow)
  const [whiteEval, setWhiteEval] = useState<WhiteEval | null>(null)
  const [bestUci, setBestUci] = useState<string | null>(null)

  const fen = g?.fen
  const sideToMove = g?.sideToMove
  const over = g?.over
  useEffect(() => {
    if (!engineOn || !fen || over) {
      setBestUci(null)
      return
    }
    let cancelled = false
    const ctrl = new AbortController()
    analyze(fen, { movetime: 500, signal: ctrl.signal })
      .then((r) => {
        if (cancelled) return
        if (r.eval) {
          const white = sideToMove === 'w' ? r.eval.value : -r.eval.value
          setWhiteEval({ type: r.eval.type, white })
        }
        setBestUci(r.bestmove)
      })
      .catch(() => {}) // aborted / transient failure → keep last shown eval
    return () => {
      cancelled = true
      ctrl.abort()
    }
  }, [engineOn, fen, sideToMove, over])

  const arrow =
    isAdmin && showArrow && bestUci && !over
      ? { from: bestUci.slice(0, 2), to: bestUci.slice(2, 4) }
      : null

  // Open the spectator stream for this game; tear it down on leave.
  useEffect(() => {
    if (!id) return
    spectateSocket.open(id)
    return () => spectateSocket.close()
  }, [id])

  // Tick the clocks while the game is running.
  useEffect(() => {
    if (!g || g.over) return
    const t = window.setInterval(() => force((n) => n + 1), 200)
    return () => window.clearInterval(t)
  }, [g?.id, g?.over])

  // Sound: voice each new move as the position advances. A spectator isn't
  // playing, so we voice BOTH sides (unlike LiveGame, which only sounds the
  // opponent). Audio is already unlocked by the click that brought us here (the
  // global pointerdown unlock in lib/sounds). Baseline per game id so opening a
  // mid-game stream doesn't replay the whole history.
  const soundedPly = useRef<{ id: string; ply: number } | null>(null)
  useEffect(() => {
    if (!g) return
    const prev = soundedPly.current
    if (!prev || prev.id !== g.id) {
      soundedPly.current = { id: g.id, ply: g.moves.length } // baseline; don't replay
      return
    }
    if (g.moves.length > prev.ply) {
      soundedPly.current = { id: g.id, ply: g.moves.length }
      playForSan(g.moves[g.moves.length - 1].san, false)
    }
  }, [g?.id, g?.moves.length])

  // Sound: one game-over tone when the game ends (once per game).
  const endedSound = useRef<string | null>(null)
  useEffect(() => {
    if (g && g.over && endedSound.current !== g.id) {
      endedSound.current = g.id
      sounds.end()
    }
  }, [g?.id, g?.over])

  if (!g) {
    return (
      <Box sx={{ flex: 1, display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', gap: 2 }}>
        <Typography sx={{ color: 'var(--text-dim)' }}>
          {s.error ? 'This game is no longer available.' : 'Connecting to the game…'}
        </Typography>
        <Button variant="contained" onClick={() => navigate('/watch')}>
          Back to Watch
        </Button>
      </Box>
    )
  }

  // White is shown at the bottom (spectators always view from White's side).
  const moveEntries: MoveEntry[] = g.moves.map((m, i) => ({
    ply: i + 1,
    san: m.san,
    uci: m.uci,
    by: 'human',
    fen: '',
  }))

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
          gridTemplateColumns: { xs: '1fr', md: 'min(calc(100vh - 120px), calc(100vw - 392px), 880px) 320px' },
          columnGap: { md: 4 },
          rowGap: 2,
          alignItems: { xs: 'flex-start', md: 'stretch' },
          justifyContent: 'center',
          width: { xs: '100%', md: 'fit-content' },
          maxWidth: '100%',
          mx: 'auto',
        }}
      >
        <Box sx={{ minWidth: 0, alignSelf: 'start', width: '100%', display: 'flex', gap: 1, alignItems: 'stretch' }}>
          {isAdmin && showEval && <EvalBar ev={whiteEval} orientation="w" />}
          <Box sx={{ flex: 1, minWidth: 0 }}>
            <Board
              fen={g.fen}
              orientation="w"
              sideToMove={g.sideToMove}
              legalMoves={[]}
              lastMove={g.lastMove}
              inCheck={g.check}
              interactive={false}
              onMove={() => {}}
              arrow={arrow}
            />
          </Box>
        </Box>

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
            boxShadow: PANEL_SHADOW,
            alignSelf: { md: 'stretch' },
            width: '100%',
          }}
        >
          {/* Header: pool + rated + a live badge */}
          <Box
            sx={{
              display: 'flex',
              alignItems: 'center',
              gap: 1,
              px: 1.75,
              py: 1.25,
              bgcolor: 'var(--bg-2)',
              borderBottom: '1px solid var(--line-soft)',
            }}
          >
            <Typography sx={{ fontFamily: 'var(--font-mono)', fontSize: 12.5, color: 'var(--text-dim)' }}>{g.pool}</Typography>
            {!g.over && (
              <Box
                sx={{
                  display: 'flex',
                  alignItems: 'center',
                  gap: 0.5,
                  px: 0.9,
                  py: 0.2,
                  borderRadius: '6px',
                  fontSize: 10,
                  fontWeight: 700,
                  letterSpacing: '0.1em',
                  textTransform: 'uppercase',
                  color: '#7bb661',
                }}
              >
                <Box sx={{ width: 6, height: 6, borderRadius: '50%', bgcolor: '#7bb661' }} /> Live
              </Box>
            )}
            <Box
              sx={{
                ml: 'auto',
                px: 1,
                py: 0.3,
                borderRadius: '6px',
                fontSize: 10.5,
                fontWeight: 700,
                letterSpacing: '0.1em',
                textTransform: 'uppercase',
                border: '1px solid',
                color: g.rated ? 'var(--accent)' : 'var(--text-dim)',
                bgcolor: g.rated ? 'var(--accent-soft)' : 'transparent',
                borderColor: g.rated ? 'var(--accent-line)' : 'var(--line)',
              }}
            >
              {g.rated ? 'Rated' : 'Casual'}
            </Box>
          </Box>

          {/* Admin engine overlay controls */}
          {isAdmin && (
            <AdminControls
              showEval={showEval}
              showArrow={showArrow}
              onToggleEval={() => setShowEval((v) => { saveFlag(LS_EVAL, !v); return !v })}
              onToggleArrow={() => setShowArrow((v) => { saveFlag(LS_ARROW, !v); return !v })}
              bestSan={bestUci && !g.over ? bestMoveSan(g.fen, bestUci) : null}
              whiteEval={engineOn ? whiteEval : null}
            />
          )}

          {/* Black (top) */}
          <PlayerBar
            side={g.black}
            ms={spectateRemaining(g, 'b')}
            active={!g.over && g.sideToMove === 'b' && g.moves.length >= 2}
            divider="bottom"
          />

          <MoveList fill moves={moveEntries} currentPly={moveEntries.length} onSelectPly={() => {}} />

          {g.over ? (
            <Box
              sx={{
                p: 1.25,
                borderTop: '1px solid var(--line-soft)',
                bgcolor: 'var(--bg-2)',
                display: 'flex',
                flexDirection: 'column',
                gap: 1.25,
              }}
            >
              <Typography sx={{ fontFamily: 'var(--font-display)', fontSize: 18, fontWeight: 700, textAlign: 'center' }}>
                {resultText(g)}
              </Typography>
              <Button
                fullWidth
                variant="contained"
                startIcon={<ArrowLeft size={16} />}
                onClick={() => navigate('/watch')}
              >
                Back to Watch
              </Button>
            </Box>
          ) : (
            <Box sx={{ p: 1.25, borderTop: '1px solid var(--line-soft)', bgcolor: 'var(--bg-2)' }}>
              <Button
                fullWidth
                color="inherit"
                startIcon={<ArrowLeft size={15} />}
                onClick={() => navigate('/watch')}
                sx={{ color: 'var(--text-dim)', justifyContent: 'center' }}
              >
                Back to Watch
              </Button>
            </Box>
          )}

          {/* White (bottom) */}
          <PlayerBar
            side={g.white}
            ms={spectateRemaining(g, 'w')}
            active={!g.over && g.sideToMove === 'w' && g.moves.length >= 2}
            divider="top"
          />
        </Box>
      </Box>
    </Box>
  )
}

function PlayerBar({
  side,
  ms,
  active,
  divider,
}: {
  side: SpectateSide
  ms: number
  active: boolean
  divider?: 'top' | 'bottom'
}) {
  return (
    <Box
      sx={{
        display: 'flex',
        alignItems: 'center',
        gap: 1.25,
        px: 1.75,
        py: 1.25,
        bgcolor: 'var(--bg-2)',
        borderTop: divider === 'top' ? '1px solid var(--line-soft)' : undefined,
        borderBottom: divider === 'bottom' ? '1px solid var(--line-soft)' : undefined,
      }}
    >
      <Avatar small><User size={15} /></Avatar>
      <Box sx={{ minWidth: 0 }}>
        <Box sx={{ display: 'flex', alignItems: 'baseline', gap: 0.75 }}>
          <Typography sx={{ fontFamily: 'var(--font-display)', fontWeight: 700, fontSize: 14.5 }} noWrap>
            {side.name}
          </Typography>
          {!side.anon && (
            <Typography sx={{ fontFamily: 'var(--font-mono)', fontSize: 12, color: 'var(--text-dim)' }}>
              {side.rating}
            </Typography>
          )}
        </Box>
      </Box>
      <Box sx={{ ml: 'auto' }}>
        <Clock ms={ms} active={active} />
      </Box>
    </Box>
  )
}

// Render the engine's UCI best move ("e2e4") as SAN ("e4") for the readout.
function bestMoveSan(fen: string, uci: string): string {
  return pvToSan(fen, [uci])[0]?.san ?? uci
}

// Short eval from White's view: "+0.34", "-1.20", or "#3" / "-#2" for mate.
function evalText(ev: WhiteEval): string {
  if (ev.type === 'mate') return (ev.white < 0 ? '-' : '') + '#' + Math.abs(ev.white)
  const v = ev.white / 100
  return (v > 0 ? '+' : '') + v.toFixed(2)
}

// Admin-only control strip: two independent toggles (eval bar + best-move arrow)
// plus a compact readout of the current best move and eval.
function AdminControls({
  showEval,
  showArrow,
  onToggleEval,
  onToggleArrow,
  bestSan,
  whiteEval,
}: {
  showEval: boolean
  showArrow: boolean
  onToggleEval: () => void
  onToggleArrow: () => void
  bestSan: string | null
  whiteEval: WhiteEval | null
}) {
  return (
    <Box
      sx={{
        display: 'flex',
        alignItems: 'center',
        gap: 1.5,
        px: 1.75,
        py: 1,
        bgcolor: 'var(--bg-2)',
        borderBottom: '1px solid var(--line-soft)',
      }}
    >
      <AdminToggle label="Eval bar" icon={<Gauge size={14} />} on={showEval} onChange={onToggleEval} />
      <AdminToggle label="Best move" icon={<Target size={14} />} on={showArrow} onChange={onToggleArrow} />
      {(showEval || showArrow) && (bestSan || whiteEval) && (
        <Box sx={{ ml: 'auto', display: 'flex', alignItems: 'baseline', gap: 0.75, minWidth: 0, overflow: 'hidden' }}>
          {bestSan && (
            <Typography sx={{ fontFamily: 'var(--font-mono)', fontSize: 13.5, fontWeight: 700, color: 'var(--accent)' }} noWrap>
              {bestSan}
            </Typography>
          )}
          {whiteEval && (
            <Typography sx={{ fontFamily: 'var(--font-mono)', fontSize: 11.5, color: 'var(--text-dim)' }} noWrap>
              {evalText(whiteEval)}
            </Typography>
          )}
        </Box>
      )}
    </Box>
  )
}

function AdminToggle({
  label,
  icon,
  on,
  onChange,
}: {
  label: string
  icon: React.ReactNode
  on: boolean
  onChange: () => void
}) {
  return (
    <Tooltip title={`${label} (admin)`} placement="top">
      <Box sx={{ display: 'flex', alignItems: 'center', gap: 0.4 }}>
        <Box sx={{ display: 'flex', color: on ? 'var(--accent)' : 'var(--text-dim)' }}>{icon}</Box>
        <Typography sx={{ fontSize: 12, color: 'var(--text-dim)' }} noWrap>
          {label}
        </Typography>
        <Switch size="small" checked={on} onChange={onChange} />
      </Box>
    </Tooltip>
  )
}

function resultText(g: SpectateGame): string {
  if (g.reason === 'aborted' || g.status === 'aborted') return 'Game aborted'
  if (g.result === '1/2-1/2') return 'Draw'
  if (g.result === '1-0' || g.result === '0-1') {
    const who = g.result === '1-0' ? 'White' : 'Black'
    const how = reasonText(g.reason)
    return `${who} wins${how ? ` · ${how}` : ''}`
  }
  return 'Game over'
}

function reasonText(reason: string | null): string {
  switch (reason) {
    case 'resign':
      return 'resignation'
    case 'timeout':
      return 'on time'
    case 'abandon':
      return 'abandonment'
    case 'checkmate':
      return 'checkmate'
    default:
      return reason ?? ''
  }
}
