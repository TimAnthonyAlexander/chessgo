import { useEffect, useRef, useState } from 'react'
import { Box, Button, Typography } from '@mui/material'
import { ArrowLeft, User } from 'lucide-react'
import { useNavigate, useParams } from 'react-router-dom'
import Board from '../components/Board'
import Clock from '../components/Clock'
import MoveList from '../components/MoveList'
import { Avatar, PANEL_SHADOW } from '../components/PanelUI'
import type { MoveEntry } from '../api/client'
import { type SpectateGame, type SpectateSide, spectateRemaining, spectateSocket } from '../lib/spectate'
import { useSpectate } from '../lib/useSpectate'
import { playForSan, sounds } from '../lib/sounds'

export default function Spectate() {
  const { id } = useParams<{ id: string }>()
  const navigate = useNavigate()
  const s = useSpectate()
  const g = s.game
  const [, force] = useState(0)

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
        <Box sx={{ minWidth: 0, alignSelf: 'start', width: '100%' }}>
          <Board
            fen={g.fen}
            orientation="w"
            sideToMove={g.sideToMove}
            legalMoves={[]}
            lastMove={g.lastMove}
            inCheck={g.check}
            interactive={false}
            onMove={() => {}}
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
