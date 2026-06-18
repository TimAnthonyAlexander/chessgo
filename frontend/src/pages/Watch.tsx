import { useEffect, useRef, useState } from 'react'
import { Box, Typography } from '@mui/material'
import { Eye, Radio } from 'lucide-react'
import { useNavigate } from 'react-router-dom'
import MiniBoard from '../components/MiniBoard'
import { getLiveGames, type LiveGameSummary, type LiveSide } from '../api/client'

const POLL_MS = 2500

export default function Watch() {
  const navigate = useNavigate()
  const [games, setGames] = useState<LiveGameSummary[] | null>(null)
  const [max, setMax] = useState(5)
  const loadedOnce = useRef(false)

  // Poll the lobby. The request itself signals the hub that someone is watching,
  // which is what spins up the self-play filler games (so the first poll may come
  // back sparse, then fill in over the next second or two).
  useEffect(() => {
    let cancelled = false
    const tick = () => {
      getLiveGames()
        .then((r) => {
          if (cancelled) return
          loadedOnce.current = true
          setGames(r.games)
          setMax(r.max)
        })
        .catch(() => {})
    }
    tick()
    const id = window.setInterval(tick, POLL_MS)
    return () => { cancelled = true; window.clearInterval(id) }
  }, [])

  const empty = loadedOnce.current && games != null && games.length === 0

  return (
    <Box sx={{ position: 'relative', flex: 1, overflow: 'hidden' }}>
      <Box
        aria-hidden
        sx={{
          position: 'absolute',
          inset: 0,
          pointerEvents: 'none',
          background: 'radial-gradient(ellipse 70% 50% at 50% -8%, rgba(216,166,87,0.08), transparent 62%)',
        }}
      />
      <Box sx={{ position: 'relative', maxWidth: 1200, mx: 'auto', px: { xs: 2, md: 3 }, py: { xs: 3, md: 5 } }}>
        {/* Header */}
        <Box sx={{ mb: { xs: 3, md: 4 } }}>
          <Box sx={{ display: 'flex', alignItems: 'center', gap: 1, mb: 1.25 }}>
            <Box sx={{ display: 'flex', color: 'var(--accent)' }}>
              <Radio size={15} />
            </Box>
            <Typography
              sx={{
                fontFamily: 'var(--font-mono)',
                fontSize: 12,
                letterSpacing: '0.2em',
                textTransform: 'uppercase',
                color: 'var(--accent)',
              }}
            >
              Live now
            </Typography>
          </Box>
          <Typography
            sx={{
              fontFamily: 'var(--font-display)',
              fontWeight: 700,
              fontSize: { xs: 30, md: 40 },
              lineHeight: 1.05,
              letterSpacing: '-0.02em',
            }}
          >
            Watch
          </Typography>
          <Typography sx={{ mt: 1, fontSize: { xs: 14, md: 15 }, color: 'var(--text-dim)', maxWidth: 560 }}>
            The {max} most notable games in play right now. Click any board to spectate live, move by move.
          </Typography>
        </Box>

        {/* Grid */}
        {games == null ? (
          <Placeholder text="Loading live games…" />
        ) : empty ? (
          <Placeholder text="No live games at the moment — hang on a sec while a few get going." />
        ) : (
          <Box
            sx={{
              display: 'grid',
              gridTemplateColumns: { xs: '1fr', sm: 'repeat(2, 1fr)', lg: 'repeat(3, 1fr)' },
              gap: { xs: 2, md: 2.5 },
            }}
          >
            {games.map((g) => (
              <GameCard key={g.id} game={g} onClick={() => navigate(`/watch/${g.id}`)} />
            ))}
          </Box>
        )}
      </Box>
    </Box>
  )
}

function Placeholder({ text }: { text: string }) {
  return (
    <Box
      sx={{
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        minHeight: 200,
        borderRadius: '16px',
        border: '1px dashed var(--line)',
        color: 'var(--muted)',
        textAlign: 'center',
        px: 3,
      }}
    >
      <Typography sx={{ fontSize: 14 }}>{text}</Typography>
    </Box>
  )
}

