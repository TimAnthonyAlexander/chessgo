import { Box, Typography } from '@mui/material'
import type { LucideIcon } from 'lucide-react'
import { ChevronRight, Eye, Swords, Target } from 'lucide-react'
import { useNavigate } from 'react-router-dom'
import { useAuth } from '../../lib/auth'
import { useGameSocket } from '../../lib/useGameSocket'

interface Tile {
  key: string
  title: string
  sub: string
  Icon: LucideIcon
  onClick: () => void
  accent: boolean
}

/** "Jump back in" strip for logged-in users: an optional resume-game tile
 * (priority, accent-highlighted) plus quick links to puzzles and watching.
 * Renders nothing for anonymous visitors. Self-contained, no props. */
export default function ResumeTiles() {
  const { user } = useAuth()
  const { game } = useGameSocket()
  const navigate = useNavigate()

  if (!user) return null

  const tiles: Tile[] = []

  if (game && !game.ended) {
    tiles.push({
      key: 'resume',
      title: 'Resume game',
      sub: `vs ${game.opponent.name} · ${game.pool}`,
      Icon: Swords,
      onClick: () => navigate(`/game/${game.id}`),
      accent: true,
    })
  }

  tiles.push({
    key: 'puzzles',
    title: 'Puzzle training',
    sub: 'Sharpen your tactics',
    Icon: Target,
    onClick: () => navigate('/puzzles'),
    accent: false,
  })

  tiles.push({
    key: 'watch',
    title: 'Watch live',
    sub: 'Top games in play',
    Icon: Eye,
    onClick: () => navigate('/watch'),
    accent: false,
  })

  return (
    <Box
      sx={{
        display: 'grid',
        gap: 1.25,
        gridTemplateColumns: { xs: '1fr', sm: 'repeat(auto-fit, minmax(220px, 1fr))' },
      }}
    >
      {tiles.map(({ key, title, sub, Icon, onClick, accent }) => (
        <Box
          key={key}
          role="button"
          onClick={onClick}
          sx={{
            cursor: 'pointer',
            display: 'flex',
            alignItems: 'center',
            gap: 1.5,
            bgcolor: 'var(--surface)',
            border: '1px solid',
            borderColor: accent ? 'var(--accent-line)' : 'var(--line-soft)',
            borderRadius: '14px',
            p: 1.75,
            boxShadow: accent ? '0 0 0 1px var(--accent-soft), 0 18px 50px -30px var(--accent)' : 'none',
            transition: 'transform 120ms ease, border-color 120ms ease',
            '&:hover': {
              transform: 'translateY(-2px)',
              borderColor: 'var(--accent-line)',
            },
            '&:hover .resume-chevron': {
              transform: 'translateX(3px)',
            },
          }}
        >
          <Box
            sx={{
              flexShrink: 0,
              width: 46,
              height: 46,
              borderRadius: '12px',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              bgcolor: 'var(--surface-2)',
              border: '1px solid var(--line)',
              color: accent ? 'var(--accent)' : 'var(--text-dim)',
            }}
          >
            <Icon size={20} />
          </Box>

          <Box sx={{ minWidth: 0, flex: 1 }}>
            <Typography
              sx={{
                fontFamily: 'var(--font-display)',
                fontSize: 18,
                fontWeight: 600,
                color: 'var(--text)',
                lineHeight: 1.15,
                whiteSpace: 'nowrap',
                overflow: 'hidden',
                textOverflow: 'ellipsis',
              }}
            >
              {title}
            </Typography>
            <Typography
              sx={{
                fontSize: 13,
                color: 'var(--muted)',
                whiteSpace: 'nowrap',
                overflow: 'hidden',
                textOverflow: 'ellipsis',
              }}
            >
              {sub}
            </Typography>
          </Box>

          <Box
            className="resume-chevron"
            sx={{
              flexShrink: 0,
              display: 'flex',
              color: 'var(--text-dim)',
              transition: 'transform 120ms ease',
            }}
          >
            <ChevronRight size={18} />
          </Box>
        </Box>
      ))}
    </Box>
  )
}
