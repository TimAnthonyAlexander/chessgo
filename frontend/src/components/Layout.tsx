import { Box } from '@mui/material'
import { Link, Outlet, useLocation } from 'react-router-dom'

/** App shell: a quiet top bar with the wordmark, and the routed page below. */
export default function Layout() {
  const { pathname } = useLocation()
  return (
    <Box sx={{ minHeight: '100%', display: 'flex', flexDirection: 'column' }}>
      <Box
        component="header"
        sx={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          px: { xs: 2.5, md: 4 },
          height: 64,
          borderBottom: '1px solid var(--line-soft)',
        }}
      >
        <Link to="/" aria-label="chessgo home">
          <Box sx={{ display: 'flex', alignItems: 'baseline', gap: 1 }}>
            <Box component="span" sx={{ fontSize: 22, lineHeight: 1, color: 'var(--accent)' }}>
              ♞
            </Box>
            <Box
              component="span"
              sx={{
                fontFamily: 'var(--font-display)',
                fontWeight: 600,
                fontSize: 21,
                letterSpacing: '-0.01em',
              }}
            >
              chessgo
            </Box>
          </Box>
        </Link>

        {pathname !== '/bot' && (
          <Link to="/bot">
            <Box
              sx={{
                fontFamily: 'var(--font-mono)',
                fontSize: 12.5,
                letterSpacing: '0.08em',
                color: 'var(--text-dim)',
                textTransform: 'uppercase',
                transition: 'color 0.15s ease',
                '&:hover': { color: 'var(--accent)' },
              }}
            >
              Play&nbsp;the&nbsp;bot →
            </Box>
          </Link>
        )}
      </Box>

      <Box component="main" sx={{ flex: 1, display: 'flex', flexDirection: 'column' }}>
        <Outlet />
      </Box>
    </Box>
  )
}
