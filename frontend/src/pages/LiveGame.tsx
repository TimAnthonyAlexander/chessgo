import { useEffect, useRef, useState } from 'react'
import { Box, Button, Typography } from '@mui/material'
import { Flag, Telescope, User } from 'lucide-react'
import { useNavigate } from 'react-router-dom'
import Board from '../components/Board'
import Clock from '../components/Clock'
import LiveModeCard from '../components/LiveModeCard'
import MoveList from '../components/MoveList'
import { ActionBtn, Avatar, PANEL_SHADOW } from '../components/PanelUI'
import type { MoveEntry } from '../api/client'
import { type Color, gameSocket, type LiveGameState, liveRemaining } from '../lib/socket'
import { useGameSocket } from '../lib/useGameSocket'
import { applyUciVisually, type BoardMap, fileOf, parseFen } from '../lib/chess'
import { playForSan, sounds } from '../lib/sounds'
import { authStore } from '../lib/auth'

const other = (c: Color): Color => (c === 'w' ? 'b' : 'w')

// Per-time-control "low time" threshold: ~1/10 of the base clock, clamped to a
// sane 8s–60s window (bullet warns late, classical not absurdly early).
function lowTimeThreshold(baseMs: number): number {
  return Math.min(60_000, Math.max(8_000, baseMs / 10))
}

// Fire the low-time cue once when our own clock crosses the threshold; re-arm if
// an increment lifts us back above it. Reads the latest game via a ref (the
// authoritative clock advances outside React) and checks on a light interval.
function useLowTimeWarning(g: LiveGameState | null): void {
  const armed = useRef(true)
  const gRef = useRef(g)
  gRef.current = g
  useEffect(() => {
    armed.current = true
  }, [g?.id])
  useEffect(() => {
    if (!g || g.ended) return
    const id = window.setInterval(() => {
      const cur = gRef.current
      if (!cur || cur.ended || !cur.timeControl || cur.moves.length < 2) return
      const thr = lowTimeThreshold(cur.timeControl.base)
      const rem = liveRemaining(cur, cur.color)
      if (rem <= thr && armed.current) {
        armed.current = false
        sounds.lowTime()
      } else if (rem > thr + 2_000) {
        armed.current = true
      }
    }, 250)
    return () => window.clearInterval(id)
  }, [g?.id, g?.ended])
}

