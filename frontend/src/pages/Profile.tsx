import { useCallback, useEffect, useMemo, useState } from 'react'
import { Box, Typography } from '@mui/material'
import { useParams } from 'react-router-dom'
import {
    ApiError,
    getProfile,
    getProfileGames,
    type Profile as ProfileData,
    type ProfileGame,
} from '../api/client'
import { useAuth } from '../lib/auth'
import IdentityHero from '../components/profile/IdentityHero'
import RecordPanel from '../components/profile/RecordPanel'
import RatingsPanel from '../components/profile/RatingsPanel'
import GamesPanel from '../components/profile/GamesPanel'
import ProfileSkeleton from '../components/profile/ProfileSkeleton'
import { primaryRating, ratingSeries } from '../components/profile/shared'

export default function Profile() {
    const { name = '' } = useParams<{ name: string }>()
    const { user } = useAuth()

    const [data, setData] = useState<ProfileData | null>(null)
    const [games, setGames] = useState<ProfileGame[]>([])
    const [hasMore, setHasMore] = useState(false)
    const [loading, setLoading] = useState(true)
    const [loadingMore, setLoadingMore] = useState(false)
    const [error, setError] = useState<string | null>(null)

    useEffect(() => {
        let cancelled = false
        setLoading(true)
        setError(null)
        getProfile(name)
            .then((p) => {
                if (cancelled) return
                setData(p)
                setGames(p.games)
                setHasMore(p.hasMore)
                setLoading(false)
            })
            .catch((e) => {
                if (cancelled) return
                setError(
                    e instanceof ApiError && e.status === 404
                        ? 'Player not found'
                        : (e as Error).message,
                )
                setLoading(false)
            })
        return () => {
            cancelled = true
        }
    }, [name])

    const loadMore = useCallback(() => {
        if (!data || loadingMore) return
        setLoadingMore(true)
        getProfileGames(data.name, games.length)
            .then((page) => {
                setGames((prev) => [...prev, ...page.games])
                setHasMore(page.hasMore)
            })
            .catch(() => {
                /* leave the list as-is on a transient error */
            })
            .finally(() => setLoadingMore(false))
    }, [data, games.length, loadingMore])

    // Reconstruct the per-category rating trend from the loaded games, and pick
    // the player's headline (most-played) rating for the hero call-out.
    const primary = useMemo(() => {
        if (!data) return null
        return primaryRating(data, ratingSeries(games, data.id))
    }, [data, games])

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
            <Box sx={{ width: '100%', maxWidth: 1120 }}>
                {loading ? (
                    <ProfileSkeleton />
                ) : error || !data ? (
                    <Centered tone="error">{error ?? 'Profile unavailable'}</Centered>
                ) : (
                    <Box sx={{ display: 'flex', flexDirection: 'column', gap: 2.5 }}>
                        <IdentityHero
                            profile={data}
                            isSelf={user?.id === data.id}
                            primary={primary}
                            lastActive={games[0]?.created_at ?? null}
                        />

                        <Box
                            sx={{
                                display: 'grid',
                                gridTemplateColumns: {
                                    xs: '1fr',
                                    lg: 'minmax(0, 300px) minmax(0, 1fr)',
                                },
                                gap: 2.5,
                            }}
                        >
                            {/* Sidebar: record + ratings. On desktop the grid
                                stretches this column to the games card's height,
                                and space-between pins Ratings to the bottom so the
                                two columns end level. */}
                            <Box
                                sx={{
                                    display: 'flex',
                                    flexDirection: 'column',
                                    gap: 2.5,
                                    justifyContent: 'space-between',
                                }}
                            >
                                <RecordPanel record={data.record} />
                                <RatingsPanel profile={data} primaryKey={primary?.key ?? null} />
                            </Box>

                            {/* Main: filterable game history. */}
                            <GamesPanel
                                games={games}
                                userId={data.id}
                                hasMore={hasMore}
                                loadingMore={loadingMore}
                                onLoadMore={loadMore}
                            />
                        </Box>
                    </Box>
                )}
            </Box>
        </Box>
    )
}

function Centered({ children, tone }: { children: React.ReactNode; tone?: 'error' }) {
    return (
        <Box
            sx={{ flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center', p: 4 }}
        >
            <Typography
                sx={{ fontSize: 14, color: tone === 'error' ? '#ca4a4a' : 'var(--text-dim)' }}
            >
                {children}
            </Typography>
        </Box>
    )
}
