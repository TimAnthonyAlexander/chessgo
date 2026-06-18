import { Box } from '@mui/material'
import type { Color } from '../api/client'

/** Engine evaluation expressed from White's perspective. */
export interface WhiteEval {
  type: 'cp' | 'mate'
  white: number // cp (centipawns) or signed mate distance; + favors White
}

interface EvalBarProps {
  ev: WhiteEval | null
  orientation: Color
}

// Lichess "Winning chances": a sigmoid of centipawns fit from real game data, so
// swings near 0.0 move the bar a lot and distant swings barely move it.
function whiteWinPercent(ev: WhiteEval | null): number {
  if (!ev) return 50
  if (ev.type === 'mate') return ev.white > 0 ? 100 : ev.white < 0 ? 0 : 50
  const cp = Math.max(-1000, Math.min(1000, ev.white))
  return 50 + 50 * (2 / (1 + Math.exp(-0.00368208 * cp)) - 1)
}

function evalLabel(ev: WhiteEval | null): string {
  if (!ev) return '0.0'
  if (ev.type === 'mate') return 'M' + Math.abs(ev.white)
  return (Math.abs(ev.white) / 100).toFixed(1)
}

export default function EvalBar({ ev, orientation }: EvalBarProps) {
  const whitePct = whiteWinPercent(ev)
  const whiteAhead = ev ? (ev.type === 'mate' ? ev.white >= 0 : ev.white >= 0) : true
  const whiteAnchor = orientation === 'w' ? 'bottom' : 'top' // White grows from its own side

  // The number sits at the winning side's end of the bar, in contrasting ink.
  const winningSide: Color = whiteAhead ? 'w' : 'b'
  const numberAtBottom = winningSide === orientation
  const numberOnLight = whiteAhead

  return (
    <Box
      sx={{
        position: 'relative',
        width: { xs: 14, md: 20 },
        flexShrink: 0,
        borderRadius: 1,
        overflow: 'hidden',
        bgcolor: '#191c22', // black's region (background)
        border: '1px solid var(--line-soft)',
      }}
    >
      {/* White's region grows from White's side of the board */}
      <Box
        sx={{
          position: 'absolute',
          left: 0,
          right: 0,
          [whiteAnchor]: 0,
          height: `${whitePct}%`,
          background: 'linear-gradient(180deg, #f3eee2, #e4dccb)',
          transition: 'height 0.45s cubic-bezier(0.4, 0, 0.2, 1)',
        }}
      />

      {/* Square-aligned ticks */}
      {[1, 2, 3, 4, 5, 6, 7].map((i) => (
        <Box
          key={i}
          sx={{
            position: 'absolute',
            left: 0,
            right: 0,
            top: `${i * 12.5}%`,
            height: '1px',
            background: 'rgba(120,120,120,0.28)',
            pointerEvents: 'none',
          }}
        />
      ))}

      {/* Numeric eval at the winning side */}
      <Box
        sx={{
          position: 'absolute',
          left: 0,
          right: 0,
          [numberAtBottom ? 'bottom' : 'top']: 3,
          textAlign: 'center',
          fontFamily: 'var(--font-mono)',
          fontSize: { xs: 8.5, md: 10 },
          fontWeight: 600,
          letterSpacing: '-0.02em',
          lineHeight: 1,
          color: numberOnLight ? '#1c1f26' : '#e9e1cf',
          pointerEvents: 'none',
        }}
      >
        {evalLabel(ev)}
      </Box>
    </Box>
  )
}