function GameCard({ game, onClick }: { game: LiveGameSummary; onClick: () => void }) {
  const whiteActive = game.sideToMove === 'w' && game.ply >= 2
  const blackActive = game.sideToMove === 'b' && game.ply >= 2
  return (
    <Box
      onClick={onClick}
      sx={{
        position: 'relative',
        bgcolor: 'var(--surface)',
        border: '1px solid var(--line-soft)',
        borderRadius: '16px',
        p: 1.5,
        cursor: 'pointer',
        boxShadow: '0 18px 50px -30px rgba(0,0,0,0.8)',
        transition: 'transform .12s ease, border-color .12s ease',
        '&:hover': { transform: 'translateY(-2px)', borderColor: 'var(--accent-line)' },
        '&:hover .watch-cta': { opacity: 1 },
      }}
    >
      <PlayerRow side={game.black} ms={game.clockB} active={blackActive} />
      <Box sx={{ position: 'relative', my: 0.75 }}>
        <MiniBoard fen={game.fen} lastMove={game.lastMove} />
        <Box
          className="watch-cta"
          sx={{
            position: 'absolute',
            inset: 0,
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            opacity: 0,
            transition: 'opacity .12s ease',
            background: 'rgba(10,11,14,0.32)',
            borderRadius: '8px',
            pointerEvents: 'none',
          }}
        >
          <Box
            sx={{
              display: 'flex',
              alignItems: 'center',
              gap: 0.75,
              px: 1.5,
              py: 0.75,
              borderRadius: '999px',
              bgcolor: 'var(--accent)',
              color: '#15171c',
              fontFamily: 'var(--font-display)',
              fontWeight: 700,
              fontSize: 12.5,
            }}
          >
            <Eye size={14} /> Spectate
          </Box>
        </Box>
      </Box>
      <PlayerRow side={game.white} ms={game.clockW} active={whiteActive} />

      <Box sx={{ display: 'flex', alignItems: 'center', gap: 1, mt: 1, px: 0.25 }}>
        <Typography sx={{ fontFamily: 'var(--font-mono)', fontSize: 11.5, color: 'var(--text-dim)' }}>{game.pool}</Typography>
        <Typography
          sx={{
            ml: 'auto',
            fontSize: 9.5,
            fontWeight: 700,
            letterSpacing: '0.1em',
            textTransform: 'uppercase',
            color: game.rated ? 'var(--accent)' : 'var(--muted)',
          }}
        >
          {game.rated ? 'Rated' : 'Casual'}
        </Typography>
      </Box>
    </Box>
  )
}

function PlayerRow({ side, ms, active }: { side: LiveSide; ms: number; active: boolean }) {
  return (
    <Box sx={{ display: 'flex', alignItems: 'center', gap: 1, px: 0.5, py: 0.25 }}>
      <Typography sx={{ fontFamily: 'var(--font-display)', fontWeight: 600, fontSize: 13.5 }} noWrap>
        {side.name}
      </Typography>
      {!side.anon && (
        <Typography sx={{ fontFamily: 'var(--font-mono)', fontSize: 11.5, color: 'var(--text-dim)' }}>
          {side.rating}
        </Typography>
      )}
      <Box
        sx={{
          ml: 'auto',
          fontFamily: 'var(--font-mono)',
          fontSize: 13,
          fontWeight: 600,
          px: 0.9,
          py: 0.2,
          borderRadius: '6px',
          color: active ? 'var(--text)' : 'var(--text-dim)',
          bgcolor: active ? 'var(--surface-2)' : 'transparent',
          border: '1px solid',
          borderColor: active ? 'var(--accent-line)' : 'transparent',
        }}
      >
        {formatClock(ms)}
      </Box>
    </Box>
  )
}

function formatClock(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000))
  const mins = Math.floor(total / 60)
  const secs = total - mins * 60
  return `${mins}:${secs.toString().padStart(2, '0')}`
}
