import { useEffect, useState } from 'react'
import { Box, Switch, Tooltip, Typography } from '@mui/material'
import { Sparkles } from 'lucide-react'
import { analyze, type Analysis, type Color } from '../api/client'
import { pvToSan } from '../lib/analysisTree'

// Convert the engine's UCI best move (e.g. "e2e4", "b1c3") into SAN piece
// notation ("e4", "Nc3") for display. Falls back to the raw UCI if the move
// can't be rendered (illegal/garbage — shouldn't happen for an engine reply).
function bestMoveSan(fen: string, uci: string | null): string {
  if (!uci) return '—'
  return pvToSan(fen, [uci])[0]?.san ?? uci
}

// The engine reports its eval from the side-to-move's perspective; convert to
// White-relative so the sign matches every other bar/pill (+ = White, − = Black)
// instead of flipping with whose turn it is.
function formatEval(e: Analysis['eval'], stm: Color): string {
  if (!e) return '—'
  const white = stm === 'w' ? e.value : -e.value
  if (e.type === 'mate') return (white < 0 ? '-' : '') + '#' + Math.abs(white)
  const pawns = white / 100
  return `${pawns >= 0 ? '+' : ''}${pawns.toFixed(2)}`
}

// The active-color field of a FEN ('w' unless it's explicitly Black to move).
function fenSideToMove(fen: string): Color {
  return fen.split(' ')[1] === 'b' ? 'b' : 'w'
}

const LS_KEY = 'admin-best-move'

function loadEnabled(): boolean {
  try {
    return localStorage.getItem(LS_KEY) === '1'
  } catch {
    return false
  }
}

function saveEnabled(on: boolean): void {
  try {
    localStorage.setItem(LS_KEY, on ? '1' : '0')
  } catch {
    // ignore storage failures (private mode, quota)
  }
}

// Admin-only inline toggle: when on, fetches the full-strength engine best move
// for the given position and shows it compactly (move · eval). Self-contained —
// pages just render it (gated on the admin role) and feed the current FEN.
export default function AdminBestMove({ fen, myTurn }: { fen: string; myTurn: boolean }) {
  const [enabled, setEnabled] = useState(loadEnabled)
  const [best, setBest] = useState<Analysis | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    // Only compute the best move for the player's own side — no point spending
    // engine time on the opponent's reply.
    if (!enabled || !fen || !myTurn) {
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
  }, [enabled, fen, myTurn])

  return (
    <Box sx={{ display: 'flex', alignItems: 'center', gap: 0.75, minWidth: 0 }}>
      <Tooltip title="Engine best move (admin)" placement="top">
        <Box sx={{ display: 'flex', alignItems: 'center', flexShrink: 0 }}>
          <Sparkles size={14} color={enabled ? 'var(--accent)' : 'var(--text-dim)'} />
        </Box>
      </Tooltip>
      <Switch
        size="small"
        checked={enabled}
        onChange={(e) => {
          setEnabled(e.target.checked)
          saveEnabled(e.target.checked)
        }}
      />
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
                {bestMoveSan(fen, best.bestmove)}
              </Typography>
              <Typography sx={{ fontFamily: 'var(--font-mono)', fontSize: 11.5, color: 'var(--text-dim)' }} noWrap>
                {formatEval(best.eval, fenSideToMove(fen))}
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
