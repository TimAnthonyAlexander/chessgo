import { useEffect, useRef, useState } from 'react'
import { Box, Typography } from '@mui/material'
import {
    getAdminGames,
    type AdminGameCategory,
    type AdminGameFilter,
    type AdminGamesPage,
} from '../api/client'
import GamesToolbar from '../components/admin/games/GamesToolbar'
import GamesTable from '../components/admin/games/GamesTable'

interface Query {
    filter: AdminGameFilter
    category: AdminGameCategory
    page: number
}

const INITIAL_QUERY: Query = {
    filter: 'all',
    category: 'all',
    page: 1,
}

/** Admin persisted-game log: a newest-first, paginated table that clearly marks
 * games played against a fill-in bot. Filter by bot/human + category; any change
 * resets to page 1 (folded into one immutable query object, so each change is a
 * single fetch). Handles loading, error, and empty states. */
export default function AdminGames() {
    const [query, setQuery] = useState<Query>(INITIAL_QUERY)
    const [data, setData] = useState<AdminGamesPage | null>(null)
    const [loading, setLoading] = useState(true)
    const [error, setError] = useState<string | null>(null)

    // A single fetch path keyed on the whole query object. The `cancelled` guard
    // drops a stale response so a slow earlier page can't clobber a newer one.
    useEffect(() => {
        let cancelled = false
        setLoading(true)
        setError(null)
        getAdminGames({
            filter: query.filter,
            category: query.category,
            page: query.page,
        })
            .then((page) => {
                if (!cancelled) setData(page)
            })
            .catch((e) => {
                if (!cancelled) {
                    setError((e as Error).message)
                    setData(null)
                }
            })
            .finally(() => {
                if (!cancelled) setLoading(false)
            })
        return () => {
            cancelled = true
        }
    }, [query])

    const onFilter = (filter: AdminGameFilter) =>
        setQuery((prev) => ({ ...prev, filter, page: 1 }))
    const onCategory = (category: AdminGameCategory) =>
        setQuery((prev) => ({ ...prev, category, page: 1 }))
    const onPage = (page: number) => setQuery((prev) => ({ ...prev, page }))

    // Preserve the last-known total across an in-flight refetch so the count and
    // paginator don't flicker/collapse while loading the next page.
    const lastTotal = useRef(0)
    if (data) lastTotal.current = data.total
    const total = data?.total ?? (loading ? lastTotal.current : 0)
    const perPage = data?.perPage ?? 30

    return (
        <Box sx={{ display: 'flex', flexDirection: 'column' }}>
            <GamesToolbar
                filter={query.filter}
                onFilter={onFilter}
                category={query.category}
                onCategory={onCategory}
                total={error ? null : total}
            />

            {error ? (
                <Box
                    sx={{
                        border: '1px solid var(--line-soft)',
                        borderRadius: '12px',
                        bgcolor: 'var(--surface)',
                        py: 6,
                        textAlign: 'center',
                    }}
                >
                    <Typography sx={{ fontSize: 14, color: '#ca4a4a' }}>{error}</Typography>
                </Box>
            ) : (
                <GamesTable
                    games={data?.games ?? []}
                    total={total}
                    page={query.page}
                    perPage={perPage}
                    loading={loading}
                    onPage={onPage}
                />
            )}
        </Box>
    )
}
