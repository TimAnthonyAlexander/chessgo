import { Box, Typography } from '@mui/material'
import type { ReactNode } from 'react'
import { Skull, Zap } from 'lucide-react'
import type { Profile, RatingCategory } from '../../api/client'
import { CATEGORY_META } from '../../lib/timeControl'
import { DuckGlyph } from '../DuckGlyph'
import { Panel, PanelHead } from '../home/Panel'
import RatingSparkline from './RatingSparkline'
import { seriesDelta, TC_CATEGORIES } from './shared'

/** Compact ratings list for the sidebar: one row per pool (denser + more
 * scannable than the old six-tile grid), with the player's primary category
 * subtly highlighted, and puzzle/duck/crazyhouse/antichess surfaced as accent
 * rows below. Every pool gets its own small trend sparkline (from
 * `profile.ratingHistory`).
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
        <Panel>
            <PanelHead title="Ratings" />
            <Box sx={{ display: 'flex', flexDirection: 'column', gap: 0.75 }}>
                {TC_CATEGORIES.map(({ key, label }) => {
                    const t = profile.ratings[key]
                    const { color, Icon } = CATEGORY_META[label]
                    return (
                        <RatingRow
                            key={key}
                            icon={<Icon size={15} />}
                            color={color}
                            label={label}
                            rating={t.rating}
                            provisional={t.provisional}
                            sub={`${t.games} ${t.games === 1 ? 'game' : 'games'}`}
                            series={profile.ratingHistory[key] ?? []}
                            primary={key === primaryKey}
                        />
                    )
                })}

                <Box sx={{ height: 1, bgcolor: 'var(--line-soft)', my: 0.5 }} />

                <RatingRow
                    icon={<Zap size={14} />}
                    color="var(--accent)"
                    label="Puzzles"
                    rating={profile.puzzle.rating}
                    provisional={profile.puzzle.provisional}
                    sub={`${profile.puzzle.solved}W ${profile.puzzle.games - profile.puzzle.solved}L`}
                    series={profile.ratingHistory.puzzle ?? []}
                    accent
                />
                <RatingRow
                    icon={
                        <Box component="span" sx={{ display: 'flex', fontSize: 14 }}>
                            <DuckGlyph />
                        </Box>
                    }
                    color="var(--accent)"
                    label="Duck"
                    rating={profile.duck.rating}
                    provisional={profile.duck.provisional}
                    sub={`${profile.duck.games} ${profile.duck.games === 1 ? 'game' : 'games'}`}
                    series={profile.ratingHistory.duck ?? []}
                    accent
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
                    color="var(--accent)"
                    label="Crazyhouse"
                    rating={profile.crazyhouse.rating}
                    provisional={profile.crazyhouse.provisional}
                    sub={`${profile.crazyhouse.games} ${profile.crazyhouse.games === 1 ? 'game' : 'games'}`}
                    series={profile.ratingHistory.crazyhouse ?? []}
                    accent
                />
                <RatingRow
                    icon={<Skull size={14} />}
                    color="var(--accent)"
                    label="Antichess"
                    rating={profile.antichess.rating}
                    provisional={profile.antichess.provisional}
                    sub={`${profile.antichess.games} ${profile.antichess.games === 1 ? 'game' : 'games'}`}
                    series={profile.ratingHistory.antichess ?? []}
                    accent
                />
            </Box>
        </Panel>
    )
}

function RatingRow({
    icon,
    color,
    label,
    rating,
    provisional,
    sub,
    series,
    primary,
    accent,
}: {
    icon: ReactNode
    color: string
    label: string
    rating: number
    provisional: boolean
    sub: string
    series: number[]
    primary?: boolean
    accent?: boolean
}) {
    const delta = seriesDelta(series)
    return (
        <Box
            sx={{
                display: 'flex',
                alignItems: 'center',
                gap: 1.25,
                px: 1.25,
                py: 1,
                borderRadius: '10px',
                bgcolor: primary || accent ? 'var(--accent-soft)' : 'transparent',
                border: primary ? '1px solid var(--accent-line)' : '1px solid transparent',
            }}
        >
            <Box sx={{ display: 'flex', color, flexShrink: 0 }}>{icon}</Box>
            <Box sx={{ minWidth: 0, flex: 1 }}>
                <Typography sx={{ fontSize: 13.5, fontWeight: 600, color: 'var(--text)' }}>
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
                                color: delta > 0 ? '#5b9e5b' : '#ca4a4a',
                            }}
                        >
                            {delta > 0 ? '+' : ''}
                            {delta}
                        </Typography>
                    )}
                </Box>
            </Box>
            <Box sx={{ width: 44, height: 20, flexShrink: 0, display: 'flex', alignItems: 'center' }}>
                <RatingSparkline series={series} color={color} width={44} height={20} />
            </Box>
            <Typography
                sx={{
                    fontFamily: 'var(--font-mono)',
                    fontSize: 18,
                    fontWeight: 700,
                    lineHeight: 1,
                    flexShrink: 0,
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