export default function LiveGame() {
  const navigate = useNavigate()
  const s = useGameSocket()
  const g = s.game

  const [override, setOverride] = useState<BoardMap | null>(null)
  const [optimisticLast, setOptimisticLast] = useState<{ from: string; to: string } | null>(null)
  const [, force] = useState(0)

  // Tick for live clock countdown while a game is running.
  useEffect(() => {
    if (!g || g.ended) return
    const id = window.setInterval(() => force((n) => n + 1), 200)
    return () => window.clearInterval(id)
  }, [g?.id, g?.ended])

  // Clear optimistic state whenever the authoritative position advances.
  useEffect(() => {
    setOverride(null)
    setOptimisticLast(null)
  }, [g?.fen])

  // Sound: voice the OPPONENT's newest move as the position advances. Our own
  // move is played synchronously in onMove (inside the click gesture) — both for
  // instant feedback and, crucially, to create/resume the AudioContext within a
  // user gesture (browsers keep it suspended otherwise, so a purely
  // state-message-driven sound never plays). Tracked per game id so resuming
  // doesn't replay history. The mover is the side NOT to move now.
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
      if (other(g.sideToMove) !== g.color) playForSan(g.moves[g.moves.length - 1].san, false)
    }
  }, [g?.id, g?.moves.length])

  // Sound: warn once when our own clock enters "low time" (threshold scales with
  // the time control). Re-arms if we climb back above it via increment.
  useLowTimeWarning(g)

  // Sound: one game-over tone when the game ends (once per game).
  const endedSound = useRef<string | null>(null)
  useEffect(() => {
    if (g && g.ended && endedSound.current !== g.id) {
      endedSound.current = g.id
      sounds.end()
    }
  }, [g?.id, g?.ended])

  // A rated game changes the player's rating server-side; refresh the cached
  // user (once per game) so the navbar rating isn't stale.
  const ratedRefresh = useRef<string | null>(null)
  useEffect(() => {
    if (g && g.ended && g.rated && ratedRefresh.current !== g.id) {
      ratedRefresh.current = g.id
      void authStore.refresh()
    }
  }, [g?.id, g?.ended, g?.rated])

  if (!g) {
    return (
      <Box sx={{ flex: 1, display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', gap: 2 }}>
        <Typography sx={{ color: 'var(--text-dim)' }}>No active game.</Typography>
        <Button variant="contained" onClick={() => navigate('/')}>
          Back to lobby
        </Button>
      </Box>
    )
  }

  const myTurn = !g.ended && g.sideToMove === g.color && s.conn === 'open'

  function onMove(uci: string) {
    if (!g) return
    const before = parseFen(g.fen)
    setOverride(applyUciVisually(before, uci))
    setOptimisticLast({ from: uci.slice(0, 2), to: uci.slice(2, 4) })
    playHumanSound(before, uci) // synchronous: instant feedback + unlocks audio within the gesture
    gameSocket.move(uci)
  }

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
          // A left spacer column mirrors the 320px sidebar so the BOARD itself
          // (not the board+sidebar block) is centered in the viewport.
          gridTemplateColumns: {
            xs: '1fr',
            md: '320px min(calc(100vh - 120px), calc(100vw - 752px), 880px) 320px',
          },
          columnGap: { md: 4 },
          rowGap: 2,
          alignItems: { xs: 'flex-start', md: 'stretch' },
          justifyContent: 'center',
          width: { xs: '100%', md: 'fit-content' },
          maxWidth: '100%',
          mx: 'auto',
        }}
      >
        <Box sx={{ display: { xs: 'none', md: 'block' }, width: '100%', justifySelf: 'end', alignSelf: 'start' }}>
          <LiveModeCard pool={g.pool} rated={g.rated} color={g.color} opponent={g.opponent} />
        </Box>
        <Box sx={{ minWidth: 0, alignSelf: 'start', width: '100%' }}>
          <Board
            fen={g.fen}
            orientation={g.color}
            sideToMove={g.sideToMove}
            legalMoves={myTurn ? g.legalMoves : []}
            lastMove={optimisticLast ?? g.lastMove}
            inCheck={g.check}
            interactive={myTurn}
            onMove={onMove}
            {...(override ? { overrideBoard: override } : {})}
          />
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
          {/* Pool + rated badge */}
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

          {/* Opponent */}
          <PlayerBar
            name={g.opponent.name}
            rating={g.opponent.anon ? null : g.opponent.rating}
            ms={liveRemaining(g, other(g.color))}
            active={!g.ended && g.sideToMove === other(g.color)}
            online={g.opponentOnline}
            divider="bottom"
          />

          {s.conn !== 'open' && !g.ended && (
            <Box sx={{ px: 1.75, py: 0.75, bgcolor: 'var(--accent-soft)', borderBottom: '1px solid var(--accent-line)' }}>
              <Typography sx={{ fontSize: 12.5, color: 'var(--accent)', fontFamily: 'var(--font-mono)' }}>
                Reconnecting…
              </Typography>
            </Box>
          )}

          {/* Moves (fills the panel) */}
          <MoveList fill moves={moveEntries} currentPly={moveEntries.length} onSelectPly={() => {}} />

          {/* Resign while playing, or the result + next actions when over */}
          {!g.ended ? (
            <Box sx={{ p: 1.25, borderTop: '1px solid var(--line-soft)', bgcolor: 'var(--bg-2)' }}>
              <ActionBtn tone="danger" icon={<Flag size={15} />} label="Resign" onClick={() => gameSocket.resign()} />
            </Box>
          ) : (
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
              <Box sx={{ display: 'flex', gap: 1 }}>
                <ActionBtn tone="neutral" label="Lobby" onClick={() => { gameSocket.leave(); navigate('/') }} />
                <ActionBtn tone="primary" label="New game" onClick={() => { gameSocket.queue(g.pool); navigate('/') }} />
              </Box>
              {g.reason !== 'aborted' && g.status !== 'aborted' && (
                <ActionBtn
                  tone="neutral"
                  icon={<Telescope size={16} />}
                  label="Analyse game"
                  onClick={() => navigate(`/analysis/${g.id}`)}
                />
              )}
            </Box>
          )}

          {/* You */}
          <PlayerBar name="You" rating={null} ms={liveRemaining(g, g.color)} active={myTurn} divider="top" />
        </Box>
      </Box>
    </Box>
  )
}

function PlayerBar({
  name,
  rating,
  ms,
  active,
  online,
  divider,
}: {
  name: string
  rating: number | null
  ms: number
  active: boolean
  online?: boolean
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
            {name}
          </Typography>
          {rating != null && (
            <Typography sx={{ fontFamily: 'var(--font-mono)', fontSize: 12, color: 'var(--text-dim)' }}>{rating}</Typography>
          )}
        </Box>
        {online === false && <Typography sx={{ fontSize: 11, color: 'var(--muted)', lineHeight: 1.1 }}>disconnected</Typography>}
      </Box>
      <Box sx={{ ml: 'auto' }}>
        <Clock ms={ms} active={active} />
      </Box>
    </Box>
  )
}

/** Pick + play the sound for the local player's own move (called synchronously
 * inside the click gesture, mirroring BotGame, so the AudioContext unlocks). */
function playHumanSound(board: BoardMap, uci: string) {
  const from = uci.slice(0, 2)
  const to = uci.slice(2, 4)
  const piece = board[from]?.toLowerCase()
  if (uci.length === 5) sounds.promote()
  else if (piece === 'k' && Math.abs(fileOf(to) - fileOf(from)) === 2) sounds.castle()
  else if (board[to] || (piece === 'p' && from[0] !== to[0])) sounds.capture()
  else sounds.move()
}

function resultText(g: LiveGameState): string {
  if (g.reason === 'aborted' || g.status === 'aborted') return 'Game aborted'
  if (g.status === 'disconnected') return 'Disconnected'
  if (g.result === '1/2-1/2') return 'Draw'
  if (g.result === '1-0' || g.result === '0-1') {
    const winner: Color = g.result === '1-0' ? 'w' : 'b'
    const won = winner === g.color
    const how = reasonText(g.reason)
    return `${won ? 'You won' : 'You lost'}${how ? ` · ${how}` : ''}`
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
