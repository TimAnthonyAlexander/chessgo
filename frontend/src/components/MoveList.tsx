import { Box, Typography } from '@mui/material'
import type { MoveEntry } from '../api/client'

interface MoveListProps {
  moves: MoveEntry[]
}

/** Paired move list in monospace (1. e4 e5  2. Nf3 …), newest auto-scrolled. */
export default function MoveList({ moves }: MoveListProps) {
  const rows: { no: number; white?: MoveEntry; black?: MoveEntry }[] = []
  for (let i = 0; i < moves.length; i += 2) {
    rows.push({ no: i / 2 + 1, white: moves[i], black: moves[i + 1] })
  }
  const lastPly = moves.length

  if (moves.length === 0) {
    return (
      <Typography sx={{ color: 'var(--muted)', fontFamily: 'var(--font-mono)', fontSize: 13, py: 1 }}>
        No moves yet.
      </Typography>
    )
  }

  return (
    <Box
      sx={{
        fontFamily: 'var(--font-mono)',
        fontSize: 13.5,
        lineHeight: 1.9,
        maxHeight: 220,
        overflowY: 'auto',
        pr: 0.5,
      }}
    >
      {rows.map((row) => (
        <Box key={row.no} sx={{ display: 'grid', gridTemplateColumns: '30px 1fr 1fr', columnGap: 1 }}>
          <Box component="span" sx={{ color: 'var(--muted)' }}>
            {row.no}.
          </Box>
          <Cell entry={row.white} highlight={row.white?.ply === lastPly} />
          <Cell entry={row.black} highlight={row.black?.ply === lastPly} />
        </Box>
      ))}
    </Box>
  )
}

function Cell({ entry, highlight }: { entry?: MoveEntry; highlight?: boolean }) {
  if (!entry) return <span />
  return (
    <Box
      component="span"
      sx={{
        color: highlight ? 'var(--accent)' : 'var(--text)',
        fontWeight: highlight ? 600 : 500,
      }}
    >
      {entry.san}
    </Box>
  )
}
