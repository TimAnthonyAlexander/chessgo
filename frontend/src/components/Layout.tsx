import { useEffect, useState } from 'react'
import { Box, Button, Divider, Menu, MenuItem, Tooltip, Typography } from '@mui/material'
import { ChevronDown, LogOut, Search } from 'lucide-react'
import { Link, Outlet, useLocation } from 'react-router-dom'
import { gameSocket } from '../lib/socket'
import { authStore, useAuth } from '../lib/auth'
import AuthDialog from './AuthDialog'
import Logo from './Logo'
import type { RatingCategory, User } from '../api/client'

const LINKS: { label: string; to: string | null }[] = [
  { label: 'Play', to: '/' },
  { label: 'Computer', to: '/bot' },
  { label: 'Puzzles', to: '/puzzles' },
  { label: 'Analysis', to: '/analysis' },
  { label: 'Watch', to: '/watch' },
]

/** App shell: a flat, full-width top nav (Lichess-style) over the routed page. */
export default function Layout() {
  const { pathname } = useLocation()
  const { user } = useAuth()
  const [authOpen, setAuthOpen] = useState(false)

  // Open the realtime socket + resolve the session once on load.
  useEffect(() => {
    void gameSocket.connect()
    void authStore.init()
  }, [])

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
            <Box sx={{ display: 'flex', color: 'var(--accent)' }}>
              <Logo size={24} />
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
          {(user?.role === 'admin'
            ? [...LINKS, { label: 'Engine v Engine', to: '/admin/engine-vs' }]
            : LINKS
          ).map((l) => {
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
          {user ? (
            <UserMenu user={user} />
          ) : (
            <Button
              variant="outlined"
              color="inherit"
              size="small"
              onClick={() => setAuthOpen(true)}
              sx={{ borderColor: 'var(--line)', color: 'var(--text-dim)', px: 1.75, '&:hover': { borderColor: 'var(--accent)', color: 'var(--accent)' } }}
            >
              Log in
            </Button>
          )}
        </Box>
      </Box>

      <Box component="main" sx={{ flex: 1, display: 'flex', flexDirection: 'column' }}>
        <Outlet />
      </Box>

      <AuthDialog open={authOpen} onClose={() => setAuthOpen(false)} />
    </Box>
  )
}

const CATEGORIES: { key: RatingCategory; label: string }[] = [
  { key: 'bullet', label: 'Bullet' },
  { key: 'blitz', label: 'Blitz' },
  { key: 'rapid', label: 'Rapid' },
  { key: 'classical', label: 'Classical' },
]

function UserMenu({ user }: { user: User }) {
  const [anchor, setAnchor] = useState<HTMLElement | null>(null)
  return (
    <>
      <Button
        color="inherit"
        size="small"
        endIcon={<ChevronDown size={15} />}
        onClick={(e) => setAnchor(e.currentTarget)}
        sx={{ textTransform: 'none', color: 'var(--text)', fontWeight: 600, fontSize: 14, px: 1.25 }}
      >
        {user.name}
        <Typography component="span" sx={{ ml: 0.75, fontFamily: 'var(--font-mono)', fontSize: 12, color: 'var(--text-dim)' }}>
          {user.rating_blitz}{user.provisional?.blitz ? '?' : ''}
        </Typography>
      </Button>
      <Menu
        anchorEl={anchor}
        open={!!anchor}
        onClose={() => setAnchor(null)}
        slotProps={{ paper: { sx: { bgcolor: 'var(--surface)', border: '1px solid var(--line)', minWidth: 200 } } }}
      >
        {CATEGORIES.map((c) => (
          <MenuItem key={c.key} disableRipple sx={{ cursor: 'default', justifyContent: 'space-between', gap: 3, fontSize: 13.5 }}>
            <span style={{ color: 'var(--text-dim)' }}>{c.label}</span>
            <span style={{ fontFamily: 'var(--font-mono)' }}>
              {user[`rating_${c.key}`]}{user.provisional?.[c.key] ? '?' : ''}
              <span style={{ color: 'var(--muted)', fontSize: 11 }}> · {user[`games_${c.key}`]}</span>
            </span>
          </MenuItem>
        ))}
        <Divider sx={{ borderColor: 'var(--line-soft)' }} />
        <MenuItem disableRipple sx={{ cursor: 'default', justifyContent: 'space-between', gap: 3, fontSize: 13.5 }}>
          <span style={{ color: 'var(--text-dim)' }}>Puzzles</span>
          <span style={{ fontFamily: 'var(--font-mono)' }}>
            {user.rating_puzzle}{user.provisional?.puzzle ? '?' : ''}
            <span style={{ color: 'var(--muted)', fontSize: 11 }}> · {user.games_puzzle}</span>
          </span>
        </MenuItem>
        <Divider sx={{ borderColor: 'var(--line-soft)' }} />
        <MenuItem
          onClick={() => {
            setAnchor(null)
            void authStore.logout()
          }}
          sx={{ fontSize: 13.5, gap: 1 }}
        >
          <LogOut size={15} /> Log out
        </MenuItem>
      </Menu>
    </>
  )
}
