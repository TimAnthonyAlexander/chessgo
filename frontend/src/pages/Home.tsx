import { Box, Button, Typography } from '@mui/material'
import { ArrowRight } from 'lucide-react'
import { Link } from 'react-router-dom'

/** Deliberately spare landing page: wordmark, one line, one door. */
export default function Home() {
  return (
    <Box
      sx={{
        flex: 1,
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
        justifyContent: 'center',
        textAlign: 'center',
        px: 3,
        position: 'relative',
        overflow: 'hidden',
      }}
    >
      {/* Faint oversized knight — atmosphere, not decoration */}
      <Box
        aria-hidden
        sx={{
          position: 'absolute',
          fontSize: 'min(62vh, 560px)',
          lineHeight: 1,
          color: 'var(--text)',
          opacity: 0.025,
          userSelect: 'none',
          pointerEvents: 'none',
          transform: 'translateY(4%)',
        }}
      >
        ♞
      </Box>

      <Box sx={{ position: 'relative', animation: 'rise 0.6s ease both' }}>
        <Typography
          sx={{
            fontFamily: 'var(--font-mono)',
            fontSize: 12.5,
            letterSpacing: '0.34em',
            textTransform: 'uppercase',
            color: 'var(--accent)',
            mb: 2.5,
          }}
        >
          a quiet place to play
        </Typography>

        <Typography
          component="h1"
          sx={{
            fontFamily: 'var(--font-display)',
            fontWeight: 600,
            fontSize: { xs: 56, sm: 84, md: 104 },
            lineHeight: 0.95,
            letterSpacing: '-0.03em',
          }}
        >
          chessgo
        </Typography>

        <Typography
          sx={{
            mt: 3,
            mb: 5,
            maxWidth: 440,
            mx: 'auto',
            color: 'var(--text-dim)',
            fontSize: 17,
            lineHeight: 1.6,
          }}
        >
          A minimalist chess board with a homegrown engine. No accounts, no clocks —
          just you and the machine.
        </Typography>

        <Button
          component={Link}
          to="/bot"
          variant="contained"
          endIcon={<ArrowRight size={18} />}
          sx={{ fontSize: 15, py: 1.25, px: 3 }}
        >
          Play the bot
        </Button>
      </Box>
    </Box>
  )
}
