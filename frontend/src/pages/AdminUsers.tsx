import { useEffect, useRef, useState } from 'react'
import { Box, Typography } from '@mui/material'
import {
    getAdminUsers,
    type AdminUsersPage,
    type AdminUserSort,
    type SortDir,
} from '../api/client'
import UsersToolbar, {
    type RoleFilter,
    type StatusFilter,
} from '../components/admin/users/UsersToolbar'
import UsersTable from '../components/admin/users/UsersTable'

interface Query {
    q: string
    role: RoleFilter
    status: StatusFilter
    sort: AdminUserSort
    dir: SortDir
    page: number
}

const INITIAL_QUERY: Query = {
    q: '',
    role: 'all',
    status: 'all',
    sort: 'created_at',
    dir: 'desc',
    page: 1,
}

/** Admin user directory: debounced search + role/status filters + sortable
 * columns over a paginated table. Every filter/sort/search change resets to page
 * 1 (folded into a single immutable query object, so each change is one fetch).
 * Handles loading, error, and empty states. */
export default function AdminUsers() {
    const [searchInput, setSearchInput] = useState('')
    const [query, setQuery] = useState<Query>(INITIAL_QUERY)
    const [data, setData] = useState<AdminUsersPage | null>(null)
    const [loading, setLoading] = useState(true)
    const [error, setError] = useState<string | null>(null)

    // Debounce the raw search box into the query (and reset to page 1). A no-op
    // when the trimmed term is unchanged, so retyping the same text won't refetch.
    useEffect(() => {
        const t = setTimeout(() => {
            const q = searchInput.trim()
            setQuery((prev) => (prev.q === q ? prev : { ...prev, q, page: 1 }))
        }, 300)
        return () => clearTimeout(t)
    }, [searchInput])

    // A single fetch path keyed on the whole query object.
    useEffect(() => {
        let cancelled = false
        setLoading(true)
        setError(null)
        getAdminUsers({
            q: query.q || undefined,
            role: query.role === 'all' ? undefined : query.role,
            status: query.status === 'all' ? undefined : query.status,
            sort: query.sort,
            dir: query.dir,
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

    // Clicking a column header toggles direction if it's already the sort key,
    // else selects it (default descending). Either way, back to page 1.
    const onSort = (key: AdminUserSort) =>
        setQuery((prev) => ({
            ...prev,
            sort: key,
            dir: prev.sort === key && prev.dir === 'desc' ? 'asc' : 'desc',
            page: 1,
        }))

    const onRole = (role: RoleFilter) => setQuery((prev) => ({ ...prev, role, page: 1 }))
    const onStatus = (status: StatusFilter) => setQuery((prev) => ({ ...prev, status, page: 1 }))
    const onPage = (page: number) => setQuery((prev) => ({ ...prev, page }))

    // Preserve the last-known total across an in-flight refetch so the count and
    // paginator don't flicker/collapse while loading the next page.
    const lastTotal = useRef(0)
    if (data) lastTotal.current = data.total
    const total = data?.total ?? (loading ? lastTotal.current : 0)
    const perPage = data?.perPage ?? 25

    return (
        <Box sx={{ display: 'flex', flexDirection: 'column' }}>
            <UsersToolbar
                search={searchInput}
                onSearch={setSearchInput}
                role={query.role}
                onRole={onRole}
                status={query.status}
                onStatus={onStatus}
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
                <UsersTable
                    users={data?.users ?? []}
                    total={total}
                    page={query.page}
                    perPage={perPage}
                    sort={query.sort}
                    dir={query.dir}
                    loading={loading}
                    onSort={onSort}
                    onPage={onPage}
                />
            )}
        </Box>
    )
}
