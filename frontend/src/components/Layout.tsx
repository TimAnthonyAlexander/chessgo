import { Box, Button, Tooltip } from '@mui/material'
import { Search } from 'lucide-react'
import { Link, Outlet, useLocation } from 'react-router-dom'

const LINKS: { label: string; to: string | null }[] = [
  { label: 'Play', to: '/' },
  { label: 'Computer', to: '/bot' },
  { label: 'Puzzles', to: null },
  { label: 'Watch', to: null },
  { label: 'Learn', to: null },
]

/** App shell: a flat, full-width top nav (Lichess-style) over the routed page. */
export default function Layout() {
  const { pathname } = useLocation()

  const linkSx = (active: boolean, real: boolean) => ({
    fontSize: 12.5,
    fontWeight: 600,
    letterSpacing: '0.12em',
    textTransform: 'uppercase' as const,
    color: active ? 'var(--accent)' : real ? 'var(--text-dim)' : 'var(--muted)',
    transition: 'color 0.12s ease',
    ...(real ? { '&:hover': { color: 'var(--accent)' } } : { cursor: 'default' }),
  })

  return (
    <Box sx={{ minHeight: '100%', display: 'flex', flexDirection: 'column' }}>
      <Box
        component="header"
        sx={{
          display: 'flex',
          alignItems: 'center',
          gap: { xs: 2, md: 4 },
          px: { xs: 2, md: 4 },
          height: 60,
          borderBottom: '1px solid var(--line-soft)',
        }}
      >
        <Link to="/" aria-label="chessgo home">
          <Box sx={{ display: 'flex', alignItems: 'center', gap: 1 }}>
            <Box component="span" sx={{ fontSize: 22, lineHeight: 1, color: 'var(--accent)' }}>
              ♞
            </Box>
            <Box
              component="span"
              sx={{ fontFamily: 'var(--font-display)', fontWeight: 600, fontSize: 20, letterSpacing: '-0.01em' }}
            >
              chessgo
            </Box>
          </Box>
        </Link>

        <Box sx={{ display: { xs: 'none', md: 'flex' }, alignItems: 'center', gap: 3 }}>
          {LINKS.map((l) => {
            const active = !!l.to && (l.to === '/' ? pathname === '/' : pathname.startsWith(l.to))
            if (!l.to) {
              return (
                <Tooltip key={l.label} title="Coming soon" arrow>
                  <Box component="span" sx={linkSx(false, false)}>
                    {l.label}
                  </Box>
                </Tooltip>
              )
            }
            return (
              <Box key={l.label} component={Link} to={l.to} sx={linkSx(active, true)}>
                {l.label}
              </Box>
            )
          })}
        </Box>

        <Box sx={{ ml: 'auto', display: 'flex', alignItems: 'center', gap: 1.5 }}>
          <Search size={18} color="var(--muted)" />
          <Tooltip title="Accounts coming soon" arrow>
            <Button
              variant="outlined"
              color="inherit"
              size="small"
              sx={{ borderColor: 'var(--line)', color: 'var(--text-dim)', px: 1.75 }}
            >
              Sign in
            </Button>
          </Tooltip>
        </Box>
      </Box>

      <Box component="main" sx={{ flex: 1, display: 'flex', flexDirection: 'column' }}>
        <Outlet />
      </Box>
    </Box>
  )
}
