import { useCallback, useEffect, useState } from 'react'
import { Box, CircularProgress, TablePagination, Typography } from '@mui/material'
import { ShieldCheck } from 'lucide-react'
import {
    getFlaggedUsers,
    type FlaggedUsersPage,
    type FlagSortKey,
    type SortDir,
} from '../api/client'
import { Panel, PanelHead } from '../components/home/Panel'
import FlagStatusTabs, { type StatusFilter } from '../components/admin/anticheat/FlagStatusTabs'
import FlagQueueTable from '../components/admin/anticheat/FlagQueueTable'

/** The anti-cheat review queue: flagged accounts, filterable by verdict status,
 * sortable by flag count / severity / recency, paginated. Each row drills into
 * the per-user review. */
export default function AdminAnticheat() {
    const [status, setStatus] = useState<StatusFilter>('all')
    const [sort, setSort] = useState<FlagSortKey>('total_flags')
    const [dir, setDir] = useState<SortDir>('desc')
    const [page, setPage] = useState(0) // 0-based (TablePagination); the API is 1-based

    const [data, setData] = useState<FlaggedUsersPage | null>(null)
    const [loading, setLoading] = useState(true)
    const [error, setError] = useState<string | null>(null)

    useEffect(() => {
        let cancelled = false
        setLoading(true)
        setError(null)
        getFlaggedUsers({
            status: status === 'all' ? undefined : status,
            sort,
            dir,
            page: page + 1,
        })
            .then((d) => {
                if (!cancelled) setData(d)
            })
            .catch((e) => {
                if (!cancelled) setError((e as Error).message)
            })
            .finally(() => {
                if (!cancelled) setLoading(false)
            })
        return () => {
            cancelled = true
        }
    }, [status, sort, dir, page])

    const onSort = useCallback(
        (key: FlagSortKey) => {
            if (key === sort) {
                setDir((d) => (d === 'desc' ? 'asc' : 'desc'))
            } else {
                setSort(key)
                setDir('desc')
            }
            setPage(0)
        },
        [sort],
    )

    const onStatus = useCallback((v: StatusFilter) => {
        setStatus(v)
        setPage(0)
    }, [])

    const rows = data?.flagged ?? []

    return (
        <Box sx={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
            <FlagStatusTabs value={status} onChange={onStatus} />

            <Panel sx={{ p: 0, overflow: 'hidden' }}>
                <Box sx={{ p: { xs: 2, md: 2.5 }, pb: 1.5 }}>
                    <PanelHead
                        title="Flagged accounts"
                        sub="Accounts with one or more anti-cheat detections, most-flagged first"
                    />
                </Box>

                {error ? (
                    <Box sx={{ px: 2.5, pb: 3 }}>
                        <Typography sx={{ fontSize: 13.5, color: '#ca4a4a' }}>{error}</Typography>
                    </Box>
                ) : loading && !data ? (
                    <Box sx={{ display: 'flex', justifyContent: 'center', py: 6 }}>
                        <CircularProgress size={22} sx={{ color: 'var(--accent)' }} />
                    </Box>
                ) : rows.length === 0 ? (
                    <Box
                        sx={{
                            display: 'flex',
                            flexDirection: 'column',
                            alignItems: 'center',
                            gap: 1,
                            py: 6,
                            color: 'var(--muted)',
                        }}
                    >
                        <ShieldCheck size={28} />
                        <Typography sx={{ fontSize: 14, color: 'var(--text-dim)' }}>
                            No flagged users
                        </Typography>
                        <Typography sx={{ fontSize: 12.5 }}>
                            {status === 'all'
                                ? 'No anti-cheat detections have fired yet.'
                                : `No accounts in the “${status}” state.`}
                        </Typography>
                    </Box>
                ) : (
                    <Box sx={{ px: { xs: 2, md: 2.5 }, pb: 1, opacity: loading ? 0.6 : 1 }}>
                        <FlagQueueTable rows={rows} sort={sort} dir={dir} onSort={onSort} />
                    </Box>
                )}

                {!error && data && data.total > 0 && (
                    <TablePagination
                        component="div"
                        count={data.total}
                        page={page}
                        onPageChange={(_, p) => setPage(p)}
                        rowsPerPage={data.perPage}
                        rowsPerPageOptions={[]}
                        sx={{
                            color: 'var(--text-dim)',
                            borderTop: '1px solid var(--line-soft)',
                            '.MuiTablePagination-toolbar': { minHeight: 48 },
                            '.MuiTablePagination-displayedRows': {
                                fontFamily: 'var(--font-mono)',
                                fontSize: 12.5,
                            },
                            '.MuiSvgIcon-root': { color: 'var(--text-dim)' },
                        }}
                    />
                )}
            </Panel>
        </Box>
    )
}
