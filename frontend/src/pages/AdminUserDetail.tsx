import { useEffect, useState } from 'react'
import { Box, CircularProgress, Typography } from '@mui/material'
import { ArrowLeft } from 'lucide-react'
import { Link as RouterLink, useParams } from 'react-router-dom'
import { ApiError, getAdminUser, type AdminUserDetail as AdminUserDetailData } from '../api/client'
import UserDetailHeader from '../components/admin/users/UserDetailHeader'
import UserRatingsGrid from '../components/admin/users/UserRatingsGrid'
import UserFlagRollupCard from '../components/admin/users/UserFlagRollupCard'
import UserRecentGames from '../components/admin/users/UserRecentGames'

/** Admin single-account drill-down: header + all ratings + (if flagged) an
 * anti-cheat rollup summary + recent games. Handles loading, error, and
 * not-found states, with a back link to the directory. */
export default function AdminUserDetail() {
    const { id = '' } = useParams<{ id: string }>()
    const [data, setData] = useState<AdminUserDetailData | null>(null)
    const [loading, setLoading] = useState(true)
    const [error, setError] = useState<string | null>(null)
    const [notFound, setNotFound] = useState(false)

    useEffect(() => {
        let cancelled = false
        setLoading(true)
        setError(null)
        setNotFound(false)
        getAdminUser(id)
            .then((d) => {
                if (!cancelled) setData(d)
            })
            .catch((e) => {
                if (cancelled) return
                if (e instanceof ApiError && e.status === 404) setNotFound(true)
                else setError((e as Error).message)
            })
            .finally(() => {
                if (!cancelled) setLoading(false)
            })
        return () => {
            cancelled = true
        }
    }, [id])

    return (
        <Box sx={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
            <Box
                component={RouterLink}
                to="/admin/users"
                sx={{
                    display: 'inline-flex',
                    alignItems: 'center',
                    gap: 0.5,
                    fontSize: 13,
                    fontWeight: 600,
                    color: 'var(--text-dim)',
                    textDecoration: 'none',
                    width: 'fit-content',
                    '&:hover': { color: 'var(--accent)' },
                }}
            >
                <ArrowLeft size={15} />
                Back to users
            </Box>

            {loading ? (
                <Box sx={{ display: 'flex', justifyContent: 'center', p: 6 }}>
                    <CircularProgress size={22} sx={{ color: 'var(--accent)' }} />
                </Box>
            ) : notFound ? (
                <Centered>Account not found.</Centered>
            ) : error || !data ? (
                <Centered tone="error">{error ?? 'Account unavailable'}</Centered>
            ) : (
                <Box sx={{ display: 'flex', flexDirection: 'column', gap: 2.5 }}>
                    <UserDetailHeader user={data.user} rollup={data.flag_rollup} />
                    <UserRatingsGrid user={data.user} />
                    {data.flag_rollup && <UserFlagRollupCard rollup={data.flag_rollup} />}
                    <UserRecentGames games={data.recent_games} userId={data.user.id} />
                </Box>
            )}
        </Box>
    )
}

function Centered({ children, tone }: { children: React.ReactNode; tone?: 'error' }) {
    return (
        <Box
            sx={{
                border: '1px solid var(--line-soft)',
                borderRadius: '12px',
                bgcolor: 'var(--surface)',
                py: 6,
                textAlign: 'center',
            }}
        >
            <Typography sx={{ fontSize: 14, color: tone === 'error' ? '#ca4a4a' : 'var(--muted)' }}>
                {children}
            </Typography>
        </Box>
    )
}
