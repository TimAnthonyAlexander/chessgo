import { Box, Typography } from '@mui/material'
import type { ReactNode } from 'react'
import { Skull, Zap } from 'lucide-react'
import type { Profile, RatingCategory } from '../../api/client'
import { CATEGORY_META } from '../../lib/timeControl'
import { DuckGlyph } from '../DuckGlyph'
import RatingSparkline from './RatingSparkline'
import { OUTCOME_STYLE, seriesDelta, TC_CATEGORIES } from './shared'

/** Compact ratings list for the sidebar: one row per pool (denser + more
 * scannable than the old six-tile grid), with the player's primary category
 * marked by weight alone — every pool's icon is neutral now, since the icon
 * shape already tells pools apart and a rainbow of per-category colours next
 * to each other was the loudest thing on the page. Each row gets its own small
 * trend sparkline (from `profile.ratingHistory`), tinted by the one thing that
 * IS real data here: whether the trend is up or down.
 *
 * This is the ONE place the profile shows ratings — the hero above used to
 * repeat the primary pool's number and sparkline, which was the same row twice
 * in two styles. Keep it that way. */
export default function RatingsPanel({
    profile,
    primaryKey,
}: {
    profile: Profile
    primaryKey: RatingCategory | null
}) {
    return (
        <Box sx={{ pt: 2.5, borderTop: '1px solid var(--line-soft)' }}>
            <Typography
                sx={{
                    fontFamily: 'var(--font-display)',
                    fontSize: 18,
                    fontWeight: 700,
                    lineHeight: 1.1,
                    mb: 1,
                }}
            >
                Ratings
            </Typography>
            <Box sx={{ display: 'flex', flexDirection: 'column' }}>
                {TC_CATEGORIES.map(({ key, label }) => {
                    const t = profile.ratings[key]
                    const { Icon } = CATEGORY_META[label]
                    return (
                        <RatingRow
                            key={key}
                            icon={<Icon size={15} />}
                            label={label}
                            rating={t.rating}
                            provisional={t.provisional}
                            sub={`${t.games} ${t.games === 1 ? 'game' : 'games'}`}
                            series={profile.ratingHistory[key] ?? []}
                            primary={key === primaryKey}
                        />
                    )
                })}

                <Box sx={{ height: 1, bgcolor: 'var(--line-soft)', my: 1 }} />

                <RatingRow
                    icon={<Zap size={14} />}
                    label="Puzzles"
                    rating={profile.puzzle.rating}
                    provisional={profile.puzzle.provisional}
                    sub={`${profile.puzzle.solved}W ${profile.puzzle.games - profile.puzzle.solved}L`}
                    series={profile.ratingHistory.puzzle ?? []}
                />
                <RatingRow
                    icon={
                        <Box component="span" sx={{ display: 'flex', fontSize: 14 }}>
                            <DuckGlyph mono />
                        </Box>
                    }
                    label="Duck"
                    rating={profile.duck.rating}
                    provisional={profile.duck.provisional}
                    sub={`${profile.duck.games} ${profile.duck.games === 1 ? 'game' : 'games'}`}
                    series={profile.ratingHistory.duck ?? []}
                />
                <RatingRow
                    icon={
                        <Box
                            component="span"
                            sx={{ fontSize: 14, lineHeight: 1, display: 'flex' }}
                            aria-hidden
                        >
                            ⇄
                        </Box>
                    }
                    label="Crazyhouse"
                    rating={profile.crazyhouse.rating}
                    provisional={profile.crazyhouse.provisional}
                    sub={`${profile.crazyhouse.games} ${profile.crazyhouse.games === 1 ? 'game' : 'games'}`}
                    series={profile.ratingHistory.crazyhouse ?? []}
                />
                <RatingRow
                    icon={<Skull size={14} />}
                    label="Antichess"
                    rating={profile.antichess.rating}
                    provisional={profile.antichess.provisional}
                    sub={`${profile.antichess.games} ${profile.antichess.games === 1 ? 'game' : 'games'}`}
                    series={profile.ratingHistory.antichess ?? []}
                />
            </Box>
        </Box>
    )
}

function RatingRow({
    icon,
    label,
    rating,
    provisional,
    sub,
    series,
    primary,
}: {
    icon: ReactNode
    label: string
    rating: number
    provisional: boolean
    sub: string
    series: number[]
    primary?: boolean
}) {
    const delta = seriesDelta(series)
    const trendColor =
        delta == null || delta === 0
            ? 'var(--muted)'
            : delta > 0
              ? OUTCOME_STYLE.win.color
              : OUTCOME_STYLE.loss.color

    return (
        <Box
            sx={{
                display: 'flex',
                alignItems: 'center',
                gap: 1.25,
                py: 1,
                borderTop: '1px solid var(--line-soft)',
                '&:first-of-type': { borderTop: 'none' },
            }}
        >
            <Box sx={{ display: 'flex', color: 'var(--muted)', flexShrink: 0 }}>{icon}</Box>
            <Box sx={{ minWidth: 0, flex: 1 }}>
                <Typography
                    sx={{ fontSize: 13.5, fontWeight: primary ? 700 : 500, color: 'var(--text)' }}
                >
                    {label}
                </Typography>
                <Box sx={{ display: 'flex', alignItems: 'center', gap: 0.6 }}>
                    <Typography sx={{ fontSize: 11, color: 'var(--muted)' }}>{sub}</Typography>
                    {/* Net change across the sparkline's window. The sparkline shows
                        direction; this is the magnitude the hero's old call-out used
                        to carry, kept here so removing that call-out lost nothing. */}
                    {delta != null && delta !== 0 && (
                        <Typography
                            sx={{
                                fontFamily: 'var(--font-mono)',
                                fontSize: 11,
                                fontWeight: 700,
                                fontVariantNumeric: 'tabular-nums',
                                color: trendColor,
                            }}
                        >
                            {delta > 0 ? '+' : ''}
                            {delta}
                        </Typography>
                    )}
                </Box>
            </Box>
            <Box sx={{ width: 44, height: 20, flexShrink: 0, display: 'flex', alignItems: 'center' }}>
                <RatingSparkline series={series} color={trendColor} width={44} height={20} />
            </Box>
            <Typography
                sx={{
                    fontFamily: 'var(--font-mono)',
                    fontSize: 18,
                    fontWeight: 700,
                    lineHeight: 1,
                    flexShrink: 0,
                    fontVariantNumeric: 'tabular-nums',
                    minWidth: 46,
                    textAlign: 'right',
                }}
            >
                {rating}
                {provisional && (
                    <Box component="span" sx={{ color: 'var(--muted)', fontSize: 13 }}>
                        ?
                    </Box>
                )}
            </Typography>
        </Box>
    )
}
