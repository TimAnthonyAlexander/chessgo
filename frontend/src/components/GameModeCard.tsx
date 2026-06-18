import { Box, Typography } from '@mui/material'
import { Infinity as InfinityIcon } from 'lucide-react'

/** Left-side game-mode card. We currently only offer casual, untimed games vs
 * the engine — shown plainly, no placeholders for modes we don't have. */
export default function GameModeCard({ level }: { level: number }) {
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
        <InfinityIcon size={17} />
        <Typography
          sx={{
            fontFamily: 'var(--font-mono)',
            fontSize: 11,
            letterSpacing: '0.2em',
            textTransform: 'uppercase',
            color: 'var(--text-dim)',
          }}
        >
          Untimed
        </Typography>
      </Box>

      <Typography sx={{ fontFamily: 'var(--font-display)', fontSize: 32, fontWeight: 600, mt: 1, lineHeight: 1 }}>
        Casual
      </Typography>

      <Box sx={{ borderTop: '1px solid var(--line-soft)', mt: 2.25, pt: 2.25 }}>
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
          Opponent
        </Typography>
        <Typography sx={{ fontWeight: 600, fontSize: 16 }}>gomachine</Typography>
        <Typography sx={{ color: 'var(--text-dim)', fontSize: 13.5 }}>Engine · Level {level}</Typography>
      </Box>
    </Box>
  )
}
