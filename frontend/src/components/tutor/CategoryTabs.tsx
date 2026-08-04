import { Box, Typography } from '@mui/material'
import type { TutorPayload } from '../../api/client'
import { MagnitudeBar } from './GradeMeter'
import { cap, fmtGames } from './format'

/** The report's category picker, sidebar-style (echoes RatingsPanel's row
 * list). Categories with insufficient games are never silently dropped — they
 * render as inactive rows with a progress bar showing exactly how close they
 * are, rather than as a greyed-out line the eye skips. */
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
        <Box>
            <Typography
                sx={{
                    fontFamily: 'var(--font-mono)',
                    fontSize: 11,
                    fontWeight: 600,
                    letterSpacing: '0.16em',
                    textTransform: 'uppercase',
                    color: 'var(--text-dim)',
                    mb: 1,
                }}
            >
                Time control
            </Typography>

            <Box sx={{ display: 'flex', flexDirection: 'column', gap: 0.25 }}>
                {categories.map((c) => {
                    const isActive = c.category === active
                    return (
                        <Box
                            key={c.category}
                            role="button"
                            tabIndex={0}
                            aria-pressed={isActive}
                            onClick={() => onSelect(c.category)}
                            onKeyDown={(e) => {
                                if (e.key === 'Enter' || e.key === ' ') {
                                    e.preventDefault()
                                    onSelect(c.category)
                                }
                            }}
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
                                '&:hover': {
                                    bgcolor: isActive ? 'var(--accent-soft)' : 'var(--surface-2)',
                                },
                                '&:focus-visible': { outline: '1px solid var(--accent-line)' },
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
                                    fontSize: 11,
                                    color: isActive ? 'var(--accent)' : 'var(--muted)',
                                    fontVariantNumeric: 'tabular-nums',
                                    whiteSpace: 'nowrap',
                                }}
                            >
                                {fmtGames(c.games)}
                            </Typography>
                        </Box>
                    )
                })}

                {insufficient.map(([key, info]) => {
                    const total = info.games + info.need
                    return (
                        <Box key={key} sx={{ px: 1.25, py: 1 }}>
                            <Box
                                sx={{
                                    display: 'flex',
                                    alignItems: 'baseline',
                                    justifyContent: 'space-between',
                                    gap: 1,
                                }}
                            >
                                <Typography
                                    sx={{
                                        fontSize: 13.5,
                                        fontWeight: 600,
                                        color: 'var(--text-dim)',
                                    }}
                                >
                                    {cap(key)}
                                </Typography>
                                <Typography
                                    sx={{
                                        fontFamily: 'var(--font-mono)',
                                        fontSize: 11,
                                        color: 'var(--muted)',
                                        fontVariantNumeric: 'tabular-nums',
                                        whiteSpace: 'nowrap',
                                    }}
                                >
                                    {info.games} / {total}
                                </Typography>
                            </Box>
                            <Box sx={{ mt: 0.75 }}>
                                <MagnitudeBar
                                    value={info.games}
                                    max={total}
                                    height={4}
                                    confidence={0.35}
                                />
                            </Box>
                            <Typography
                                sx={{
                                    fontFamily: 'var(--font-mono)',
                                    fontSize: 11,
                                    color: 'var(--muted)',
                                    mt: 0.5,
                                }}
                            >
                                Play {info.need} more to report on it
                            </Typography>
                        </Box>
                    )
                })}
            </Box>
        </Box>
    )
}
