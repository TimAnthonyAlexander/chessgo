import { Box, Typography } from '@mui/material'
import { Link } from 'react-router-dom'
import type { TutorCategoryReport } from '../../api/client'
import StatRow from './StatRow'
import { cap, fmtGames, fmtValue } from './format'

/**
 * One rating category, one block — this IS the report now.
 *
 * A header states what the numbers below are measured against (never leave a
 * bare "78%" to be guessed at), up to ten `StatRow`s carry the comparisons,
 * and a single "See more" exit hands off to the category's own detail page —
 * everything that used to share this screen (findings, the full metric table,
 * openings, themes) lives there instead.
 *
 * Rows are ordered by |importance| (grade × sqrt(evidence × level weight)),
 * descending — the same figure the backend already uses to pick its own
 * strengths/weaknesses and the report's headline (see `topFinding` in
 * ReportHero.tsx), so the ordering on this block never disagrees with the
 * ordering the rest of the report is built from. That puts the biggest win
 * and the biggest leak together at the top, rather than a strict worst-first
 * ladder that would bury a strength below eight weaker rows.
 *
 * Capped at 10: every real report currently carries exactly 11 plain
 * comparisons per category (one per metric), and sorted by importance the
 * 11th is reliably the smallest-magnitude row on the page — cutting it loses
 * nothing sorting hasn't already pushed to the bottom.
 *
 * `peer.tier === 'none'` means the backend found no band to compare against
 * at all — `comparisons` is empty in that case, so there is nothing to feed a
 * meter. This reads `metrics` instead (the player's raw values) and draws no
 * meters, per contract: a meter with no comparison behind it is a guess
 * wearing a verdict's colours.
 */
export default function CategoryOverview({
    category,
    reportId,
}: {
    category: TutorCategoryReport
    reportId: string
}) {
    const { peer } = category
    const noPeer = peer.tier === 'none'

    const rows = noPeer
        ? []
        : [...category.comparisons]
              .filter((c) => c.dimension === '')
              .sort((a, b) => Math.abs(b.importance) - Math.abs(a.importance))
              .slice(0, 10)

    return (
        <Box>
            <Box
                sx={{
                    display: 'flex',
                    alignItems: 'baseline',
                    justifyContent: 'space-between',
                    gap: 1.5,
                    mb: 0.25,
                }}
            >
                <Typography
                    component="h2"
                    sx={{
                        fontFamily: 'var(--font-display)',
                        fontSize: 18,
                        fontWeight: 700,
                        color: 'var(--text)',
                    }}
                >
                    {cap(category.category)}
                </Typography>
                <Box
                    component={Link}
                    to={`/tutor/${reportId}/${category.category}`}
                    sx={{
                        fontSize: 12.5,
                        fontWeight: 600,
                        color: 'var(--accent)',
                        textDecoration: 'none',
                        whiteSpace: 'nowrap',
                        '&:hover': { textDecoration: 'underline' },
                    }}
                >
                    See more
                </Box>
            </Box>

            <Typography sx={{ fontSize: 12.5, color: 'var(--muted)', mb: 1.5 }}>
                {fmtGames(category.games)}
                {category.capHit ? ` of ${category.gamesAvailable}` : ''}
                {noPeer
                    ? ' · no comparison band yet'
                    : ` · vs ${peer.bandFrom}–${peer.bandTo}${
                          peer.tier === 'widened' ? ' (widened)' : ''
                      }`}
            </Typography>

            {noPeer ? (
                <Box>
                    <Typography
                        sx={{ fontSize: 13, color: 'var(--text-dim)', mb: 1.5, lineHeight: 1.55 }}
                    >
                        Not enough players at your rating yet to compare against — these are your
                        numbers alone.
                    </Typography>
                    <Box sx={{ display: 'flex', flexDirection: 'column' }}>
                        {Object.entries(category.metrics).map(([metric, m]) => (
                            <Box
                                key={metric}
                                sx={{
                                    display: 'flex',
                                    justifyContent: 'space-between',
                                    alignItems: 'baseline',
                                    gap: 1.5,
                                    py: 0.85,
                                }}
                            >
                                <Typography sx={{ fontSize: 13.5, color: 'var(--text)' }}>
                                    {m.label}
                                </Typography>
                                <Typography
                                    sx={{
                                        fontFamily: 'var(--font-mono)',
                                        fontSize: 13,
                                        fontWeight: 700,
                                        color: 'var(--text-dim)',
                                        fontVariantNumeric: 'tabular-nums',
                                        whiteSpace: 'nowrap',
                                    }}
                                >
                                    {fmtValue(m.value, m.unit)}
                                </Typography>
                            </Box>
                        ))}
                    </Box>
                </Box>
            ) : (
                <Box>
                    {rows.map((c, i) => (
                        <StatRow key={`${c.metric}-${i}`} c={c} />
                    ))}
                </Box>
            )}
        </Box>
    )
}
