import { useEffect, useRef, useState } from 'react'
import { Box, Button, Typography } from '@mui/material'
import { Flag } from 'lucide-react'
import { useNavigate } from 'react-router-dom'
import Board from '../components/Board'
import Clock from '../components/Clock'
import MoveList from '../components/MoveList'
import type { MoveEntry } from '../api/client'
import { type Color, gameSocket, type LiveGameState, liveRemaining } from '../lib/socket'
import { useGameSocket } from '../lib/useGameSocket'
import { applyUciVisually, type BoardMap, parseFen } from '../lib/chess'
import { playForSan, sounds } from '../lib/sounds'

const other = (c: Color): Color => (c === 'w' ? 'b' : 'w')

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

  // Sound: play the newest move (either side) as the authoritative position
  // advances. Tracked per game id so resuming an in-progress game doesn't replay
  // its whole history. The SAN from the hub carries check/capture/promotion, so
  // playForSan picks the right knock.
  const soundedPly = useRef<{ id: string; ply: number } | null>(null)
  useEffect(() => {
    if (!g) return
    const prev = soundedPly.current
    if (!prev || prev.id !== g.id) {
      soundedPly.current = { id: g.id, ply: g.moves.length } // baseline; don't replay
      return
    }
    if (g.moves.length > prev.ply) {
      playForSan(g.moves[g.moves.length - 1].san, false)
      soundedPly.current = { id: g.id, ply: g.moves.length }
    }
  }, [g?.id, g?.moves.length])

  // Sound: one game-over tone when the game ends (once per game).
  const endedSound = useRef<string | null>(null)
  useEffect(() => {
    if (g && g.ended && endedSound.current !== g.id) {
      endedSound.current = g.id
      sounds.end()
    }
  }, [g?.id, g?.ended])

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
    setOverride(applyUciVisually(parseFen(g.fen), uci))
    setOptimisticLast({ from: uci.slice(0, 2), to: uci.slice(2, 4) })
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
          gridTemplateColumns: { xs: '1fr', md: 'min(calc(100vh - 140px), calc(100vw - 380px), 760px) 300px' },
          columnGap: { md: 4 },
          rowGap: 2,
          alignItems: 'center',
          width: '100%',
          maxWidth: 1120,
        }}
      >
        <Box sx={{ minWidth: 0 }}>
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
            bgcolor: '#1b1e24',
            border: '1px solid var(--line)',
            borderRadius: 2.5,
            overflow: 'hidden',
            alignSelf: { md: 'center' },
          }}
        >
          <PlayerBar
            name={g.opponent.name}
            rating={g.opponent.anon ? null : g.opponent.rating}
            ms={liveRemaining(g, other(g.color))}
            active={!g.ended && g.sideToMove === other(g.color)}
            online={g.opponentOnline}
          />

          {s.conn !== 'open' && !g.ended && (
            <Box sx={{ px: 1.75, py: 0.75, bgcolor: 'var(--accent-soft)', borderBottom: '1px solid var(--accent-line)' }}>
              <Typography sx={{ fontSize: 12.5, color: 'var(--accent)', fontFamily: 'var(--font-mono)' }}>
                Reconnecting…
              </Typography>
            </Box>
          )}

          <MoveList moves={moveEntries} currentPly={moveEntries.length} onSelectPly={() => {}} />

          {!g.ended ? (
            <Box sx={{ display: 'flex', justifyContent: 'center', py: 0.75, borderTop: '1px solid var(--line-soft)' }}>
              <Button
                size="small"
                color="inherit"
                startIcon={<Flag size={14} />}
                onClick={() => gameSocket.resign()}
                sx={{ color: 'var(--text-dim)', '&:hover': { color: '#ca4a4a' } }}
              >
                Resign
              </Button>
            </Box>
          ) : (
            <Box sx={{ p: 1.5, borderTop: '1px solid var(--line-soft)', display: 'flex', flexDirection: 'column', gap: 1 }}>
              <Typography sx={{ fontFamily: 'var(--font-display)', fontSize: 18, fontWeight: 600, textAlign: 'center' }}>
                {resultText(g)}
              </Typography>
              <Box sx={{ display: 'flex', gap: 1 }}>
                <Button fullWidth variant="outlined" color="inherit" onClick={() => { gameSocket.leave(); navigate('/') }}>
                  Lobby
                </Button>
                <Button fullWidth variant="contained" onClick={() => { gameSocket.leave(); navigate('/') }}>
                  New game
                </Button>
              </Box>
            </Box>
          )}

          <PlayerBar
            name="You"
            rating={null}
            ms={liveRemaining(g, g.color)}
            active={myTurn}
          />
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
}: {
  name: string
  rating: number | null
  ms: number
  active: boolean
  online?: boolean
}) {
  return (
    <Box
      sx={{
        display: 'flex',
        alignItems: 'center',
        gap: 1,
        px: 1.75,
        py: 1.25,
        bgcolor: '#23272f',
      }}
    >
      <Box
        sx={{
          width: 8,
          height: 8,
          borderRadius: '50%',
          flexShrink: 0,
          background: online === false ? 'var(--muted)' : '#7bb661',
        }}
      />
      <Typography sx={{ fontWeight: 600, fontSize: 14.5 }}>{name}</Typography>
      {rating != null && (
        <Typography sx={{ fontFamily: 'var(--font-mono)', fontSize: 12, color: 'var(--text-dim)' }}>
          {rating}
        </Typography>
      )}
      {online === false && (
        <Typography sx={{ fontSize: 11.5, color: 'var(--muted)' }}>disconnected</Typography>
      )}
      <Box sx={{ ml: 'auto' }}>
        <Clock ms={ms} active={active} />
      </Box>
    </Box>
  )
}

function resultText(g: LiveGameState): string {
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
