import { Box, Tooltip, Typography } from '@mui/material'
import { Link } from 'react-router-dom'
import { ArrowDown, ArrowUp, HelpCircle } from 'lucide-react'
import type { FlagSortKey, FlaggedUserRollup, SortDir } from '../../../api/client'
import { fmtRelative } from '../../profile/shared'
import { categoryLabel } from './shared'
import SeverityChip from './SeverityChip'
import StatusChip from './StatusChip'
import CategoryPills from './CategoryPills'

interface Col {
    key: FlagSortKey | null
    label: string
    align: 'left' | 'right' | 'center'
    width?: string
    hint?: string
}

const COLS: Col[] = [
    { key: null, label: 'User', align: 'left' },
    { key: 'total_flags', label: 'Flags', align: 'right', width: '84px' },
    {
        key: 'top_severity',
        label: 'Severity',
        align: 'left',
        width: '108px',
        hint: 'Severity sort is applied to the current page only — the backend has no numeric suspicion score.',
    },
    { key: null, label: 'Status', align: 'left', width: '116px' },
    { key: null, label: 'Signals', align: 'left', width: '188px' },
    { key: null, label: 'Last signal', align: 'left', width: '170px' },
    { key: 'last_flagged_at', label: 'Last flagged', align: 'right', width: '128px' },
]

const GRID = '1.4fr 84px 108px 116px 188px 170px 128px'

/** The anti-cheat review queue as a dense, sortable table. Sortable columns
 * (flags / severity / last-flagged) toggle direction on re-click; the rest are
 * static. Each row links to the per-user drill-down. */
export default function FlagQueueTable({
    rows,
    sort,
    dir,
    onSort,
}: {
    rows: FlaggedUserRollup[]
    sort: FlagSortKey
    dir: SortDir
    onSort: (key: FlagSortKey) => void
}) {
    return (
        <Box
            sx={{
                border: '1px solid var(--line-soft)',
                borderRadius: 'var(--radius)',
                overflow: 'hidden',
                bgcolor: 'var(--surface)',
            }}
        >
            <Box sx={{ overflowX: 'auto' }}>
                <Box sx={{ minWidth: 880 }}>
                    {/* Header */}
                    <Box
                        sx={{
                            display: 'grid',
                            gridTemplateColumns: GRID,
                            alignItems: 'center',
                            px: 1.5,
                            py: 1,
                            bgcolor: 'var(--bg-2)',
                            borderBottom: '1px solid var(--line-soft)',
                        }}
                    >
                        {COLS.map((col, i) => {
                            const sortable = col.key != null
                            const active = sortable && col.key === sort
                            return (
                                <Box
                                    key={i}
                                    onClick={sortable ? () => onSort(col.key as FlagSortKey) : undefined}
                                    sx={{
                                        display: 'flex',
                                        alignItems: 'center',
                                        gap: 0.375,
                                        justifyContent:
                                            col.align === 'right' ? 'flex-end' : 'flex-start',
                                        cursor: sortable ? 'pointer' : 'default',
                                        userSelect: 'none',
                                        color: active ? 'var(--accent)' : 'var(--text-dim)',
                                        '&:hover': sortable
                                            ? { color: 'var(--accent)' }
                                            : undefined,
                                    }}
                                >
                                    <Typography
                                        sx={{
                                            fontFamily: 'var(--font-mono)',
                                            fontSize: 10,
                                            fontWeight: 700,
                                            letterSpacing: '0.12em',
                                            textTransform: 'uppercase',
                                            color: 'inherit',
                                        }}
                                    >
                                        {col.label}
                                    </Typography>
                                    {col.hint && (
                                        <Tooltip arrow title={col.hint}>
                                            <Box sx={{ display: 'flex', color: 'var(--muted)' }}>
                                                <HelpCircle size={12} />
                                            </Box>
                                        </Tooltip>
                                    )}
                                    {active &&
                                        (dir === 'asc' ? (
                                            <ArrowUp size={12} />
                                        ) : (
                                            <ArrowDown size={12} />
                                        ))}
                                </Box>
                            )
                        })}
                    </Box>

                    {/* Rows */}
                    {rows.map((r) => (
                        <Box
                            key={r.user_id}
                            component={Link}
                            to={`/admin/anticheat/${r.user_id}`}
                            sx={{
                                display: 'grid',
                                gridTemplateColumns: GRID,
                                alignItems: 'center',
                                px: 1.5,
                                py: 1.125,
                                textDecoration: 'none',
                                borderBottom: '1px solid var(--line-soft)',
                                transition: 'background .1s ease',
                                '&:last-of-type': { borderBottom: 'none' },
                                '&:hover': { bgcolor: 'rgba(255,255,255,0.028)' },
                            }}
                        >
                            <Box sx={{ minWidth: 0, pr: 1 }}>
                                <Typography
                                    sx={{
                                        fontSize: 13.5,
                                        fontWeight: 600,
                                        color: 'var(--text)',
                                        overflow: 'hidden',
                                        textOverflow: 'ellipsis',
                                        whiteSpace: 'nowrap',
                                    }}
                                >
                                    {r.user_name}
                                </Typography>
                            </Box>
                            <Typography
                                sx={{
                                    textAlign: 'right',
                                    fontFamily: 'var(--font-mono)',
                                    fontSize: 15,
                                    fontWeight: 700,
                                    color: 'var(--text)',
                                }}
                            >
                                {r.total_flags}
                            </Typography>
                            <Box>
                                <SeverityChip severity={r.top_severity} dense />
                            </Box>
                            <Box>
                                <StatusChip status={r.status} />
                            </Box>
                            <CategoryPills counts={r.counts} />
                            <Typography
                                sx={{
                                    fontSize: 12.5,
                                    color: 'var(--text-dim)',
                                    overflow: 'hidden',
                                    textOverflow: 'ellipsis',
                                    whiteSpace: 'nowrap',
                                    pr: 1,
                                }}
                            >
                                {categoryLabel(r.last_category)}
                            </Typography>
                            <Typography
                                sx={{
                                    textAlign: 'right',
                                    fontSize: 12,
                                    color: 'var(--muted)',
                                    fontFamily: 'var(--font-mono)',
                                }}
                            >
                                {fmtRelative(r.last_flagged_at)}
                            </Typography>
                        </Box>
                    ))}
                </Box>
            </Box>
        </Box>
    )
}
