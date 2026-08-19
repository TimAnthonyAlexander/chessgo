import { useEffect, useState } from 'react'
import {
    Box,
    Button,
    Divider,
    Typography,
    useMediaQuery,
    useTheme,
} from '@mui/material'
import { ChevronDown, Keyboard, LogOut, Palette, UserRound } from 'lucide-react'
import { Link, Outlet, useLocation, useNavigate } from 'react-router-dom'
import { gameSocket } from '../lib/socket'
import { authStore, useAuth } from '../lib/auth'
import { useGlobalShortcutListener, useShortcuts } from '../lib/shortcuts'
import AuthDialog, { type AuthMode } from './AuthDialog'
import ThemeDialog from './ThemeDialog'
import ShortcutsDialog from './ShortcutsDialog'
import Logo from './Logo'
import NavStreak from './NavStreak'
import Footer from './Footer'
import MobileNavDrawer, { type MobileNavSection } from './MobileNavDrawer'
import NotificationBell from './notifications/NotificationBell'
import TitleBadge from './TitleBadge'
import type { RatingCategory, User } from '../api/client'
import IconBtn from './nav/IconBtn'
import { type NavItem, isActive, navItems } from './nav/navModel'
import SidebarNav, { SIDEBAR_W } from './SidebarNav'
import { useSetting } from '../lib/settings'

// Shared through the router Outlet so any routed page (e.g. the homepage
// sign-up CTA) can open the auth modal — login or straight to signup.
export interface LayoutOutletContext {
    openAuth: (mode?: AuthMode) => void
}

// Pages built around a large board need the full viewport — the footer would
// either push the board up or add an awkward scroll, so we drop it on them:
// live play, bot play, puzzles, watch/spectate, and analysis.
const BOARD_ROUTE_PREFIXES = [
    '/game',
    '/bot',
    '/puzzles',
    '/watch',
    '/analysis',
    '/admin',
    '/engine-vs',
    '/editor',
]
const hideFooter = (pathname: string): boolean =>
    BOARD_ROUTE_PREFIXES.some((p) => pathname === p || pathname.startsWith(`${p}/`))

const linkSx = (active: boolean, real: boolean) => ({
    fontSize: 12.5,
    fontWeight: 600,
    letterSpacing: '0.12em',
    textTransform: 'uppercase' as const,
    color: active ? 'var(--accent)' : real ? 'var(--text-dim)' : 'var(--muted)',
    transition: 'color 0.12s ease',
    ...(real ? { '&:hover': { color: 'var(--accent)' } } : { cursor: 'default' }),
})

/** App shell. Two navs, one model:
 *
 *  - Centered board layout — a flat, full-width top bar over the routed page.
 *  - Side-rail board layout — a left sidebar beside the page, ON DESKTOP ONLY.
 *
 *  Below `md` the sidebar never renders and the top bar + drawer are used in both,
 *  because a fixed 232px column is most of a phone screen. That is also why the
 *  top bar is hidden by breakpoint rather than removed when the sidebar is on: the
 *  same render has to serve both widths. */
