import { useEffect, useState } from 'react'
import { Box, Switch, Tooltip, Typography } from '@mui/material'
import { Sparkles } from 'lucide-react'
import { analyze, type Analysis } from '../api/client'

function formatEval(e: Analysis['eval']): string {
  if (!e) return '—'
  if (e.type === 'mate') return `#${e.value}`
  const pawns = e.value / 100
  return `${pawns >= 0 ? '+' : ''}${pawns.toFixed(2)}`
}

// Admin-only inline toggle: when on, fetches the full-strength engine best move
// for the given position and shows it compactly (move · eval). Self-contained —
// pages just render it (gated on the admin role) and feed the current FEN.
export default function AdminBestMove({ fen }: { fen: string }) {
  const [enabled, setEnabled] = useState(false)
  const [best, setBest] = useState<Analysis | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    if (!enabled || !fen) {
      setBest(null)
      setError(null)
      return
    }
    let cancelled = false
    setLoading(true)
    setError(null)
    analyze(fen)
      .then((a) => {
        if (!cancelled) setBest(a)
      })
      .catch((e) => {
        if (!cancelled) setError(e instanceof Error ? e.message : 'Analysis failed')
      })
      .finally(() => {
        if (!cancelled) setLoading(false)
      })
    return () => {
      cancelled = true
    }
  }, [enabled, fen])

  return (
    <Box sx={{ display: 'flex', alignItems: 'center', gap: 0.75, minWidth: 0 }}>
      <Tooltip title="Engine best move (admin)" placement="top">
        <Box sx={{ display: 'flex', alignItems: 'center', flexShrink: 0 }}>
          <Sparkles size={14} color={enabled ? 'var(--accent)' : 'var(--text-dim)'} />
        </Box>
      </Tooltip>
      <Switch size="small" checked={enabled} onChange={(e) => setEnabled(e.target.checked)} />
      {enabled && (
        <Box
          sx={{
            ml: 'auto',
            display: 'flex',
            alignItems: 'baseline',
            gap: 0.75,
            minWidth: 0,
            overflow: 'hidden',
            whiteSpace: 'nowrap',
          }}
        >
          {error ? (
            <Typography sx={{ fontSize: 11.5, color: 'var(--danger, #e5484d)', fontFamily: 'var(--font-mono)' }} noWrap>
              {error}
            </Typography>
          ) : best ? (
            <>
              <Typography sx={{ fontFamily: 'var(--font-mono)', fontSize: 13.5, fontWeight: 700, color: 'var(--accent)' }} noWrap>
                {best.bestmove ?? '—'}
              </Typography>
              <Typography sx={{ fontFamily: 'var(--font-mono)', fontSize: 11.5, color: 'var(--text-dim)' }} noWrap>
                {formatEval(best.eval)}
                {best.depth != null ? ` · d${best.depth}` : ''}
              </Typography>
            </>
          ) : loading ? (
            <Typography sx={{ fontFamily: 'var(--font-mono)', fontSize: 11.5, color: 'var(--text-dim)' }}>…</Typography>
          ) : null}
        </Box>
      )}
    </Box>
  )
}
