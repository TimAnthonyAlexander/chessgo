import { Box, Typography } from '@mui/material'
import type { ReactNode } from 'react'
import { Skull, Zap } from 'lucide-react'
import type { Profile, RatingCategory } from '../../api/client'
import { CATEGORY_META } from '../../lib/timeControl'
import { DuckGlyph } from '../DuckGlyph'
import { Panel, PanelHead } from '../home/Panel'
import { TC_CATEGORIES } from './shared'

/** Compact ratings list for the sidebar: one row per pool (denser + more
 * scannable than the old six-tile grid), with the player's primary category
 * subtly highlighted, and puzzle/duck surfaced as accent rows below. */
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
                    accent
                />
                <RatingRow
                    icon={<Skull size={14} />}
                    color="var(--accent)"
                    label="Antichess"
                    rating={profile.antichess.rating}
                    provisional={profile.antichess.provisional}
                    sub={`${profile.antichess.games} ${profile.antichess.games === 1 ? 'game' : 'games'}`}
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
    primary,
    accent,
}: {
    icon: ReactNode
    color: string
    label: string
    rating: number
    provisional: boolean
    sub: string
    primary?: boolean
    accent?: boolean
}) {
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
                <Typography sx={{ fontSize: 11, color: 'var(--muted)' }}>{sub}</Typography>
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
