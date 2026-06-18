import { useEffect, useRef } from 'react'
import { Box } from '@mui/material'
import type { MoveEntry } from '../api/client'
import { sanToGlyph } from '../lib/chess'

interface MoveListProps {
  moves: MoveEntry[]
  currentPly: number // 0 = start position, k = after k plies
  onSelectPly: (ply: number) => void
  visibleRows?: number // fixed number of full-move rows the panel shows before scrolling
  fill?: boolean // grow to fill the parent (full-height panel) instead of a fixed height
}

const ROW_H = 31 // px per row; keep in sync with Cell minHeight so rows fit exactly
const DEFAULT_VISIBLE_ROWS = 10

/** Lichess-style move grid: number gutter, White column (lighter), Black column.
 * In fixed mode it always renders `visibleRows` rows tall — padded with empty rows
 * when there are fewer, scrollable once there are more — so the panel height never
 * jumps. In `fill` mode it grows to fill the parent and scrolls, for full-height
 * panels. */
export default function MoveList({
  moves,
  currentPly,
  onSelectPly,
  visibleRows = DEFAULT_VISIBLE_ROWS,
  fill = false,
}: MoveListProps) {
  const rows: { no: number; white?: MoveEntry; black?: MoveEntry }[] = []
  for (let i = 0; i < moves.length; i += 2) {
    rows.push({ no: i / 2 + 1, white: moves[i], black: moves[i + 1] })
  }
  const padCount = fill ? 0 : Math.max(0, visibleRows - rows.length)

  // Keep the active (latest-played / selected) row in view as moves come in, so the
  // newest moves don't disappear below the scroll cutoff. `block: 'nearest'` only
  // scrolls the move container, never the page.
  const activeRef = useRef<HTMLDivElement>(null)
  useEffect(() => {
    activeRef.current?.scrollIntoView({ block: 'nearest' })
  }, [currentPly, moves.length])

  const rowEls = (
    <>
      {rows.map((r) => {
        const isActive = r.white?.ply === currentPly || r.black?.ply === currentPly
        return (
          <Box key={r.no} ref={isActive ? activeRef : undefined} sx={{ display: 'grid', gridTemplateColumns: '32px 1fr 1fr' }}>
            <RowNumber no={r.no} />
            <Cell entry={r.white} whiteCol current={currentPly} onSelect={onSelectPly} />
            <Cell entry={r.black} current={currentPly} onSelect={onSelectPly} />
          </Box>
        )
      })}
      {Array.from({ length: padCount }, (_, k) => (
        <Box key={`pad-${k}`} sx={{ display: 'grid', gridTemplateColumns: '32px 1fr 1fr' }}>
          <RowNumber />
          <Cell whiteCol current={currentPly} onSelect={onSelectPly} />
          <Cell current={currentPly} onSelect={onSelectPly} />
        </Box>
      ))}
    </>
  )

  // Fixed mode has a definite height, so it scrolls directly. Fill mode grows to
  // fill a full-height panel: on md the scroll area is absolutely positioned so its
  // content never grows the surrounding grid row (the panel then matches the board's
  // height and moves scroll inside). On xs the parent is already height-bounded, so
  // the outer box scrolls directly and the layout there is unchanged.
  if (!fill) {
    return <Box sx={{ height: visibleRows * ROW_H, overflowY: 'auto' }}>{rowEls}</Box>
  }
  return (
    <Box sx={{ flex: 1, minHeight: 0, position: 'relative', overflowY: { xs: 'auto', md: 'visible' } }}>
      <Box sx={{ position: { md: 'absolute' }, inset: { md: 0 }, overflowY: { md: 'auto' } }}>{rowEls}</Box>
    </Box>
  )
}

function RowNumber({ no }: { no?: number }) {
  return (
    <Box
      sx={{
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        minHeight: ROW_H,
        color: 'var(--muted)',
        fontFamily: 'var(--font-mono)',
        fontSize: 12,
      }}
    >
      {no ?? ''}
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
