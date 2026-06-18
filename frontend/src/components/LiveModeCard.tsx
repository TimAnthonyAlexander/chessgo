import { type ReactNode } from 'react'
import { Box, Typography } from '@mui/material'
import { Crown, Rabbit, Timer, Zap } from 'lucide-react'
import type { Color } from '../lib/socket'

/** Left-side card for a live human game: time-control category, rated/casual,
 * and opponent details. Mirrors GameModeCard (vs the engine). */
export default function LiveModeCard({
  pool,
  rated,
  color,
  opponent,
}: {
  pool: string
  rated: boolean
  color: Color
  opponent: { name: string; rating: number; anon: boolean }
}) {
  const cat = categoryFor(pool)

  return (
    <Box
      sx={{
        bgcolor: 'var(--surface)',
        border: '1px solid var(--line-soft)',
        borderRadius: '14px',
        p: 2.5,
        boxShadow: '0 18px 50px -28px rgba(0,0,0,0.8)',
      }}
    >
      <Box sx={{ display: 'flex', alignItems: 'center', gap: 1, color: 'var(--accent)' }}>
        {cat.icon}
        <Typography
          sx={{
            fontFamily: 'var(--font-mono)',
            fontSize: 11,
            letterSpacing: '0.2em',
            textTransform: 'uppercase',
            color: 'var(--text-dim)',
          }}
        >
          {rated ? 'Rated' : 'Casual'}
        </Typography>
      </Box>

      <Typography sx={{ fontFamily: 'var(--font-display)', fontSize: 32, fontWeight: 600, mt: 1, lineHeight: 1 }}>
        {cat.label}
      </Typography>
      <Typography sx={{ fontFamily: 'var(--font-mono)', fontSize: 14, color: 'var(--text-dim)', mt: 0.75 }}>
        {pool}
      </Typography>

      <Box sx={{ borderTop: '1px solid var(--line-soft)', mt: 2.25, pt: 2.25 }}>
        <Label>Opponent</Label>
        <Typography sx={{ fontWeight: 600, fontSize: 16 }}>{opponent.name}</Typography>
        <Typography sx={{ color: 'var(--text-dim)', fontSize: 13.5 }}>
          {opponent.anon ? 'Unrated player' : `Rating ${opponent.rating}`}
        </Typography>
      </Box>

      <Box sx={{ borderTop: '1px solid var(--line-soft)', mt: 2.25, pt: 2.25 }}>
        <Label>You play</Label>
        <Typography sx={{ fontWeight: 600, fontSize: 16 }}>{color === 'w' ? 'White' : 'Black'}</Typography>
      </Box>
    </Box>
  )
}

function Label({ children }: { children: ReactNode }) {
  return (
    <Typography
      sx={{
        fontFamily: 'var(--font-mono)',
        fontSize: 10.5,
        letterSpacing: '0.16em',
        textTransform: 'uppercase',
        color: 'var(--muted)',
        mb: 0.75,
      }}
    >
      {children}
    </Typography>
  )
}

/** Map a "base+inc" pool (minutes + seconds) to a Lichess-style category. */
function categoryFor(pool: string): { label: string; icon: ReactNode } {
  const [baseMin, incSec] = pool.split('+').map((n) => Number(n) || 0)
  const estSec = baseMin * 60 + incSec * 40
  if (estSec < 180) return { label: 'Bullet', icon: <Rabbit size={17} /> }
  if (estSec < 480) return { label: 'Blitz', icon: <Zap size={17} /> }
  if (estSec < 1500) return { label: 'Rapid', icon: <Timer size={17} /> }
  return { label: 'Classical', icon: <Crown size={17} /> }
}
