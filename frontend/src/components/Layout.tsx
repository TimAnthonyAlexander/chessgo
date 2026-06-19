import { useEffect, useState } from 'react'
import { Box, Button, Divider, Menu, MenuItem, Typography } from '@mui/material'
import { ChevronDown, LogOut, Search, UserRound } from 'lucide-react'
import { Link, Outlet, useLocation, useNavigate } from 'react-router-dom'
import { gameSocket } from '../lib/socket'
import { authStore, useAuth } from '../lib/auth'
import AuthDialog from './AuthDialog'
import Logo from './Logo'
import type { RatingCategory, User } from '../api/client'

// Nav model. A `link` is a plain top-level destination; a `menu` is a hover
// dropdown of leaves whose own label may ALSO be a destination (e.g. "Play"
// opens Online/Computer but itself goes to "/").
interface Leaf {
  label: string
  to: string
}
type NavItem =
  | { kind: 'link'; label: string; to: string }
  | { kind: 'menu'; label: string; to?: string; items: Leaf[] }

function navItems(isAdmin: boolean): NavItem[] {
  const tools: Leaf[] = [
    { label: 'Analysis', to: '/analysis' },
    ...(isAdmin ? [{ label: 'Engine v Engine', to: '/admin/engine-vs' }] : []),
    { label: 'Editor', to: '/editor' },
  ]
  return [
    {
      kind: 'menu',
      label: 'Play',
      to: '/',
      items: [
        { label: 'Online', to: '/' },
        { label: 'Computer', to: '/bot' },
      ],
    },
    { kind: 'link', label: 'Puzzles', to: '/puzzles' },
    { kind: 'link', label: 'Watch', to: '/watch' },
    { kind: 'menu', label: 'Tools', items: tools },
  ]
}

const isActive = (to: string, pathname: string): boolean =>
  to === '/' ? pathname === '/' : pathname.startsWith(to)

const linkSx = (active: boolean, real: boolean) => ({
  fontSize: 12.5,
  fontWeight: 600,
  letterSpacing: '0.12em',
  textTransform: 'uppercase' as const,
  color: active ? 'var(--accent)' : real ? 'var(--text-dim)' : 'var(--muted)',
  transition: 'color 0.12s ease',
  ...(real ? { '&:hover': { color: 'var(--accent)' } } : { cursor: 'default' }),
})

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
          {navItems(user?.role === 'admin').map((item) =>
            item.kind === 'link' ? (
              <Box key={item.label} component={Link} to={item.to} sx={linkSx(isActive(item.to, pathname), true)}>
                {item.label}
              </Box>
            ) : (
              <NavGroup key={item.label} item={item} pathname={pathname} />
            ),
          )}
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

// A top-level nav entry that reveals a dropdown ON HOVER. Its own label may be a
// link (Play → "/") while the chevron + items hang below; "Tools" has no own
// destination, so the label is inert and only the dropdown matters.
function NavGroup({ item, pathname }: { item: Extract<NavItem, { kind: 'menu' }>; pathname: string }) {
  const [open, setOpen] = useState(false)
  const groupActive =
    (item.to ? isActive(item.to, pathname) : false) || item.items.some((c) => isActive(c.to, pathname))

  // Label + chevron share one hit target. When the group has its own
  // destination (Play → "/"), that target is a single Link, so clicking the
  // triangle navigates just like clicking the text. "Tools" has no destination,
  // so it stays an inert span.
  const trigger = (
    <>
      {item.label}
      <ChevronDown
        size={13}
        style={{
          color: groupActive ? 'var(--accent)' : 'var(--muted)',
          transform: open ? 'rotate(180deg)' : 'none',
          transition: 'transform .15s ease',
        }}
      />
    </>
  )
  const triggerSx = { ...linkSx(groupActive, true), display: 'flex', alignItems: 'center', gap: 0.4 }

  return (
    <Box
      onMouseEnter={() => setOpen(true)}
      onMouseLeave={() => setOpen(false)}
      sx={{ position: 'relative', display: 'flex', alignItems: 'center' }}
    >
      {item.to ? (
        <Box component={Link} to={item.to} sx={triggerSx}>
          {trigger}
        </Box>
      ) : (
        <Box component="span" sx={{ ...triggerSx, cursor: 'default' }}>
          {trigger}
        </Box>
      )}

      {open && (
        // pt creates a hover "bridge" so moving from the label to the panel never
        // crosses a gap that would close the menu.
        <Box sx={{ position: 'absolute', top: '100%', left: 0, pt: 1, zIndex: 40 }}>
          <Box
            sx={{
              minWidth: 184,
              display: 'flex',
              flexDirection: 'column',
              gap: 0.25,
              p: 0.75,
              bgcolor: 'var(--surface)',
              border: '1px solid var(--line)',
              borderRadius: '11px',
              boxShadow: '0 20px 50px -24px rgba(0,0,0,0.85)',
            }}
          >
            {item.items.map((c) => {
              const active = isActive(c.to, pathname)
              return (
                <Box
                  key={c.label}
                  component={Link}
                  to={c.to}
                  onClick={() => setOpen(false)}
                  sx={{
                    px: 1.25,
                    py: 0.9,
                    borderRadius: '8px',
                    fontSize: 13,
                    fontWeight: 600,
                    letterSpacing: '0.04em',
                    color: active ? 'var(--accent)' : 'var(--text-dim)',
                    bgcolor: active ? 'var(--accent-soft)' : 'transparent',
                    transition: 'color .12s ease, background .12s ease',
                    '&:hover': { color: 'var(--accent)', bgcolor: 'var(--line)' },
                  }}
                >
                  {c.label}
                </Box>
              )
            })}
          </Box>
        </Box>
      )}
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
  const navigate = useNavigate()
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
        <MenuItem
          onClick={() => {
            setAnchor(null)
            navigate(`/@/${encodeURIComponent(user.name)}`)
          }}
          sx={{ fontSize: 13.5, gap: 1 }}
        >
          <UserRound size={15} /> View profile
        </MenuItem>
        <Divider sx={{ borderColor: 'var(--line-soft)' }} />
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
