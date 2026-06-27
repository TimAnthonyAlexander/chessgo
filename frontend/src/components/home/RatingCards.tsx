import { Box, Typography } from '@mui/material'
import { useNavigate } from 'react-router-dom'
import { useAuth } from '../../lib/auth'
import { CATEGORY_META, type Category } from '../../lib/timeControl'
import type { User } from '../../api/client'

// The four time-control categories, paired with the lowercase keys the User
// model uses for its `rating_*` / `games_*` fields and `provisional` map.
const CATEGORIES: { label: Category; key: 'bullet' | 'blitz' | 'rapid' | 'classical' }[] = [
  { label: 'Bullet', key: 'bullet' },
  { label: 'Blitz', key: 'blitz' },
  { label: 'Rapid', key: 'rapid' },
  { label: 'Classical', key: 'classical' },
]

function ratingFor(user: User, key: 'bullet' | 'blitz' | 'rapid' | 'classical'): number {
  return user[`rating_${key}` as const]
}

function gamesFor(user: User, key: 'bullet' | 'blitz' | 'rapid' | 'classical'): number {
  return user[`games_${key}` as const]
}

/** Logged-in personalization: a compact grid of the user's four time-control
 * ratings. Renders nothing for anonymous visitors (no `user`) or before the
 * session has resolved (`status !== 'ready'`). Self-contained, no props. */
export default function RatingCards() {
  const { user, status } = useAuth()
  const navigate = useNavigate()

  if (!user || status !== 'ready') return null

  const goProfile = () => navigate(`/@/${user.name}`)

  return (
    <Box
      sx={{
        display: 'grid',
        gap: 1.25,
        gridTemplateColumns: { xs: 'repeat(2, 1fr)', sm: 'repeat(4, 1fr)' },
      }}
    >
      {CATEGORIES.map(({ label, key }) => {
        const { color, Icon } = CATEGORY_META[label]
        const rating = ratingFor(user, key)
        const games = gamesFor(user, key)
        const provisional = Boolean(user.provisional[key])

        return (
          <Box
            key={key}
            role="button"
            onClick={goProfile}
            sx={{
              cursor: 'pointer',
              bgcolor: 'var(--surface)',
              border: '1px solid var(--line-soft)',
              borderRadius: '12px',
              p: 1.5,
              transition: 'transform 120ms ease, border-color 120ms ease',
              '&:hover': {
                transform: 'translateY(-2px)',
                borderColor: 'var(--accent-line)',
              },
            }}
          >
            <Box sx={{ display: 'flex', alignItems: 'center', gap: 0.75, color }}>
              <Icon size={15} />
              <Typography
                sx={{
                  fontFamily: 'var(--font-mono)',
                  fontSize: 10,
                  letterSpacing: '0.18em',
                  textTransform: 'uppercase',
                  color: 'var(--text-dim)',
                }}
              >
                {label}
              </Typography>
            </Box>

            <Typography
              sx={{
                fontFamily: 'var(--font-mono)',
                fontSize: 24,
                fontWeight: 600,
                color: 'var(--text)',
                mt: 1,
                lineHeight: 1,
              }}
            >
              {rating}
              {provisional ? '?' : ''}
            </Typography>

            <Typography sx={{ fontSize: 12, color: 'var(--muted)', mt: 0.5 }}>
              {games} {games === 1 ? 'game' : 'games'}
            </Typography>
          </Box>
        )
      })}
    </Box>
  )
}
