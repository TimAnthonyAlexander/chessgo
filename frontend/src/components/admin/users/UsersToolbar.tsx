import { Box, InputAdornment, MenuItem, TextField } from '@mui/material'
import { Search } from 'lucide-react'
import type { AdminUserRole, AdminUserStatus } from '../../../api/client'

export type RoleFilter = AdminUserRole | 'all'
export type StatusFilter = AdminUserStatus | 'all'

// A dark-theme-consistent field style shared by the search box + selects, so the
// toolbar reads as the same brass-on-charcoal system as the rest of the panel.
const fieldSx = {
    '& .MuiOutlinedInput-root': {
        bgcolor: 'var(--surface-2)',
        borderRadius: 'var(--radius)',
        fontSize: 14,
        '& fieldset': { borderColor: 'var(--line-soft)' },
        '&:hover fieldset': { borderColor: 'var(--line)' },
        '&.Mui-focused fieldset': { borderColor: 'var(--accent-line)' },
    },
    '& .MuiInputBase-input': { py: 1 },
} as const

/** The list toolbar: debounced free-text search (name/email) plus role + status
 * dropdown filters. Purely presentational — the parent owns the query state and
 * resets to page 1 on any change. */
export default function UsersToolbar({
    search,
    onSearch,
    role,
    onRole,
    status,
    onStatus,
    total,
}: {
    search: string
    onSearch: (v: string) => void
    role: RoleFilter
    onRole: (v: RoleFilter) => void
    status: StatusFilter
    onStatus: (v: StatusFilter) => void
    total: number | null
}) {
    return (
        <Box
            sx={{
                display: 'flex',
                flexWrap: 'wrap',
                alignItems: 'center',
                gap: 1.25,
                mb: 2,
            }}
        >
            <TextField
                value={search}
                onChange={(e) => onSearch(e.target.value)}
                placeholder="Search name or email…"
                size="small"
                sx={{ ...fieldSx, flex: 1, minWidth: 220 }}
                slotProps={{
                    input: {
                        startAdornment: (
                            <InputAdornment position="start">
                                <Search size={15} color="var(--muted)" />
                            </InputAdornment>
                        ),
                    },
                }}
            />

            <TextField
                select
                label="Role"
                value={role}
                onChange={(e) => onRole(e.target.value as RoleFilter)}
                size="small"
                sx={{ ...fieldSx, minWidth: 130 }}
                slotProps={{ inputLabel: { sx: { fontSize: 13 } } }}
            >
                <MenuItem value="all">All roles</MenuItem>
                <MenuItem value="user">User</MenuItem>
                <MenuItem value="admin">Admin</MenuItem>
            </TextField>

            <TextField
                select
                label="Status"
                value={status}
                onChange={(e) => onStatus(e.target.value as StatusFilter)}
                size="small"
                sx={{ ...fieldSx, minWidth: 130 }}
                slotProps={{ inputLabel: { sx: { fontSize: 13 } } }}
            >
                <MenuItem value="all">All status</MenuItem>
                <MenuItem value="active">Active</MenuItem>
                <MenuItem value="banned">Banned</MenuItem>
            </TextField>

            {total != null && (
                <Box
                    sx={{
                        ml: { xs: 0, sm: 'auto' },
                        fontFamily: 'var(--font-mono)',
                        fontSize: 12.5,
                        color: 'var(--muted)',
                        whiteSpace: 'nowrap',
                    }}
                >
                    {total.toLocaleString()} {total === 1 ? 'user' : 'users'}
                </Box>
            )}
        </Box>
    )
}
