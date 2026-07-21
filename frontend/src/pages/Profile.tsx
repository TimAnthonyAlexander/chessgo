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
import {
    primaryRating,
    ratingSeries,
    type CatFilter,
    type ResultFilter,
} from '../components/profile/shared'

export default function Profile() {
    const { name = '' } = useParams<{ name: string }>()
    const { user } = useAuth()

    const [data, setData] = useState<ProfileData | null>(null)
    // The currently displayed page of history (replaced, not appended, on page
    // or filter change). The hero's trend/last-active stay bound to `data.games`
    // (unfiltered page 1) so they don't shift as you page or filter.
    const [pageGames, setPageGames] = useState<ProfileGame[]>([])
    const [page, setPage] = useState(1)
    const [total, setTotal] = useState(0)
    const [category, setCategory] = useState<CatFilter>('all')
    const [result, setResult] = useState<ResultFilter>('all')
    const [pageLoading, setPageLoading] = useState(false)
    const [loading, setLoading] = useState(true)
    const [error, setError] = useState<string | null>(null)

    useEffect(() => {
        let cancelled = false
        setLoading(true)
        setError(null)
        // Reset filters/paging for the newly-viewed profile.
        setCategory('all')
        setResult('all')
        getProfile(name)
            .then((p) => {
                if (cancelled) return
                setData(p)
                setPageGames(p.games)
                setPage(1)
                setTotal(p.gamesTotal)
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

    const perPage = data?.gamesPerPage ?? 10
    const totalPages = Math.max(1, Math.ceil(total / perPage))

    // A single fetch path for every page/filter change — the server does the
    // filtering, so `total` (and thus the page count) reflects the filtered set.
    const fetchGames = useCallback(
        (n: number, cat: CatFilter, res: ResultFilter) => {
            if (!data) return
            setPageLoading(true)
            getProfileGames(data.name, n, cat, res)
                .then((r) => {
                    setPageGames(r.games)
                    setPage(r.page)
                    setTotal(r.total)
                })
                .catch(() => {
                    /* keep the current view on a transient error */
                })
                .finally(() => setPageLoading(false))
        },
        [data],
    )

    const goToPage = useCallback(
        (n: number) => {
            if (n === page || n < 1 || n > totalPages || pageLoading) return
            fetchGames(n, category, result)
        },
        [fetchGames, page, totalPages, pageLoading, category, result],
    )

    // Filter changes always reset to page 1.
    const changeCategory = useCallback(
        (cat: CatFilter) => {
            if (cat === category || pageLoading) return
            setCategory(cat)
            fetchGames(1, cat, result)
        },
        [fetchGames, category, result, pageLoading],
    )
    const changeResult = useCallback(
        (res: ResultFilter) => {
            if (res === result || pageLoading) return
            setResult(res)
            fetchGames(1, category, res)
        },
        [fetchGames, category, result, pageLoading],
    )

    // Category chips to offer: 'all' plus the time controls the player has games
    // in, plus Duck / Antichess if they've played them. (Chess960 games surface
    // under their time-control chip.)
    const availableCats = useMemo<CatFilter[]>(() => {
        if (!data) return ['all']
        const cats: CatFilter[] = ['all']
        for (const c of ['bullet', 'blitz', 'rapid', 'classical'] as const) {
            if (data.ratings[c].games > 0) cats.push(c)
        }
        if (data.duck.games > 0) cats.push('duck')
        if (data.antichess.games > 0) cats.push('antichess')
        return cats
    }, [data])

    // Reconstruct the per-category rating trend from the first page of games,
    // and pick the player's headline (most-played) rating for the hero call-out.
    const primary = useMemo(() => {
        if (!data) return null
        return primaryRating(data, ratingSeries(data.games, data.id))
    }, [data])

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
                            lastActive={data.games[0]?.created_at ?? null}
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

                            {/* Main: server-filtered, paginated game history. */}
                            <GamesPanel
                                games={pageGames}
                                userId={data.id}
                                page={page}
                                totalPages={totalPages}
                                loading={pageLoading}
                                onPage={goToPage}
                                category={category}
                                result={result}
                                availableCats={availableCats}
                                onCategory={changeCategory}
                                onResult={changeResult}
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
