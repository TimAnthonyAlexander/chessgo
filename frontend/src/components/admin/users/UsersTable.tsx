import {
    Box,
    Skeleton,
    Table,
    TableBody,
    TableCell,
    TableContainer,
    TableHead,
    TablePagination,
    TableRow,
    TableSortLabel,
} from '@mui/material'
import type { AdminUserRow, AdminUserSort, SortDir } from '../../../api/client'
import UserRow from './UserRow'
import { RATING_COLS } from './shared'

const headCellSx = {
    borderColor: 'var(--line-soft)',
    fontFamily: 'var(--font-mono)',
    fontSize: 10.5,
    letterSpacing: '0.1em',
    textTransform: 'uppercase',
    color: 'var(--muted)',
    fontWeight: 700,
    py: 1,
    whiteSpace: 'nowrap',
} as const

/** The user directory table: sortable headers (name/ratings/joined — the backend
 * whitelist), presentational rows, and a footer paginator driven by `total`.
 * Renders skeleton, empty, and populated states. */
export default function UsersTable({
    users,
    total,
    page,
    perPage,
    sort,
    dir,
    loading,
    onSort,
    onPage,
}: {
    users: AdminUserRow[]
    total: number
    page: number
    perPage: number
    sort: AdminUserSort
    dir: SortDir
    loading: boolean
    onSort: (key: AdminUserSort) => void
    onPage: (page: number) => void
}) {
    const empty = !loading && users.length === 0

    return (
        <Box
            sx={{
                border: '1px solid var(--line-soft)',
                borderRadius: '12px',
                overflow: 'hidden',
                bgcolor: 'var(--surface)',
            }}
        >
            <TableContainer sx={{ opacity: loading && users.length > 0 ? 0.55 : 1 }}>
                <Table size="small" sx={{ minWidth: 900 }}>
                    <TableHead>
                        <TableRow sx={{ '& th': { bgcolor: 'var(--surface-2)' } }}>
                            <SortHead
                                label="Name"
                                col="name"
                                sort={sort}
                                dir={dir}
                                onSort={onSort}
                            />
                            <TableCell sx={headCellSx}>Email</TableCell>
                            <TableCell sx={headCellSx}>Role</TableCell>
                            <TableCell sx={headCellSx}>Status</TableCell>
                            {RATING_COLS.map((c) => (
                                <SortHead
                                    key={c.key}
                                    label={c.label}
                                    col={c.sort}
                                    sort={sort}
                                    dir={dir}
                                    onSort={onSort}
                                    align="right"
                                />
                            ))}
                            <TableCell sx={headCellSx}>Flags</TableCell>
                            <SortHead
                                label="Joined"
                                col="created_at"
                                sort={sort}
                                dir={dir}
                                onSort={onSort}
                                align="right"
                            />
                        </TableRow>
                    </TableHead>
                    <TableBody>
                        {loading && users.length === 0
                            ? Array.from({ length: 8 }).map((_, i) => <SkeletonRow key={i} />)
                            : users.map((u) => <UserRow key={u.id} user={u} />)}
                    </TableBody>
                </Table>
            </TableContainer>

            {empty && (
                <Box
                    sx={{
                        py: 6,
                        textAlign: 'center',
                        color: 'var(--muted)',
                        fontSize: 13.5,
                    }}
                >
                    No users match this filter.
                </Box>
            )}

            {total > 0 && (
                <TablePagination
                    component="div"
                    count={total}
                    page={page - 1}
                    onPageChange={(_, p) => onPage(p + 1)}
                    rowsPerPage={perPage}
                    rowsPerPageOptions={[perPage]}
                    sx={{
                        borderTop: '1px solid var(--line-soft)',
                        color: 'var(--text-dim)',
                        '& .MuiTablePagination-toolbar': { minHeight: 48 },
                        '& .MuiTablePagination-selectLabel, & .MuiTablePagination-displayedRows': {
                            fontSize: 12.5,
                            fontFamily: 'var(--font-mono)',
                            color: 'var(--text-dim)',
                        },
                        '& .MuiTablePagination-actions .MuiIconButton-root.Mui-disabled': {
                            color: 'var(--muted)',
                        },
                    }}
                />
            )}
        </Box>
    )
}

function SortHead({
    label,
    col,
    sort,
    dir,
    onSort,
    align,
}: {
    label: string
    col: AdminUserSort
    sort: AdminUserSort
    dir: SortDir
    onSort: (key: AdminUserSort) => void
    align?: 'right'
}) {
    const active = sort === col
    return (
        <TableCell sx={headCellSx} align={align} sortDirection={active ? dir : false}>
            <TableSortLabel
                active={active}
                direction={active ? dir : 'desc'}
                onClick={() => onSort(col)}
                sx={{
                    color: 'inherit !important',
                    '& .MuiTableSortLabel-icon': {
                        color: active ? 'var(--accent) !important' : 'var(--muted) !important',
                    },
                    '&.Mui-active': { color: 'var(--text) !important' },
                    '&:hover': { color: 'var(--text-dim) !important' },
                }}
            >
                {label}
            </TableSortLabel>
        </TableCell>
    )
}

function SkeletonRow() {
    return (
        <TableRow sx={{ '& td': { borderColor: 'var(--line-soft)' } }}>
            {Array.from({ length: 10 }).map((_, i) => (
                <TableCell key={i} align={i >= 4 && i <= 7 ? 'right' : undefined}>
                    <Skeleton
                        variant="text"
                        width={i === 1 ? 140 : i >= 4 && i <= 7 ? 48 : 70}
                        sx={{ bgcolor: 'var(--surface-2)', display: 'inline-block' }}
                    />
                </TableCell>
            ))}
        </TableRow>
    )
}
