import { Box } from '@mui/material'
import { Link, useLocation } from 'react-router-dom'
import { LayoutDashboard, ShieldAlert, Users } from 'lucide-react'
import type { ReactNode } from 'react'

interface AdminTab {
    label: string
    to: string
    icon: ReactNode
}

const TABS: AdminTab[] = [
    { label: 'Dashboard', to: '/admin', icon: <LayoutDashboard size={16} /> },
    { label: 'Users', to: '/admin/users', icon: <Users size={16} /> },
    { label: 'Anticheat', to: '/admin/anticheat', icon: <ShieldAlert size={16} /> },
]

/** True when `pathname` belongs to a tab's section. The Dashboard tab owns the
 * exact `/admin` index only; the others own their prefix (incl. nested detail). */
function tabActive(tab: AdminTab, pathname: string): boolean {
    if (tab.to === '/admin') return pathname === '/admin' || pathname === '/admin/'
    return pathname === tab.to || pathname.startsWith(`${tab.to}/`)
}

/** The admin section's top tab bar. Styled to match the app's flat nav idiom
 * (uppercase, letter-spaced, accent underline) rather than MUI's default look. */
export default function AdminTabs() {
    const { pathname } = useLocation()

    return (
        <Box
            sx={{
                display: 'flex',
                gap: { xs: 0.5, sm: 1 },
                borderBottom: '1px solid var(--line-soft)',
                mb: { xs: 2, md: 3 },
            }}
        >
            {TABS.map((tab) => {
                const active = tabActive(tab, pathname)
                return (
                    <Box
                        key={tab.to}
                        component={Link}
                        to={tab.to}
                        sx={{
                            display: 'flex',
                            alignItems: 'center',
                            gap: 0.75,
                            px: { xs: 1.25, sm: 1.75 },
                            py: 1.25,
                            fontSize: 12.5,
                            fontWeight: 600,
                            letterSpacing: '0.1em',
                            textTransform: 'uppercase',
                            color: active ? 'var(--accent)' : 'var(--text-dim)',
                            borderBottom: '2px solid',
                            borderColor: active ? 'var(--accent)' : 'transparent',
                            mb: '-1px',
                            transition: 'color .12s ease, border-color .12s ease',
                            '&:hover': { color: 'var(--accent)' },
                        }}
                    >
                        {tab.icon}
                        {tab.label}
                    </Box>
                )
            })}
        </Box>
    )
}
