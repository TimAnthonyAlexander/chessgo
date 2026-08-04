import { Box, Typography } from '@mui/material'
import { Link } from 'react-router-dom'
import type { TutorThemeProfile } from '../../api/client'
import { MagnitudeBar } from './GradeMeter'
import { SectionHead } from './parts'
import { isThin, themeLabel } from './format'

/**
 * The report's second, independent line of tactical evidence — solve rate per
 * theme from the player's own puzzle history, weakest first.
 *
 * `comparable` is always false and this component must respect it: the puzzle
 * set carries puzzle ratings but not other players' per-theme results, so there
 * is NO peer column, NO percentile, and NO "vs other players" framing anywhere
 * here — only `note`, verbatim from the backend, explaining why.
 *
 * That is also why it is drawn as a grid of tiles with LEFT-ANCHORED bars and
 * no parity rule, instead of the diverging meter list above it: the shape is
 * the reader's cue that these numbers are measured against nothing but
 * themselves. Player-level (the puzzle pool has no time control), so it renders
 * once per report, not once per category.
 */
export default function ThemeProfileSection({ profile }: { profile?: TutorThemeProfile }) {
    if (!profile) return null

    const themes = [...profile.themes].sort((a, b) => a.rate - b.rate)

    return (
        <Box>
            <SectionHead
                title="Tactical themes"
                sub={`Your puzzle history · solve rate, higher is better · no peer comparison`}
            />

            <Typography
                sx={{
                    fontSize: 13.5,
                    color: 'var(--text-dim)',
                    mb: 2.5,
                    maxWidth: '58ch',
                    lineHeight: 1.6,
                }}
            >
                {profile.note}
            </Typography>

            {themes.length > 0 && (
                <Box
                    sx={{
                        display: 'grid',
                        gridTemplateColumns: 'repeat(auto-fill, minmax(148px, 1fr))',
                        columnGap: 3,
                        rowGap: 2.5,
                    }}
                >
                    {themes.map((t) => {
                        const thin = isThin(t.attempts)
                        return (
                            <Box
                                key={t.theme}
                                component={Link}
                                to={`/puzzles?theme=${encodeURIComponent(t.theme)}`}
                                sx={{
                                    display: 'block',
                                    textDecoration: 'none',
                                    color: 'inherit',
                                    mx: -1,
                                    px: 1,
                                    py: 0.75,
                                    borderRadius: '8px',
                                    minWidth: 0,
                                    '&:hover': { bgcolor: 'var(--surface-2)' },
                                    '&:focus-visible': { outline: '1px solid var(--accent-line)' },
                                }}
                            >
                                <Typography
                                    sx={{
                                        fontSize: 12.5,
                                        fontWeight: 600,
                                        color: 'var(--text)',
                                        lineHeight: 1.3,
                                        overflow: 'hidden',
                                        textOverflow: 'ellipsis',
                                        whiteSpace: 'nowrap',
                                    }}
                                >
                                    {themeLabel(t.theme)}
                                </Typography>
                                <Typography
                                    sx={{
                                        fontFamily: 'var(--font-mono)',
                                        fontSize: 18,
                                        fontWeight: 700,
                                        lineHeight: 1.25,
                                        color: thin ? 'var(--text-dim)' : 'var(--text)',
                                        mt: 0.25,
                                    }}
                                >
                                    {t.rate.toFixed(0)}%
                                </Typography>
                                <Box sx={{ mt: 0.5 }}>
                                    <MagnitudeBar
                                        value={t.rate}
                                        dim={thin}
                                        height={4}
                                        label={`${themeLabel(t.theme)}: ${t.rate.toFixed(0)}% solved`}
                                    />
                                </Box>
                                <Typography
                                    sx={{
                                        fontFamily: 'var(--font-mono)',
                                        fontSize: 10.5,
                                        color: thin ? 'var(--warn)' : 'var(--muted)',
                                        mt: 0.5,
                                        fontVariantNumeric: 'tabular-nums',
                                    }}
                                >
                                    {t.solved}/{t.attempts} solved{thin ? ' · thin' : ''}
                                </Typography>
                                {Number.isFinite(t.avgPuzzleRating) && t.avgPuzzleRating > 0 && (
                                    <Typography
                                        sx={{
                                            fontFamily: 'var(--font-mono)',
                                            fontSize: 10.5,
                                            color: 'var(--muted)',
                                            fontVariantNumeric: 'tabular-nums',
                                        }}
                                    >
                                        avg {Math.round(t.avgPuzzleRating)}
                                    </Typography>
                                )}
                            </Box>
                        )
                    })}
                </Box>
            )}
        </Box>
    )
}
