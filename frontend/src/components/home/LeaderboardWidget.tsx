import { useEffect, useState } from 'react'
import { Box, Typography } from '@mui/material'
import { useNavigate } from 'react-router-dom'
import { Panel, PanelHead } from './Panel'
import { getLeaderboard, type LeaderboardEntry } from '../../api/client'
import { CATEGORY_META, type Category } from '../../lib/timeControl'

const CATEGORIES: Category[] = ['Bullet', 'Blitz', 'Rapid', 'Classical']
const DEFAULT_CATEGORY: Category = 'Blitz'

/** The lowercase wire value the API expects ('blitz'), derived from the display Category. */
function apiKey(cat: Category): 'bullet' | 'blitz' | 'rapid' | 'classical' {
  return cat.toLowerCase() as 'bullet' | 'blitz' | 'rapid' | 'classical'
}

type LoadState =
  | { kind: 'loading' }
  | { kind: 'error' }
  | { kind: 'ready'; entries: LeaderboardEntry[] }

/** Homepage sidebar widget: per-category top-10 leaderboard with a category toggle.
 * Self-contained — fetches its own data and re-fetches when the category changes. */
export default function LeaderboardWidget() {
  const navigate = useNavigate()
  const [category, setCategory] = useState<Category>(DEFAULT_CATEGORY)
  const [state, setState] = useState<LoadState>({ kind: 'loading' })

  useEffect(() => {
    let cancelled = false
    setState({ kind: 'loading' })
    getLeaderboard(apiKey(category))
      .then((res) => {
        if (cancelled) return
        setState({ kind: 'ready', entries: res.entries.slice(0, 10) })
      })
      .catch(() => {
        if (cancelled) return
        setState({ kind: 'error' })
      })
    return () => {
      cancelled = true
    }
  }, [category])

  const accent = CATEGORY_META[category].color

  const toggle = (
    <Box sx={{ display: 'flex', gap: 0.5 }}>
      {CATEGORIES.map((cat) => {
        const active = cat === category
        const c = CATEGORY_META[cat].color
        return (
          <Box
            key={cat}
            component="button"
            type="button"
            onClick={() => setCategory(cat)}
            sx={{
              appearance: 'none',
              cursor: 'pointer',
              font: 'inherit',
              fontFamily: 'var(--font-display)',
              fontSize: 12,
              fontWeight: 600,
              lineHeight: 1,
              px: 1,
              py: 0.6,
              borderRadius: '999px',
              border: '1px solid',
              borderColor: active ? c : 'var(--line)',
              bgcolor: active ? `${c}22` : 'transparent',
              color: active ? c : 'var(--text-dim)',
              transition: 'all 120ms ease',
              '&:hover': { borderColor: active ? c : 'var(--line-soft)', color: active ? c : 'var(--text)' },
            }}
          >
            {cat}
          </Box>
        )
      })}
    </Box>
  )

  return (
    <Panel>
      <PanelHead title="Leaderboard" action={toggle} />
      {state.kind === 'loading' && <SkeletonRows />}
      {state.kind === 'error' && (
        <Typography sx={{ fontSize: 13, color: 'var(--muted)', py: 1.5, textAlign: 'center' }}>
          Couldn't load the leaderboard.
        </Typography>
      )}
      {state.kind === 'ready' && state.entries.length === 0 && (
        <Typography sx={{ fontSize: 13, color: 'var(--muted)', py: 1.5, textAlign: 'center' }}>
          No ranked players yet
        </Typography>
      )}
      {state.kind === 'ready' && state.entries.length > 0 && (
        <Box>
          {state.entries.map((e) => {
            const top = e.rank === 1
            return (
              <Box
                key={e.id}
                component="button"
                type="button"
                onClick={() => navigate(`/@/${encodeURIComponent(e.name)}`)}
                sx={{
                  appearance: 'none',
                  cursor: 'pointer',
                  font: 'inherit',
                  width: '100%',
                  display: 'flex',
                  alignItems: 'center',
                  gap: 1.25,
                  px: 0.75,
                  py: 0.85,
                  border: 'none',
                  borderLeft: '2px solid',
                  borderLeftColor: top ? accent : 'transparent',
                  borderRadius: '8px',
                  bgcolor: 'transparent',
                  textAlign: 'left',
                  transition: 'background-color 120ms ease',
                  '&:hover': { bgcolor: 'var(--surface-2)' },
                }}
              >
                <Typography
                  sx={{
                    fontFamily: 'var(--font-mono)',
                    fontSize: 12,
                    color: top ? accent : 'var(--muted)',
                    minWidth: 20,
                    textAlign: 'right',
                  }}
                >
                  {e.rank}
                </Typography>
                <Typography
                  sx={{
                    flex: 1,
                    minWidth: 0,
                    fontSize: 14,
                    color: 'var(--text)',
                    overflow: 'hidden',
                    textOverflow: 'ellipsis',
                    whiteSpace: 'nowrap',
                  }}
                >
                  {e.name}
                </Typography>
                <Typography
                  sx={{ fontFamily: 'var(--font-mono)', fontSize: 13, fontWeight: 700, color: 'var(--text)' }}
                >
                  {e.rating}
                  {e.provisional && <Box component="span" sx={{ color: 'var(--text-dim)' }}>?</Box>}
                </Typography>
              </Box>
            )
          })}
        </Box>
      )}
    </Panel>
  )
}

/** Placeholder rows while the category fetch is in flight. */
function SkeletonRows() {
  return (
    <Box>
      {Array.from({ length: 8 }).map((_, i) => (
        <Box key={i} sx={{ display: 'flex', alignItems: 'center', gap: 1.25, px: 0.75, py: 0.85 }}>
          <Box sx={{ width: 14, height: 12, borderRadius: '4px', bgcolor: 'var(--surface-2)' }} />
          <Box sx={{ flex: 1, height: 12, borderRadius: '4px', bgcolor: 'var(--surface-2)' }} />
          <Box sx={{ width: 34, height: 12, borderRadius: '4px', bgcolor: 'var(--surface-2)' }} />
        </Box>
      ))}
    </Box>
  )
}