export default function Layout() {
    const { pathname } = useLocation()
    const { user, status } = useAuth()
    // The board-layout preference picks the nav too: the side rail comes with the
    // sidebar. Desktop only — see the note above.
    const sidebar = useSetting('boardLayout') === 'chesscom'
    const [authOpen, setAuthOpen] = useState(false)
    const [authMode, setAuthMode] = useState<AuthMode>('login')
    const [themeOpen, setThemeOpen] = useState(false)
    const [shortcutsOpen, setShortcutsOpen] = useState(false)
    const openAuth = (mode: AuthMode = 'login') => {
        setAuthMode(mode)
        setAuthOpen(true)
    }

    // The one app-wide keydown listener, plus the always-on globals: `?` opens
    // this dialog (Shift+/ on most layouts — matched by character, not the
    // physical key) and Escape closes it. Escape is only registered while the
    // dialog is actually open, so it never intercepts a page's own Escape
    // handling (e.g. Board.tsx) the rest of the time.
    useGlobalShortcutListener()
    useShortcuts('global', [
        { keys: '?', label: 'Show keyboard shortcuts', group: 'Global', run: () => setShortcutsOpen(true) },
        ...(shortcutsOpen
            ? [
                  {
                      keys: 'Escape',
                      label: 'Close this dialog',
                      group: 'Global',
                      run: () => setShortcutsOpen(false),
                  },
              ]
            : []),
    ])

    // The same nav model the desktop bar uses, flattened for the mobile drawer.
    const sections: MobileNavSection[] = navItems(user?.role === 'admin', !!user, status === 'ready').map((item) =>
        item.kind === 'link'
            ? { label: item.label, to: item.to }
            : {
                  label: item.label,
                  to: item.to,
                  items: item.items.map((c) => ({ label: c.label, to: c.to, state: c.state })),
              },
    )

    // Open the realtime socket + resolve the session once on load.
    useEffect(() => {
        void gameSocket.connect()
        void authStore.init()
        // A socket that stays open never re-registers with the hub, so a game
        // started in another tab or on the phone would go unnoticed here. Re-ask
        // every time this tab is looked at again.
        const onVisible = () => {
            if (document.visibilityState === 'visible') gameSocket.requestResume()
        }
        document.addEventListener('visibilitychange', onVisible)
        return () => document.removeEventListener('visibilitychange', onVisible)
    }, [])

    return (
        <Box sx={{ minHeight: '100%', display: 'flex', alignItems: 'stretch' }}>
            {sidebar && (
                <SidebarNav
                    user={user}
                    ready={status === 'ready'}
                    onOpenAuth={() => openAuth('login')}
                    onOpenTheme={() => setThemeOpen(true)}
                    onOpenShortcuts={() => setShortcutsOpen(true)}
                />
            )}

            <Box
                sx={{
                    flex: 1,
                    minWidth: 0,
                    display: 'flex',
                    flexDirection: 'column',
                    ...(sidebar ? { minHeight: { md: '100dvh' } } : {}),
                    // How much of the viewport is NOT this column — i.e. the nav rail
                    // to its left, 0 whenever there isn't one (top-bar layout, or the
                    // side layout below `md`, where SidebarNav hides itself).
                    //
                    // Pages that break out of their own max-width column to go
                    // full-bleed need this: `100vw` is the whole window, which in the
                    // side layout is the column PLUS the rail, so a naive break-out
                    // runs 232px too wide and slides under the nav. See `fullBleedSx`
                    // in lib/fullBleed.ts, which is the only thing that should read it.
                    '--nav-rail-w': sidebar ? { xs: '0px', md: `${SIDEBAR_W}px` } : '0px',
                }}
            >
            <Box
                component="header"
                sx={{
                    // With the sidebar on, the top bar is the MOBILE nav only.
                    display: sidebar ? { xs: 'flex', md: 'none' } : 'flex',
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
                            sx={{
                                fontFamily: 'var(--font-display)',
                                fontWeight: 600,
                                fontSize: 20,
                                letterSpacing: '-0.01em',
                            }}
                        >
                            chessgo
                        </Box>
                    </Box>
                </Link>

                <Box sx={{ display: { xs: 'none', md: 'flex' }, alignItems: 'center', gap: 3 }}>
                    {navItems(user?.role === 'admin', !!user, status === 'ready').map((item) =>
                        item.kind === 'link' ? (
                            <Box
                                key={item.label}
                                component={Link}
                                to={item.to}
                                sx={linkSx(isActive(item.to, pathname), true)}
                            >
                                {item.label}
                            </Box>
                        ) : (
                            <NavGroup key={item.label} item={item} pathname={pathname} />
                        ),
                    )}
                </Box>

                {/* Same controls, same shapes, as the side rail's foot — both navs
                    go through nav/IconBtn so a bell or a palette is one object with
                    one hover, wherever it is rendered. */}
                <Box sx={{ ml: 'auto', display: 'flex', alignItems: 'center', gap: 0.5 }}>
                    <NavStreak />
                    <NotificationBell />
                    <MobileNavDrawer
                        sections={sections}
                        user={user ? { name: user.name, title: user.title } : null}
                        onLogin={() => openAuth('login')}
                        onLogout={() => void authStore.logout()}
                    />
                    <IconBtn label="Keyboard shortcuts" onClick={() => setShortcutsOpen(true)}>
                        <Keyboard size={17} />
                    </IconBtn>
                    <IconBtn label="Appearance" onClick={() => setThemeOpen(true)}>
                        <Palette size={17} />
                    </IconBtn>
                    {user ? (
                        <UserMenu user={user} />
                    ) : (
                        <Button
                            variant="outlined"
                            color="inherit"
                            size="small"
                            onClick={() => openAuth('login')}
                            sx={{
                                borderColor: 'var(--line)',
                                color: 'var(--text-dim)',
                                px: 1.75,
                                '&:hover': { borderColor: 'var(--accent)', color: 'var(--accent)' },
                            }}
                        >
                            Log in
                        </Button>
                    )}
                </Box>
            </Box>

            {/* With the sidebar there is no top bar, and a short page (the homepage)
                let the footer ride up into view. The PAGE — not just the column —
                has to fill the viewport for that to stop: a 100dvh column still
                shows a 289px footer, because the footer sits inside it. Giving main
                itself the viewport height puts the footer's top edge at exactly the
                fold. Board pages are unaffected: they already fill the viewport and
                hide the footer outright. Desktop only, like the sidebar. */}
            <Box
                component="main"
                sx={{
                    flex: 1,
                    display: 'flex',
                    flexDirection: 'column',
                    ...(sidebar ? { minHeight: { md: '100dvh' } } : {}),
                }}
            >
                <Outlet context={{ openAuth } satisfies LayoutOutletContext} />
            </Box>

            {!hideFooter(pathname) && <Footer />}
            </Box>

            <AuthDialog
                open={authOpen}
                initialMode={authMode}
                onClose={() => setAuthOpen(false)}
            />

            <ThemeDialog open={themeOpen} onClose={() => setThemeOpen(false)} />

            <ShortcutsDialog open={shortcutsOpen} onClose={() => setShortcutsOpen(false)} />
        </Box>
    )
}

// A top-level nav entry that reveals a dropdown ON HOVER. Its own label may be a
// link (Play → "/") while the chevron + items hang below; "Tools" has no own
// destination, so the label is inert and only the dropdown matters.
function NavGroup({
    item,
    pathname,
}: {
    item: Extract<NavItem, { kind: 'menu' }>
    pathname: string
}) {
    const [open, setOpen] = useState(false)
    const groupActive =
        (item.to ? isActive(item.to, pathname) : false) ||
        item.items.some((c) => isActive(c.to, pathname))

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
    const triggerSx = {
        ...linkSx(groupActive, true),
        display: 'flex',
        alignItems: 'center',
        gap: 0.4,
    }

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
                            borderRadius: 'var(--radius)',
                            boxShadow: 'var(--shadow)',
                        }}
                    >
                        {item.items.map((c) => {
                            // Quick-pair leaves are actions (they navigate to "/" only to
                            // start matchmaking), so they never read as the active page.
                            const active = !c.state && isActive(c.to, pathname)
                            return (
                                <Box
                                    key={c.label}
                                    component={Link}
                                    to={c.to}
                                    state={c.state}
                                    onClick={() => setOpen(false)}
                                    sx={{
                                        px: 1.25,
                                        py: 0.9,
                                        borderRadius: 'var(--radius)',
                                        fontSize: 13,
                                        fontWeight: 600,
                                        letterSpacing: '0.04em',
                                        color: active ? 'var(--accent)' : 'var(--text-dim)',
                                        bgcolor: active ? 'var(--accent-soft)' : 'transparent',
                                        transition: 'color .12s ease, background .12s ease',
                                        '&:hover': {
                                            color: 'var(--accent)',
                                            bgcolor: 'var(--line)',
                                        },
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

// Hover-opened account menu (same interaction model as NavGroup): the trigger
// shows the name + blitz rating, hovering reveals the panel. The wrapper holds
// BOTH the trigger and the absolutely-positioned panel (with a `pt` hover
// bridge) so moving from one to the other never crosses a gap that closes it.
function UserMenu({ user }: { user: User }) {
    const [open, setOpen] = useState(false)
    const navigate = useNavigate()
    // Touch/mobile has no hover — there, the button taps open the dropdown
    // instead of jumping straight to the profile. Desktop keeps hover-to-open
    // with a click that navigates to the profile.
    const isMobile = useMediaQuery(useTheme().breakpoints.down('md'))
    const goProfile = () => {
        setOpen(false)
        navigate(`/@/${encodeURIComponent(user.name)}`)
    }
    return (
        <Box
            onMouseEnter={isMobile ? undefined : () => setOpen(true)}
            onMouseLeave={isMobile ? undefined : () => setOpen(false)}
            sx={{ position: 'relative', display: 'flex', alignItems: 'center' }}
        >
            {/* Tap-outside backdrop to dismiss the menu on mobile (no mouseleave). */}
            {isMobile && open && (
                <Box
                    onClick={() => setOpen(false)}
                    sx={{ position: 'fixed', inset: 0, zIndex: 39 }}
                />
            )}
            <Button
                color="inherit"
                size="small"
                onClick={isMobile ? () => setOpen((o) => !o) : goProfile}
                endIcon={
                    <ChevronDown
                        size={15}
                        style={{
                            transform: open ? 'rotate(180deg)' : 'none',
                            transition: 'transform .15s ease',
                        }}
                    />
                }
                sx={{
                    textTransform: 'none',
                    color: 'var(--text)',
                    fontWeight: 600,
                    fontSize: 14,
                    px: 1.25,
                    gap: 0.5,
                }}
            >
                <TitleBadge title={user.title} />
                {user.name}
                <Typography
                    component="span"
                    sx={{
                        fontFamily: 'var(--font-mono)',
                        fontSize: 12,
                        color: 'var(--text-dim)',
                    }}
                >
                    {user.rating_blitz}
                    {user.provisional?.blitz ? '?' : ''}
                </Typography>
            </Button>

            {open && (
                // pt is the hover "bridge" between the trigger and the panel.
                <Box sx={{ position: 'absolute', top: '100%', right: 0, pt: 1, zIndex: 40 }}>
                    <Box
                        sx={{
                            minWidth: 224,
                            display: 'flex',
                            flexDirection: 'column',
                            gap: 0.25,
                            p: 0.75,
                            bgcolor: 'var(--surface)',
                            border: '1px solid var(--line)',
                            borderRadius: 'var(--radius)',
                            boxShadow: 'var(--shadow)',
                        }}
                    >
                        <MenuAction
                            icon={<UserRound size={15} />}
                            label="Profile"
                            onClick={goProfile}
                        />
                        <Divider sx={{ borderColor: 'var(--line-soft)', my: 0.5 }} />
                        {CATEGORIES.map((c) => (
                            <RatingLine
                                key={c.key}
                                label={c.label}
                                value={`${user[`rating_${c.key}`]}${user.provisional?.[c.key] ? '?' : ''}`}
                                games={user[`games_${c.key}`]}
                            />
                        ))}
                        <Divider sx={{ borderColor: 'var(--line-soft)', my: 0.5 }} />
                        <RatingLine
                            label="Puzzles"
                            value={`${user.rating_puzzle}${user.provisional?.puzzle ? '?' : ''}`}
                            games={user.games_puzzle}
                        />
                        <RatingLine
                            label="Chess960"
                            value={`${user.rating_chess960}${user.provisional?.chess960 ? '?' : ''}`}
                            games={user.games_chess960}
                        />
                        <RatingLine
                            label="Duck"
                            value={`${user.rating_duck}${user.provisional?.duck ? '?' : ''}`}
                            games={user.games_duck}
                        />
                        <RatingLine
                            label="Crazyhouse"
                            value={`${user.rating_crazyhouse}${user.provisional?.crazyhouse ? '?' : ''}`}
                            games={user.games_crazyhouse}
                        />
                        <RatingLine
                            label="Antichess"
                            value={`${user.rating_antichess}${user.provisional?.antichess ? '?' : ''}`}
                            games={user.games_antichess}
                        />
                        <Divider sx={{ borderColor: 'var(--line-soft)', my: 0.5 }} />
                        <MenuAction
                            icon={<LogOut size={15} />}
                            label="Log out"
                            onClick={() => {
                                setOpen(false)
                                void authStore.logout()
                            }}
                        />
                    </Box>
                </Box>
            )}
        </Box>
    )
}

// A non-interactive rating readout row inside the account panel.
function RatingLine({ label, value, games }: { label: string; value: string; games: number }) {
    return (
        <Box
            sx={{
                display: 'flex',
                justifyContent: 'space-between',
                alignItems: 'baseline',
                gap: 3,
                px: 1.25,
                py: 0.6,
                fontSize: 13.5,
            }}
        >
            <span style={{ color: 'var(--text-dim)' }}>{label}</span>
            <span style={{ fontFamily: 'var(--font-mono)' }}>
                {value}
                <span style={{ color: 'var(--muted)', fontSize: 11 }}> · {games}</span>
            </span>
        </Box>
    )
}

// A clickable action row (Profile / Log out) inside the account panel.
function MenuAction({
    icon,
    label,
    onClick,
}: {
    icon: React.ReactNode
    label: string
    onClick: () => void
}) {
    return (
        <Box
            onClick={onClick}
            sx={{
                display: 'flex',
                alignItems: 'center',
                gap: 1,
                px: 1.25,
                py: 0.9,
                borderRadius: 'var(--radius)',
                fontSize: 13.5,
                fontWeight: 600,
                color: 'var(--text-dim)',
                cursor: 'pointer',
                transition: 'color .12s ease, background .12s ease',
                '&:hover': { color: 'var(--accent)', bgcolor: 'var(--line)' },
            }}
        >
            {icon}
            {label}
        </Box>
    )
}
