import { Box, Typography } from '@mui/material'
import { Link } from 'react-router-dom'
import type { TutorThemeProfile } from '../../api/client'
import { MagnitudeBar } from './MagnitudeBar'
import { SectionHead } from './parts'
import { confidence, isThin, themeLabel } from './format'

// Matches the id `sections.ts` used to mint for this section's jump-nav
// anchor. Inlined rather than imported: that module is being restructured as
// part of this same redesign and this component owns no say over its shape,
// so a hard string keeps this file compiling independent of that work.
const SECTION_THEMES = 'tutor-section-themes'

/**
 * The report's second, independent line of tactical evidence — solve rate per
 * theme from the player's own puzzle history, weakest first.
 *
 * `comparable` is always false and this component must respect it: the puzzle
 * set carries puzzle ratings but not other players' per-theme results, so there
 * is NO peer column, NO percentile, and NO "vs other players" framing anywhere
 * here. That reasoning belongs in this docblock and not on the page — the
 * backend only sends `note` for the empty state, where it tells the player what
 * to do about it.
 *
 * That is also why it is drawn as a grid of tiles with LEFT-ANCHORED bars and
 * no parity rule, instead of the diverging meter list above it: the shape is
 * the reader's cue that these numbers are measured against nothing but
 * themselves. Now that every peer-compared row on the report is a red/green
 * `SegmentMeter`, staying uncoloured is what keeps this section legible as a
 * different KIND of number — a solve rate painted green would read as a
 * verdict this data cannot support. Player-level (the puzzle pool has no time
 * control), so it renders once per report, not once per category.
 */
export default function ThemeProfileSection({ profile }: { profile?: TutorThemeProfile }) {
    if (!profile) return null

    const themes = [...profile.themes].sort((a, b) => a.rate - b.rate)

    return (
        <Box>
            <SectionHead
                id={SECTION_THEMES}
                title="Tactical themes"
                sub={`Your puzzle history · solve rate, higher is better · no peer comparison`}
            />

            {profile.note && (
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
            )}

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
                                    borderRadius: 'var(--radius)',
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
                                {/* No --good/--bad here on purpose: a solve rate
                                    has no peer figure behind it, so painting it
                                    red or green would assert a verdict ("you're
                                    bad at this") the backend never measured —
                                    only a rate against other PLAYERS could
                                    honestly claim that, and this is a rate
                                    against puzzles. Thin-sample dims it the same
                                    way every other row does; that's the only ink
                                    variation it earns. */}
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
                                        confidence={confidence(t.attempts)}
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
