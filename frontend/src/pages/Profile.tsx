import { useCallback, useEffect, useMemo, useState } from 'react'
import { Box, Typography } from '@mui/material'
import { useParams } from 'react-router-dom'
import {
    ApiError,
    getProfile,
    getProfileGames,
    type Profile as ProfileData,
    type ProfileGame,
    type ProfileUpdateResult,
} from '../api/client'
import { useAuth } from '../lib/auth'
import IdentityHero from '../components/profile/IdentityHero'
import RecordPanel from '../components/profile/RecordPanel'
import RatingsPanel from '../components/profile/RatingsPanel'
import GamesPanel from '../components/profile/GamesPanel'
import ProfileSkeleton from '../components/profile/ProfileSkeleton'
import {
    OUTCOME_STYLE,
    primaryCategory,
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
    const [opponent, setOpponent] = useState('')
    const [dateFrom, setDateFrom] = useState('')
    const [dateTo, setDateTo] = useState('')
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
        setOpponent('')
        setDateFrom('')
        setDateTo('')
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
    // filtering (category, result, opponent substring, date range), so `total`
    // (and thus the page count) reflects the filtered set. All axes compose.
    const fetchGames = useCallback(
        (n: number, cat: CatFilter, res: ResultFilter, opp: string, from: string, to: string) => {
            if (!data) return
            setPageLoading(true)
            getProfileGames(data.name, n, cat, res, { opponent: opp, from, to })
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
            fetchGames(n, category, result, opponent, dateFrom, dateTo)
        },
        [fetchGames, page, totalPages, pageLoading, category, result, opponent, dateFrom, dateTo],
    )

    // Filter changes always reset to page 1.
    const changeCategory = useCallback(
        (cat: CatFilter) => {
            if (cat === category || pageLoading) return
            setCategory(cat)
            fetchGames(1, cat, result, opponent, dateFrom, dateTo)
        },
        [fetchGames, category, result, opponent, dateFrom, dateTo, pageLoading],
    )
    const changeResult = useCallback(
        (res: ResultFilter) => {
            if (res === result || pageLoading) return
            setResult(res)
            fetchGames(1, category, res, opponent, dateFrom, dateTo)
        },
        [fetchGames, category, result, opponent, dateFrom, dateTo, pageLoading],
    )
    const changeOpponent = useCallback(
        (opp: string) => {
            if (opp === opponent || pageLoading) return
            setOpponent(opp)
            fetchGames(1, category, result, opp, dateFrom, dateTo)
        },
        [fetchGames, category, result, opponent, dateFrom, dateTo, pageLoading],
    )
    const changeDateFrom = useCallback(
        (from: string) => {
            if (from === dateFrom || pageLoading) return
            setDateFrom(from)
            fetchGames(1, category, result, opponent, from, dateTo)
        },
        [fetchGames, category, result, opponent, dateFrom, dateTo, pageLoading],
    )
    const changeDateTo = useCallback(
        (to: string) => {
            if (to === dateTo || pageLoading) return
            setDateTo(to)
            fetchGames(1, category, result, opponent, dateFrom, to)
        },
        [fetchGames, category, result, opponent, dateFrom, dateTo, pageLoading],
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

    // The player's most-played pool — the row RatingsPanel highlights.
    const primary = useMemo(() => {
        if (!data) return null
        return primaryCategory(data)
    }, [data])

    // Merge a self-edit's result (bio/country) into the displayed profile
    // without a full refetch of ratings/games/history.
    const handleProfileUpdated = useCallback((result: ProfileUpdateResult) => {
        setData((prev) => (prev ? { ...prev, bio: result.bio, country: result.country } : prev))
    }, [])

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
                            lastActive={data.games[0]?.created_at ?? null}
                            onProfileUpdated={handleProfileUpdated}
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
                                <RatingsPanel profile={data} primaryKey={primary} />
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
                                opponent={opponent}
                                dateFrom={dateFrom}
                                dateTo={dateTo}
                                onOpponent={changeOpponent}
                                onDateFrom={changeDateFrom}
                                onDateTo={changeDateTo}
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
                sx={{
                    fontSize: 14,
                    color: tone === 'error' ? OUTCOME_STYLE.loss.color : 'var(--text-dim)',
                }}
            >
                {children}
            </Typography>
        </Box>
    )
}
