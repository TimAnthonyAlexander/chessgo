import { useEffect, useState } from 'react'
import { Box, Typography, Button } from '@mui/material'
import { Target } from 'lucide-react'
import { useNavigate } from 'react-router-dom'
import { Panel, PanelHead } from './Panel'
import MiniBoard from '../MiniBoard'
import { getDailyPuzzle, type DailyPuzzle } from '../../api/client'

/** Pretty-print a Lichess theme tag (e.g. "mateIn2" -> "Mate In 2"). */
function titleCaseTheme(theme: string): string {
  const spaced = theme
    .replace(/([a-z])([A-Z0-9])/g, '$1 $2')
    .replace(/[_-]+/g, ' ')
    .trim()
  return spaced
    .split(/\s+/)
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
    .join(' ')
}

/** Homepage "Puzzle of the day" widget. Self-contained: fetches once on mount,
 * shows the position + side-to-move + rating + a few theme pills, and routes to
 * the full trainer at /puzzles. The solution is never fetched here. */
export default function DailyPuzzleWidget() {
  const navigate = useNavigate()
  const [puzzle, setPuzzle] = useState<DailyPuzzle | null>(null)
  const [error, setError] = useState(false)

  useEffect(() => {
    let alive = true
    getDailyPuzzle()
      .then((p) => {
        if (alive) setPuzzle(p)
      })
      .catch(() => {
        if (alive) setError(true)
      })
    return () => {
      alive = false
    }
  }, [])

  const goSolve = () => navigate('/puzzles')

  return (
    <Panel>
      <PanelHead title="Daily puzzle" />

      {error ? (
        <Typography sx={{ fontSize: 13.5, color: 'var(--muted)', py: 2, textAlign: 'center' }}>
          Couldn't load today's puzzle
        </Typography>
      ) : !puzzle ? (
        <Box
          sx={{
            aspectRatio: '1',
            width: '100%',
            borderRadius: '8px',
            bgcolor: 'var(--surface-2)',
            border: '1px solid var(--line-soft)',
          }}
        />
      ) : (
        <>
          <Box
            role="button"
            onClick={goSolve}
            sx={{ cursor: 'pointer', borderRadius: '8px', overflow: 'hidden', display: 'block' }}
          >
            <MiniBoard fen={puzzle.fen} lastMove={puzzle.opponent_move} orientation={puzzle.color} />
          </Box>

          <Box sx={{ display: 'flex', alignItems: 'baseline', justifyContent: 'space-between', gap: 2, mt: 1.75 }}>
            <Typography sx={{ fontSize: 14, color: 'var(--text)', fontWeight: 600 }}>
              {puzzle.color === 'w' ? 'White to move' : 'Black to move'}
            </Typography>
            <Typography sx={{ fontFamily: 'var(--font-mono)', fontSize: 13, color: 'var(--text-dim)' }}>
              Rating {puzzle.rating}
            </Typography>
          </Box>

          {puzzle.themes.length > 0 && (
            <Box sx={{ display: 'flex', flexWrap: 'wrap', gap: 0.75, mt: 1.25 }}>
              {puzzle.themes.slice(0, 3).map((theme) => (
                <Box
                  key={theme}
                  sx={{
                    px: 1,
                    py: 0.25,
                    borderRadius: '999px',
                    bgcolor: 'var(--surface-2)',
                    border: '1px solid var(--line)',
                    fontSize: 11.5,
                    color: 'var(--text-dim)',
                    whiteSpace: 'nowrap',
                  }}
                >
                  {titleCaseTheme(theme)}
                </Box>
              ))}
            </Box>
          )}

          <Button
            variant="contained"
            fullWidth
            startIcon={<Target size={16} />}
            onClick={goSolve}
            sx={{ mt: 2, textTransform: 'none', fontWeight: 600 }}
          >
            Solve
          </Button>
        </>
      )}
    </Panel>
  )
}
