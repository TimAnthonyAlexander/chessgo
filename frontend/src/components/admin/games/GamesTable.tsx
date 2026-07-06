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
} from '@mui/material'
import type { AdminGameRow } from '../../../api/client'
import GameRow from './GameRow'

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

/** The persisted-game log table: presentational rows plus a footer paginator
 * driven by `total`. Renders skeleton, empty, and populated states — mirroring
 * the Users tab's table so the two tabs read as one system. */
export default function GamesTable({
    games,
    total,
    page,
    perPage,
    loading,
    onPage,
}: {
    games: AdminGameRow[]
    total: number
    page: number
    perPage: number
    loading: boolean
    onPage: (page: number) => void
}) {
    const empty = !loading && games.length === 0

    return (
        <Box
            sx={{
                border: '1px solid var(--line-soft)',
                borderRadius: '12px',
                overflow: 'hidden',
                bgcolor: 'var(--surface)',
            }}
        >
            <TableContainer sx={{ opacity: loading && games.length > 0 ? 0.55 : 1 }}>
                <Table size="small" sx={{ minWidth: 860 }}>
                    <TableHead>
                        <TableRow sx={{ '& th': { bgcolor: 'var(--surface-2)' } }}>
                            <TableCell sx={headCellSx}>Players</TableCell>
                            <TableCell sx={headCellSx} align="center">
                                Result
                            </TableCell>
                            <TableCell sx={headCellSx}>Type</TableCell>
                            <TableCell sx={headCellSx}>Rated</TableCell>
                            <TableCell sx={headCellSx}>Category</TableCell>
                            <TableCell sx={headCellSx} align="right">
                                Moves
                            </TableCell>
                            <TableCell sx={headCellSx} align="right">
                                Date
                            </TableCell>
                        </TableRow>
                    </TableHead>
                    <TableBody>
                        {loading && games.length === 0
                            ? Array.from({ length: 10 }).map((_, i) => <SkeletonRow key={i} />)
                            : games.map((g) => <GameRow key={g.id} game={g} />)}
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
                    No games match this filter.
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

function SkeletonRow() {
    return (
        <TableRow sx={{ '& td': { borderColor: 'var(--line-soft)' } }}>
            {Array.from({ length: 7 }).map((_, i) => (
                <TableCell key={i} align={i === 1 ? 'center' : i >= 5 ? 'right' : undefined}>
                    <Skeleton
                        variant="text"
                        width={i === 0 ? 180 : i >= 5 ? 44 : 64}
                        sx={{ bgcolor: 'var(--surface-2)', display: 'inline-block' }}
                    />
                </TableCell>
            ))}
        </TableRow>
    )
}
