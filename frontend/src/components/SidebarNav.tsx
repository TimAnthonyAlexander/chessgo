import { useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { Box, Button, Tooltip, Typography } from '@mui/material'
import {
    ChevronRight,
    Eye,
    Keyboard,
    LogOut,
    Palette,
    Shield,
    Swords,
    Trophy,
    UserRound,
    Users,
    Wrench,
    type LucideIcon,
} from 'lucide-react'
import { Link, useLocation, useNavigate } from 'react-router-dom'
import { authStore } from '../lib/auth'
import { type NavItem, isActive, navItems } from './nav/navModel'
import Logo from './Logo'
import NavStreak from './NavStreak'
import NotificationBell from './notifications/NotificationBell'
import TitleBadge from './TitleBadge'
import type { User } from '../api/client'

// The DESKTOP left sidebar, shown in place of the top bar when the board layout
// preference is the side rail. Mobile never sees this — a fixed 232px column on a
// phone is most of the screen — so Layout keeps the top bar + drawer below `md`
// and this file is rendered only from `md` up.
//
// It renders the SAME `navItems()` model the top bar renders, so the two can't
// drift into listing different destinations. Only the shape differs: a `menu`
// opens on hover as a flyout panel to the RIGHT of its row, rather than dropping
// below it. Nothing in the column moves when a menu opens, which is the point —
// an inline accordion would shove every entry under it up and down as the pointer
// travels.

/** Sidebar width. Board pages subtract this from the viewport when sizing the
 *  board (see ChessComLayout), so it is exported rather than inlined. */
export const SIDEBAR_W = 232

// One icon per top-level entry. Deliberately only at the top level: sub-items are
// indented text, because a second column of icons inside an expanded section is
// decoration, not navigation. Keyed by the model's labels — an entry with no icon
// here simply renders without one rather than falling back to something generic.
// Flyout sizing, used only to keep a panel opened near the bottom of the column
// inside the viewport.
const ROW_H = 34
const PANEL_PAD = 14

const ICONS: Record<string, LucideIcon> = {
    Play: Swords,
    Tournaments: Trophy,
    Community: Users,
    Watch: Eye,
    Tools: Wrench,
    Admin: Shield,
}

export default function SidebarNav({
    user,
    ready,
    onOpenAuth,
    onOpenTheme,
    onOpenShortcuts,
}: {
    user: User | null
    /** Auth resolved — the model hides session-dependent entries until then. */
    ready: boolean
    onOpenAuth: () => void
    onOpenTheme: () => void
    onOpenShortcuts: () => void
}) {
    const { pathname } = useLocation()
    const items = navItems(user?.role === 'admin', !!user, ready)

    return (
        <Box
            component="nav"
            sx={{
                display: { xs: 'none', md: 'flex' },
                flexDirection: 'column',
                flexShrink: 0,
                width: `${SIDEBAR_W}px`,
                height: '100dvh',
                position: 'sticky',
                top: 0,
                borderRight: '1px solid var(--line-soft)',
                bgcolor: 'var(--bg-2)',
            }}
        >
            <Box
                component={Link}
                to="/"
                aria-label="chessgo home"
                sx={{
                    display: 'flex',
                    alignItems: 'center',
                    gap: 1,
                    px: 2.25,
                    height: 60,
                    flexShrink: 0,
                }}
            >
                <Box sx={{ display: 'flex', color: 'var(--accent)' }}>
                    <Logo size={22} />
                </Box>
                <Box
                    component="span"
                    sx={{
                        fontFamily: 'var(--font-display)',
                        fontWeight: 600,
                        fontSize: 19,
                        letterSpacing: '-0.01em',
                    }}
                >
                    chessgo
                </Box>
            </Box>

            {/* The nav itself scrolls if it ever outgrows the viewport (admin adds
                entries), so the account block below stays reachable. */}
            <Box
                sx={{
                    flex: 1,
                    minHeight: 0,
                    overflowY: 'auto',
                    px: 1.25,
                    py: 1,
                    display: 'flex',
                    flexDirection: 'column',
                    gap: 0.25,
                }}
            >
                {items.map((item) =>
                    item.kind === 'link' ? (
                        <Row
                            key={item.label}
                            to={item.to}
                            label={item.label}
                            Icon={ICONS[item.label]}
                            active={isActive(item.to, pathname)}
                        />
                    ) : (
                        <Section key={item.label} item={item} pathname={pathname} />
                    ),
                )}
            </Box>

            <Box sx={{ flexShrink: 0, borderTop: '1px solid var(--line-soft)', p: 1.25 }}>
                <Box sx={{ display: 'flex', alignItems: 'center', gap: 0.5, px: 0.5, pb: 1 }}>
                    <NavStreak />
                    <NotificationBell />
                    <Box sx={{ flex: 1 }} />
                    <Tooltip title="Keyboard shortcuts">
                        <Box
                            component="button"
                            aria-label="Keyboard shortcuts"
                            onClick={onOpenShortcuts}
                            sx={iconBtnSx}
                        >
                            <Keyboard size={17} />
                        </Box>
                    </Tooltip>
                    <Tooltip title="Appearance">
                        <Box
                            component="button"
                            aria-label="Appearance"
                            onClick={onOpenTheme}
                            sx={iconBtnSx}
                        >
                            <Palette size={17} />
                        </Box>
                    </Tooltip>
                </Box>

                {user ? (
                    <Account user={user} />
                ) : (
                    <Button
                        fullWidth
                        variant="outlined"
                        color="inherit"
                        size="small"
                        onClick={onOpenAuth}
                        sx={{
                            borderColor: 'var(--line)',
                            color: 'var(--text-dim)',
                            '&:hover': { borderColor: 'var(--accent)', color: 'var(--accent)' },
                        }}
                    >
                        Log in
                    </Button>
                )}
            </Box>
        </Box>
    )
}

const iconBtnSx = {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    width: 30,
    height: 30,
    border: 'none',
    borderRadius: '8px',
    bgcolor: 'transparent',
    color: 'var(--text-dim)',
    cursor: 'pointer',
    transition: 'color .12s ease, background .12s ease',
    '&:hover': { color: 'var(--accent)', bgcolor: 'var(--line)' },
}

/** One navigable row. The single row shape in this file: top-level entries pass an
 *  icon, sub-items pass none and indent instead. */
function Row({
    to,
    state,
    label,
    Icon,
    active,
    indent = false,
    onClick,
}: {
    to: string
    state?: unknown
    label: string
    Icon?: LucideIcon
    active: boolean
    indent?: boolean
    onClick?: () => void
}) {
    return (
        <Box
            component={Link}
            to={to}
            state={state}
            onClick={onClick}
            sx={{
                display: 'flex',
                alignItems: 'center',
                gap: 1.25,
                pl: indent ? 4.25 : 1.25,
                pr: 1.25,
                py: indent ? 0.7 : 0.9,
                borderRadius: '8px',
                fontSize: indent ? 13 : 13.5,
                fontWeight: 600,
                letterSpacing: '0.02em',
                color: active ? 'var(--accent)' : 'var(--text-dim)',
                bgcolor: active ? 'var(--accent-soft)' : 'transparent',
                transition: 'color .12s ease, background .12s ease',
                '&:hover': { color: 'var(--accent)', bgcolor: active ? 'var(--accent-soft)' : 'var(--line)' },
            }}
        >
            {Icon && (
                <Box sx={{ display: 'flex', flexShrink: 0 }}>
                    <Icon size={17} />
                </Box>
            )}
            <Box component="span" sx={{ minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                {label}
            </Box>
        </Box>
    )
}

/** A `menu` entry as a hover FLYOUT to the right of its row.
 *
 *  The panel is measured off the row and PORTALLED to the body. Both halves of
 *  that are load-bearing. Measured-and-fixed, because the nav list is a scroll
 *  container (`overflowY: auto`, so a tall admin nav stays reachable) and an
 *  absolutely-positioned child of one is clipped at its edge — precisely where the
 *  flyout needs to appear. Portalled, because the sidebar is `position: sticky`,
 *  which opens its own stacking context: a z-index set inside it competes only
 *  with its siblings, so the panel painted UNDER the board instead of over it. Out
 *  at the body there is no ancestor overflow and no borrowed stacking context.
 *
 *  The row itself still navigates when the group has its own destination (Play →
 *  "/"); hovering is what opens the menu, so a group without one (Tools) is
 *  reachable the same way. */
function Section({
    item,
    pathname,
}: {
    item: Extract<NavItem, { kind: 'menu' }>
    pathname: string
}) {
    const rowRef = useRef<HTMLDivElement | null>(null)
    const [pos, setPos] = useState<{ top: number; left: number } | null>(null)
    const navigate = useNavigate()

    // Quick-pair leaves navigate to "/" only to start matchmaking, so they never
    // count as "the current page" — otherwise Play would read as active on the
    // homepage through four different entries at once.
    const holdsCurrent =
        (item.to ? isActive(item.to, pathname) : false) ||
        item.items.some((c) => !c.state && isActive(c.to, pathname))

    function open() {
        const r = rowRef.current?.getBoundingClientRect()
        if (!r) return
        // Rough panel height, used only to keep a menu near the bottom of the
        // column from running off the viewport. Erring by a row is harmless — the
        // panel scrolls internally if the estimate is short.
        const est = item.items.length * ROW_H + PANEL_PAD
        setPos({
            top: Math.max(8, Math.min(r.top, window.innerHeight - est - 8)),
            left: r.right,
        })
    }

    const Icon = ICONS[item.label]

    return (
        <Box
            ref={rowRef}
            onMouseEnter={open}
            onMouseLeave={() => setPos(null)}
            sx={{ position: 'relative' }}
        >
            <Box
                component={item.to ? 'button' : 'div'}
                onClick={item.to ? () => navigate(item.to as string) : undefined}
                sx={{
                    display: 'flex',
                    alignItems: 'center',
                    gap: 1.25,
                    width: '100%',
                    pl: 1.25,
                    pr: 1,
                    py: 0.9,
                    border: 'none',
                    borderRadius: '8px',
                    font: 'inherit',
                    fontSize: 13.5,
                    fontWeight: 600,
                    letterSpacing: '0.02em',
                    textAlign: 'left',
                    cursor: item.to ? 'pointer' : 'default',
                    color: holdsCurrent || pos ? 'var(--accent)' : 'var(--text-dim)',
                    bgcolor: holdsCurrent
                        ? 'var(--accent-soft)'
                        : pos
                          ? 'var(--line)'
                          : 'transparent',
                    transition: 'color .12s ease, background .12s ease',
                }}
            >
                {Icon && (
                    <Box sx={{ display: 'flex', flexShrink: 0 }}>
                        <Icon size={17} />
                    </Box>
                )}
                <Box
                    component="span"
                    sx={{
                        minWidth: 0,
                        overflow: 'hidden',
                        textOverflow: 'ellipsis',
                        whiteSpace: 'nowrap',
                    }}
                >
                    {item.label}
                </Box>
                <ChevronRight
                    size={14}
                    style={{ marginLeft: 'auto', flexShrink: 0, color: 'var(--muted)' }}
                />
            </Box>

            {pos &&
                createPortal(
                    // The left padding is a hover BRIDGE: it spans the gap between
                    // the row and the panel so travelling across it never leaves the
                    // hoverable area and closes the menu. The handlers are repeated
                    // here because, portalled, this is no longer a DOM descendant of
                    // the row — React would still bubble the events, but the pointer
                    // physically leaves the row, firing its mouseleave.
                    <Box
                        onMouseEnter={() => setPos(pos)}
                        onMouseLeave={() => setPos(null)}
                        sx={{
                            position: 'fixed',
                            top: `${pos.top}px`,
                            left: `${pos.left}px`,
                            pl: '8px',
                            zIndex: 1200,
                        }}
                    >
                        <Box
                            sx={{
                                minWidth: 196,
                                maxHeight: 'calc(100dvh - 16px)',
                                overflowY: 'auto',
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
                            {item.items.map((c) => (
                                <Row
                                    key={c.label}
                                    to={c.to}
                                    state={c.state}
                                    label={c.label}
                                    active={!c.state && isActive(c.to, pathname)}
                                    onClick={() => setPos(null)}
                                />
                            ))}
                        </Box>
                    </Box>,
                    document.body,
                )}
        </Box>
    )
}

/** The account block: identity, and the two destinations the top bar's user menu
 *  also offers — the profile, and logging out. Ratings are deliberately not
 *  repeated here; the profile this links to is where they live. */
function Account({ user }: { user: User }) {
    const navigate = useNavigate()
    return (
        <Box sx={{ display: 'flex', flexDirection: 'column', gap: 0.25 }}>
            <Box
                component="button"
                onClick={() => navigate(`/@/${encodeURIComponent(user.name)}`)}
                sx={{
                    display: 'flex',
                    alignItems: 'center',
                    gap: 1.25,
                    width: '100%',
                    px: 1.25,
                    py: 0.9,
                    border: 'none',
                    borderRadius: '8px',
                    bgcolor: 'transparent',
                    color: 'var(--text)',
                    font: 'inherit',
                    cursor: 'pointer',
                    textAlign: 'left',
                    transition: 'background .12s ease',
                    '&:hover': { bgcolor: 'var(--line)' },
                }}
            >
                <Box
                    sx={{
                        display: 'flex',
                        alignItems: 'center',
                        justifyContent: 'center',
                        width: 28,
                        height: 28,
                        flexShrink: 0,
                        borderRadius: '8px',
                        border: '1px solid var(--line)',
                        color: 'var(--text-dim)',
                    }}
                >
                    <UserRound size={15} />
                </Box>
                <Box sx={{ display: 'flex', alignItems: 'center', gap: 0.6, minWidth: 0 }}>
                    <TitleBadge title={user.title} />
                    <Typography
                        sx={{
                            fontFamily: 'var(--font-display)',
                            fontWeight: 700,
                            fontSize: 13.5,
                            overflow: 'hidden',
                            textOverflow: 'ellipsis',
                            whiteSpace: 'nowrap',
                        }}
                    >
                        {user.name}
                    </Typography>
                </Box>
            </Box>
            <Box
                component="button"
                onClick={() => void authStore.logout()}
                sx={{
                    display: 'flex',
                    alignItems: 'center',
                    gap: 1.25,
                    width: '100%',
                    px: 1.25,
                    py: 0.7,
                    border: 'none',
                    borderRadius: '8px',
                    bgcolor: 'transparent',
                    color: 'var(--text-dim)',
                    font: 'inherit',
                    fontSize: 13,
                    fontWeight: 600,
                    cursor: 'pointer',
                    textAlign: 'left',
                    transition: 'color .12s ease, background .12s ease',
                    '&:hover': { color: 'var(--accent)', bgcolor: 'var(--line)' },
                }}
            >
                <Box sx={{ display: 'flex', flexShrink: 0 }}>
                    <LogOut size={15} />
                </Box>
                Log out
            </Box>
        </Box>
    )
}
