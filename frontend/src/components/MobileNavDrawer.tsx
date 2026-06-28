import { useState } from 'react'
import { Box, Drawer, IconButton, Typography, Divider } from '@mui/material'
import { Link } from 'react-router-dom'
import { Menu, X, LogOut, UserRound } from 'lucide-react'

// A presentational, prop-driven mobile nav. The parent Layout owns the nav model
// + auth; this component only renders a hamburger (mobile-only) that toggles a
// slide-in Drawer, and closes itself on any navigation / backdrop click.

export interface MobileNavLink {
    label: string
    to: string
}

export interface MobileNavSection {
    label: string
    to?: string
    items?: MobileNavLink[]
}

export interface MobileNavDrawerProps {
    sections: MobileNavSection[]
    user: { name: string } | null
    onLogin: () => void
    onLogout: () => void
}

// A single tappable destination row. Generous py keeps the hit target ≥44px for
// comfortable touch use; hover/active tint to the accent.
function NavRow({ label, to, onNavigate }: { label: string; to: string; onNavigate: () => void }) {
    return (
        <Box
            component={Link}
            to={to}
            onClick={onNavigate}
            sx={{
                display: 'flex',
                alignItems: 'center',
                minHeight: 44,
                px: 2,
                py: 1.25,
                fontSize: 15,
                fontWeight: 600,
                letterSpacing: '0.01em',
                color: 'var(--text-dim)',
                borderRadius: '8px',
                transition: 'color .12s ease, background .12s ease',
                '&:hover, &:active': { color: 'var(--accent)', bgcolor: 'var(--accent-soft)' },
            }}
        >
            {label}
        </Box>
    )
}

// An uppercase mono section header. When the section is itself a destination
// (has `to`), the header is a link too; otherwise it is an inert label.
function SectionHeader({
    label,
    to,
    onNavigate,
}: {
    label: string
    to?: string
    onNavigate: () => void
}) {
    const sx = {
        display: 'block',
        px: 2,
        pt: 2,
        pb: 0.5,
        fontFamily: 'var(--font-mono)',
        fontSize: 11,
        fontWeight: 600,
        letterSpacing: '0.16em',
        textTransform: 'uppercase' as const,
        color: 'var(--muted)',
        transition: 'color .12s ease',
        ...(to ? { '&:hover, &:active': { color: 'var(--accent)' } } : {}),
    }
    return to ? (
        <Box component={Link} to={to} onClick={onNavigate} sx={sx}>
            {label}
        </Box>
    ) : (
        <Box component="span" sx={sx}>
            {label}
        </Box>
    )
}

/** Mobile-only hamburger + slide-in nav drawer. Self-hides at the `md` breakpoint. */
export default function MobileNavDrawer({
    sections,
    user,
    onLogin,
    onLogout,
}: MobileNavDrawerProps) {
    const [open, setOpen] = useState(false)
    const close = () => setOpen(false)

    return (
        <>
            <IconButton
                aria-label="Open navigation menu"
                onClick={() => setOpen(true)}
                sx={{ display: { xs: 'inline-flex', md: 'none' }, color: 'var(--text-dim)' }}
            >
                <Menu size={22} />
            </IconButton>

            <Drawer
                anchor="left"
                open={open}
                onClose={close}
                slotProps={{
                    paper: {
                        sx: {
                            width: 280,
                            bgcolor: 'var(--surface)',
                            borderRight: '1px solid var(--line)',
                            backgroundImage: 'none',
                        },
                    },
                }}
            >
                <Box sx={{ display: 'flex', flexDirection: 'column', height: '100%' }}>
                    {/* Header: wordmark + close. */}
                    <Box
                        sx={{
                            display: 'flex',
                            alignItems: 'center',
                            justifyContent: 'space-between',
                            px: 2,
                            py: 1.5,
                            borderBottom: '1px solid var(--line-soft)',
                        }}
                    >
                        <Typography
                            component="span"
                            sx={{
                                fontFamily: 'var(--font-display)',
                                fontWeight: 600,
                                fontSize: 20,
                                color: 'var(--text)',
                                letterSpacing: '-0.01em',
                            }}
                        >
                            chessgo
                        </Typography>
                        <IconButton
                            aria-label="Close navigation menu"
                            onClick={close}
                            sx={{ color: 'var(--text-dim)' }}
                        >
                            <X size={20} />
                        </IconButton>
                    </Box>

                    {/* Nav sections. */}
                    <Box sx={{ flex: 1, overflowY: 'auto', px: 1, py: 1 }}>
                        {sections.map((section) =>
                            section.items && section.items.length > 0 ? (
                                <Box key={section.label} sx={{ mb: 0.5 }}>
                                    <SectionHeader
                                        label={section.label}
                                        to={section.to}
                                        onNavigate={close}
                                    />
                                    {section.items.map((item) => (
                                        <NavRow
                                            key={item.label}
                                            label={item.label}
                                            to={item.to}
                                            onNavigate={close}
                                        />
                                    ))}
                                </Box>
                            ) : section.to ? (
                                <NavRow
                                    key={section.label}
                                    label={section.label}
                                    to={section.to}
                                    onNavigate={close}
                                />
                            ) : null,
                        )}
                    </Box>

                    {/* Auth footer. */}
                    <Box sx={{ mt: 'auto' }}>
                        <Divider sx={{ borderColor: 'var(--line-soft)' }} />
                        <Box sx={{ p: 1 }}>
                            {user ? (
                                <>
                                    <Box
                                        sx={{
                                            display: 'flex',
                                            alignItems: 'center',
                                            gap: 1,
                                            px: 2,
                                            py: 1,
                                            fontSize: 14,
                                            fontWeight: 600,
                                            color: 'var(--text)',
                                        }}
                                    >
                                        <UserRound size={16} color="var(--text-dim)" />
                                        {user.name}
                                    </Box>
                                    <Box
                                        onClick={() => {
                                            onLogout()
                                            close()
                                        }}
                                        sx={{
                                            display: 'flex',
                                            alignItems: 'center',
                                            gap: 1,
                                            minHeight: 44,
                                            px: 2,
                                            py: 1.25,
                                            fontSize: 14.5,
                                            fontWeight: 600,
                                            color: 'var(--text-dim)',
                                            borderRadius: '8px',
                                            cursor: 'pointer',
                                            transition: 'color .12s ease, background .12s ease',
                                            '&:hover, &:active': {
                                                color: 'var(--accent)',
                                                bgcolor: 'var(--accent-soft)',
                                            },
                                        }}
                                    >
                                        <LogOut size={16} />
                                        Log out
                                    </Box>
                                </>
                            ) : (
                                <Box
                                    onClick={() => {
                                        onLogin()
                                        close()
                                    }}
                                    sx={{
                                        display: 'flex',
                                        alignItems: 'center',
                                        gap: 1,
                                        minHeight: 44,
                                        px: 2,
                                        py: 1.25,
                                        fontSize: 14.5,
                                        fontWeight: 600,
                                        color: 'var(--accent)',
                                        borderRadius: '8px',
                                        cursor: 'pointer',
                                        transition: 'background .12s ease',
                                        '&:hover, &:active': { bgcolor: 'var(--accent-soft)' },
                                    }}
                                >
                                    <UserRound size={16} />
                                    Log in
                                </Box>
                            )}
                        </Box>
                    </Box>
                </Box>
            </Drawer>
        </>
    )
}
