import { Box, CircularProgress, Typography } from '@mui/material'
import { Outlet } from 'react-router-dom'
import { useAuth } from '../lib/auth'
import AdminTabs from '../components/admin/AdminTabs'

/** The guarded admin shell: resolves the session, gates on the admin role, then
 * renders the section tab bar over the routed admin page (`<Outlet/>`). Mirrors
 * the in-page admin gate the Engine-vs-Engine page uses, for consistency. */
export default function Admin() {
    const { user, status } = useAuth()

    if (status === 'loading') {
        return (
            <Box
                sx={{
                    flex: 1,
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'center',
                    p: 6,
                }}
            >
                <CircularProgress size={22} sx={{ color: 'var(--accent)' }} />
            </Box>
        )
    }

    if (user?.role !== 'admin') {
        return (
            <Box
                sx={{
                    flex: 1,
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'center',
                    p: 4,
                }}
            >
                <Typography sx={{ fontSize: 14, color: 'var(--text-dim)' }}>
                    This page is for admins only.
                </Typography>
            </Box>
        )
    }

    return (
        <Box
            sx={{
                flex: 1,
                display: 'flex',
                justifyContent: 'center',
                px: { xs: 1.5, md: 3 },
                py: { xs: 2, md: 3.5 },
            }}
        >
            <Box sx={{ width: '100%', maxWidth: 1200 }}>
                <AdminTabs />
                <Outlet />
            </Box>
        </Box>
    )
}
