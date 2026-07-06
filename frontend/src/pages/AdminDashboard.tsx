import { useEffect, useState } from 'react'
import { Box, CircularProgress, Typography } from '@mui/material'
import { getAdminDashboard, type AdminDashboard as AdminDashboardData } from '../api/client'
import DashboardStats from '../components/admin/dashboard/DashboardStats'
import FlagCategoryBreakdown from '../components/admin/dashboard/FlagCategoryBreakdown'
import FlagStatusBreakdown from '../components/admin/dashboard/FlagStatusBreakdown'
import ScanBacklogCard from '../components/admin/dashboard/ScanBacklogCard'
import LiveStatsCard from '../components/admin/dashboard/LiveStatsCard'

/** The admin dashboard: KPI tiles over a responsive grid of anti-cheat + live
 * cards. Fetches the aggregate once on mount with loading/error/empty handling. */
export default function AdminDashboard() {
    const [data, setData] = useState<AdminDashboardData | null>(null)
    const [error, setError] = useState<string | null>(null)

    useEffect(() => {
        let cancelled = false
        setError(null)
        getAdminDashboard()
            .then((d) => {
                if (!cancelled) setData(d)
            })
            .catch((e) => {
                if (!cancelled) setError((e as Error).message)
            })
        return () => {
            cancelled = true
        }
    }, [])

    if (error) {
        return (
            <Box sx={{ display: 'flex', justifyContent: 'center', p: 6 }}>
                <Typography sx={{ fontSize: 14, color: '#ca4a4a' }}>{error}</Typography>
            </Box>
        )
    }

    if (!data) {
        return (
            <Box sx={{ display: 'flex', justifyContent: 'center', p: 6 }}>
                <CircularProgress size={22} sx={{ color: 'var(--accent)' }} />
            </Box>
        )
    }

    return (
        <Box sx={{ display: 'flex', flexDirection: 'column', gap: 2.5 }}>
            <DashboardStats data={data} />

            <Box
                sx={{
                    display: 'grid',
                    gap: 2.5,
                    gridTemplateColumns: { xs: '1fr', md: 'minmax(0, 1fr) minmax(0, 1fr)' },
                }}
            >
                <FlagCategoryBreakdown data={data.anticheat.events_by_category} />
                <FlagStatusBreakdown data={data.anticheat.by_status} />
                <ScanBacklogCard data={data.games} />
                <LiveStatsCard data={data.live} />
            </Box>
        </Box>
    )
}
