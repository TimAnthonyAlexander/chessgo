import { useEffect, useState } from 'react'
import { Box, Typography } from '@mui/material'
import { useNavigate } from 'react-router-dom'
import { Panel, PanelHead } from './Panel'
import MiniBoard from '../MiniBoard'
import { getLiveGames, type LiveGameSummary, type LiveSide } from '../../api/client'
import { categoryFor, CATEGORY_META } from '../../lib/timeControl'

const POLL_MS = 6000
const STATUS_GREEN = '#7bb661'

/** mm:ss from a millisecond clock value (clamped at zero). */
function formatClock(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000))
  const mm = Math.floor(total / 60)
  const ss = total % 60
  return `${mm}:${String(ss).padStart(2, '0')}`
}

/** One player strip (name + rating on the left, clock on the right). The side
 * to move gets a subtle accent dot before the name. */
function PlayerStrip({ side, clockMs, toMove }: { side: LiveSide; clockMs: number; toMove: boolean }) {
  return (
    <Box
      sx={{
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'space-between',
        gap: 1,
        px: 1,
        py: 0.75,
      }}
    >
      <Box sx={{ display: 'flex', alignItems: 'center', gap: 0.75, minWidth: 0 }}>
        <Box
          sx={{
            width: 7,
            height: 7,
            borderRadius: '50%',
            flexShrink: 0,
            bgcolor: toMove ? 'var(--accent)' : 'var(--line)',
          }}
        />
        <Typography
          sx={{
            fontSize: 14,
            fontWeight: 600,
            color: 'var(--text)',
            overflow: 'hidden',
            textOverflow: 'ellipsis',
            whiteSpace: 'nowrap',
          }}
        >
          {side.anon ? 'Anonymous' : side.name}
        </Typography>
        <Typography sx={{ fontFamily: 'var(--font-mono)', fontSize: 12, color: 'var(--muted)', flexShrink: 0 }}>
          {side.rating}
        </Typography>
      </Box>
      <Typography
        sx={{
          fontFamily: 'var(--font-mono)',
          fontSize: 15,
          fontWeight: 600,
          color: toMove ? 'var(--text)' : 'var(--text-dim)',
          flexShrink: 0,
        }}
      >
        {formatClock(clockMs)}
      </Typography>
    </Box>
  )
}

/** Homepage "featured live game" TV widget: polls the Watch lobby and shows the
 * single top game with an auto-updating preview board. Click → /watch. */
export default function LiveTvWidget() {
  const navigate = useNavigate()
  const [game, setGame] = useState<LiveGameSummary | null>(null)
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    let alive = true
    const poll = async () => {
      try {
        const res = await getLiveGames()
        if (!alive) return
        setGame(res.games[0] ?? null)
      } catch {
        // keep the last value on transient errors
      } finally {
        if (alive) setLoading(false)
      }
    }
    void poll()
    const id = window.setInterval(() => void poll(), POLL_MS)
    return () => {
      alive = false
      window.clearInterval(id)
    }
  }, [])

  const head = (
    <PanelHead
      title="Live now"
      sub="Top game in play"
      action={
        <Box sx={{ display: 'flex', alignItems: 'center', gap: 0.75 }}>
          <Box
            sx={{
              width: 9,
              height: 9,
              borderRadius: '50%',
              bgcolor: STATUS_GREEN,
              boxShadow: `0 0 0 0 ${STATUS_GREEN}`,
              animation: 'liveTvPulse 1.8s ease-out infinite',
              '@keyframes liveTvPulse': {
                '0%': { boxShadow: `0 0 0 0 ${STATUS_GREEN}66` },
                '70%': { boxShadow: `0 0 0 6px ${STATUS_GREEN}00` },
                '100%': { boxShadow: `0 0 0 0 ${STATUS_GREEN}00` },
              },
            }}
          />
          <Typography
            sx={{ fontFamily: 'var(--font-mono)', fontSize: 11, letterSpacing: 1, color: STATUS_GREEN, fontWeight: 700 }}
          >
            LIVE
          </Typography>
        </Box>
      }
    />
  )

  if (loading && !game) {
    return (
      <Panel>
        {head}
        <Typography sx={{ fontSize: 13, color: 'var(--muted)', textAlign: 'center', py: 6 }}>Loading…</Typography>
      </Panel>
    )
  }

  if (!game) {
    return (
      <Panel>
        {head}
        <Typography sx={{ fontSize: 13, color: 'var(--muted)', textAlign: 'center', py: 6 }}>
          No live games right now
        </Typography>
      </Panel>
    )
  }

  const cat = categoryFor(game.pool)
  const { Icon } = CATEGORY_META[cat]

  return (
    <Panel
      sx={{
        cursor: 'pointer',
        transition: 'transform 0.15s ease, border-color 0.15s ease',
        '&:hover': { transform: 'translateY(-2px)', borderColor: 'var(--accent-line)' },
      }}
    >
      <Box
        role="link"
        tabIndex={0}
        onClick={() => navigate('/watch')}
        onKeyDown={(e) => {
          if (e.key === 'Enter' || e.key === ' ') navigate('/watch')
        }}
        sx={{ outline: 'none' }}
      >
        {head}
        <Box sx={{ display: 'flex', alignItems: 'center', gap: 0.75, mb: 1, color: 'var(--text-dim)' }}>
          <Icon size={14} />
          <Typography sx={{ fontFamily: 'var(--font-mono)', fontSize: 11, letterSpacing: 0.5, fontWeight: 600 }}>
            {cat.toUpperCase()} · {game.pool}
          </Typography>
        </Box>
        <Box
          sx={{
            border: '1px solid var(--line-soft)',
            borderRadius: '10px',
            overflow: 'hidden',
            bgcolor: 'var(--surface-2)',
          }}
        >
          <PlayerStrip side={game.black} clockMs={game.clockB} toMove={game.sideToMove === 'b'} />
          <MiniBoard fen={game.fen} lastMove={game.lastMove || undefined} orientation="w" />
          <PlayerStrip side={game.white} clockMs={game.clockW} toMove={game.sideToMove === 'w'} />
        </Box>
      </Box>
    </Panel>
  )
}
