import { Box, MenuItem, TextField } from '@mui/material'
import type { AdminGameCategory, AdminGameFilter } from '../../../api/client'

// A dark-theme-consistent select style shared with the Users toolbar, so the
// Games tab reads as the same brass-on-charcoal system as the rest of the panel.
const fieldSx = {
    '& .MuiOutlinedInput-root': {
        bgcolor: 'var(--surface-2)',
        borderRadius: '10px',
        fontSize: 14,
        '& fieldset': { borderColor: 'var(--line-soft)' },
        '&:hover fieldset': { borderColor: 'var(--line)' },
        '&.Mui-focused fieldset': { borderColor: 'var(--accent-line)' },
    },
    '& .MuiInputBase-input': { py: 1 },
} as const

/** The games-log toolbar: a bot/human filter + an optional category filter, plus
 * a live game count. Purely presentational — the parent owns the query state and
 * resets to page 1 on any change. */
export default function GamesToolbar({
    filter,
    onFilter,
    category,
    onCategory,
    total,
}: {
    filter: AdminGameFilter
    onFilter: (v: AdminGameFilter) => void
    category: AdminGameCategory
    onCategory: (v: AdminGameCategory) => void
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
                select
                label="Games"
                value={filter}
                onChange={(e) => onFilter(e.target.value as AdminGameFilter)}
                size="small"
                sx={{ ...fieldSx, minWidth: 150 }}
                slotProps={{ inputLabel: { sx: { fontSize: 13 } } }}
            >
                <MenuItem value="all">All games</MenuItem>
                <MenuItem value="bot">Bot fill</MenuItem>
                <MenuItem value="human">Human</MenuItem>
            </TextField>

            <TextField
                select
                label="Category"
                value={category}
                onChange={(e) => onCategory(e.target.value as AdminGameCategory)}
                size="small"
                sx={{ ...fieldSx, minWidth: 150 }}
                slotProps={{ inputLabel: { sx: { fontSize: 13 } } }}
            >
                <MenuItem value="all">All categories</MenuItem>
                <MenuItem value="bullet">Bullet</MenuItem>
                <MenuItem value="blitz">Blitz</MenuItem>
                <MenuItem value="rapid">Rapid</MenuItem>
                <MenuItem value="classical">Classical</MenuItem>
                <MenuItem value="duck">Duck</MenuItem>
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
                    {total.toLocaleString()} {total === 1 ? 'game' : 'games'}
                </Box>
            )}
        </Box>
    )
}
