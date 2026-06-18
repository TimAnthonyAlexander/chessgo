import { Box } from '@mui/material'
import type { MoveEntry } from '../api/client'
import { sanToGlyph } from '../lib/chess'

interface MoveListProps {
  moves: MoveEntry[]
  currentPly: number // 0 = start position, k = after k plies
  onSelectPly: (ply: number) => void
}

/** Lichess-style move grid: number gutter, White column (lighter), Black column. */
export default function MoveList({ moves, currentPly, onSelectPly }: MoveListProps) {
  if (moves.length === 0) {
    return (
      <Box sx={{ px: 1.75, py: 2.5, color: 'var(--muted)', fontFamily: 'var(--font-mono)', fontSize: 13 }}>
        No moves yet.
      </Box>
    )
  }

  const rows: { no: number; white?: MoveEntry; black?: MoveEntry }[] = []
  for (let i = 0; i < moves.length; i += 2) {
    rows.push({ no: i / 2 + 1, white: moves[i], black: moves[i + 1] })
  }

  return (
    <Box sx={{ maxHeight: { xs: 200, lg: 320 }, overflowY: 'auto' }}>
      {rows.map((r) => (
        <Box key={r.no} sx={{ display: 'grid', gridTemplateColumns: '32px 1fr 1fr' }}>
          <Box
            sx={{
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              color: 'var(--muted)',
              fontFamily: 'var(--font-mono)',
              fontSize: 12,
            }}
          >
            {r.no}
          </Box>
          <Cell entry={r.white} whiteCol current={currentPly} onSelect={onSelectPly} />
          <Cell entry={r.black} current={currentPly} onSelect={onSelectPly} />
        </Box>
      ))}
    </Box>
  )
}

function Cell({
  entry,
  whiteCol,
  current,
  onSelect,
}: {
  entry?: MoveEntry
  whiteCol?: boolean
  current: number
  onSelect: (ply: number) => void
}) {
  const base = whiteCol ? 'rgba(255,255,255,0.05)' : 'transparent'
  if (!entry) {
    return <Box sx={{ minHeight: 31, bgcolor: base }} />
  }
  const isCurrent = entry.ply === current
  return (
    <Box
      onClick={() => onSelect(entry.ply)}
      sx={{
        minHeight: 31,
        display: 'flex',
        alignItems: 'center',
        px: 1.25,
        cursor: 'pointer',
        fontFamily: 'var(--font-mono)',
        fontSize: 13.5,
        fontWeight: 500,
        color: isCurrent ? '#fff' : 'var(--text)',
        bgcolor: isCurrent ? '#3a4880' : base,
        transition: 'background 0.1s ease',
        '&:hover': { bgcolor: isCurrent ? '#3a4880' : 'rgba(255,255,255,0.09)' },
      }}
    >
      {sanToGlyph(entry.san)}
    </Box>
  )
}
