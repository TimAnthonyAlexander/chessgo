import { Box, Typography } from '@mui/material'
import type { TutorPayload } from '../../api/client'
import { cap } from './format'

/** The report's category picker, sidebar-style (echoes RatingsPanel's row
 * list). Categories with insufficient games are never silently dropped —
 * they render as disabled rows explaining exactly how many more games are
 * needed. */
export default function CategoryTabs({
    payload,
    active,
    onSelect,
}: {
    payload: TutorPayload
    active: string | null
    onSelect: (category: string) => void
}) {
    const categories = Object.values(payload.categories)
    const insufficient = Object.entries(payload.insufficient)

    if (categories.length === 0 && insufficient.length === 0) return null

    return (
        <Box sx={{ display: 'flex', flexDirection: 'column', gap: 0.5 }}>
            {categories.map((c) => {
                const isActive = c.category === active
                return (
                    <Box
                        key={c.category}
                        onClick={() => onSelect(c.category)}
                        sx={{
                            display: 'flex',
                            alignItems: 'baseline',
                            justifyContent: 'space-between',
                            gap: 1,
                            px: 1.25,
                            py: 1,
                            borderRadius: '10px',
                            cursor: 'pointer',
                            bgcolor: isActive ? 'var(--accent-soft)' : 'transparent',
                            '&:hover': { bgcolor: isActive ? 'var(--accent-soft)' : 'var(--surface-2)' },
                        }}
                    >
                        <Typography
                            sx={{
                                fontSize: 13.5,
                                fontWeight: 600,
                                color: isActive ? 'var(--accent)' : 'var(--text)',
                            }}
                        >
                            {cap(c.category)}
                        </Typography>
                        <Typography
                            sx={{
                                fontFamily: 'var(--font-mono)',
                                fontSize: 11.5,
                                color: 'var(--muted)',
                            }}
                        >
                            {c.games} games
                        </Typography>
                    </Box>
                )
            })}

            {insufficient.map(([key, info]) => (
                <Box
                    key={key}
                    sx={{
                        px: 1.25,
                        py: 1,
                        borderRadius: '10px',
                        opacity: 0.55,
                    }}
                >
                    <Typography sx={{ fontSize: 13.5, fontWeight: 600, color: 'var(--muted)' }}>
                        {cap(key)}
                    </Typography>
                    <Typography sx={{ fontSize: 11.5, color: 'var(--muted)', mt: 0.15 }}>
                        {info.games} of {info.games + info.need} games. Play {info.need} more.
                    </Typography>
                </Box>
            ))}
        </Box>
    )
}
