import { Box, Typography } from '@mui/material'
import type { ReactNode } from 'react'
import { Puzzle } from 'lucide-react'
import type { AdminUserRecord } from '../../../api/client'
import { CATEGORY_META } from '../../../lib/timeControl'
import { Panel, PanelHead } from '../../home/Panel'
import { DuckGlyph } from '../../DuckGlyph'
import { RATING_COLS, recordGames, recordRating } from './shared'

/** All of the account's ratings as dashboard-style tiles: the four time controls
 * up top, then the isolated pools (puzzle + duck) as accent tiles. Each shows the
 * rating (mono), the game count, and a provisional "?" when the pool is unsettled. */
export default function UserRatingsGrid({ user }: { user: AdminUserRecord }) {
    const prov = user.provisional ?? {}
    return (
        <Panel>
            <PanelHead title="Ratings" sub="Per-pool Glicko-2 (? = provisional)" />
            <Box
                sx={{
                    display: 'grid',
                    gap: 1.25,
                    gridTemplateColumns: { xs: 'repeat(2, 1fr)', sm: 'repeat(4, 1fr)' },
                }}
            >
                {RATING_COLS.map((c) => {
                    const meta = CATEGORY_META[c.label]
                    const Icon = meta.Icon
                    return (
                        <RatingTile
                            key={c.key}
                            icon={<Icon size={14} />}
                            color={c.color}
                            label={c.label}
                            rating={recordRating(user, c.key)}
                            games={recordGames(user, c.key)}
                            provisional={!!prov[c.key]}
                        />
                    )
                })}
            </Box>

            <Box
                sx={{
                    display: 'grid',
                    gap: 1.25,
                    mt: 1.25,
                    gridTemplateColumns: { xs: 'repeat(2, 1fr)', sm: 'repeat(4, 1fr)' },
                }}
            >
                <RatingTile
                    icon={<Puzzle size={14} />}
                    color="var(--accent)"
                    label="Puzzles"
                    rating={user.rating_puzzle}
                    games={user.games_puzzle}
                    provisional={!!prov.puzzle}
                    accent
                />
                <RatingTile
                    icon={
                        <Box component="span" sx={{ display: 'flex', fontSize: 14 }}>
                            <DuckGlyph />
                        </Box>
                    }
                    color="var(--accent)"
                    label="Duck"
                    rating={user.rating_duck}
                    games={user.games_duck}
                    provisional={!!prov.duck}
                    accent
                />
            </Box>
        </Panel>
    )
}

function RatingTile({
    icon,
    color,
    label,
    rating,
    games,
    provisional,
    accent,
}: {
    icon: ReactNode
    color: string
    label: string
    rating: number
    games: number
    provisional: boolean
    accent?: boolean
}) {
    const played = games > 0
    return (
        <Box
            sx={{
                bgcolor: accent ? 'var(--accent-soft)' : 'var(--surface-2)',
                border: `1px solid ${accent ? 'var(--accent-line)' : 'var(--line-soft)'}`,
                borderRadius: '12px',
                p: 1.5,
            }}
        >
            <Box sx={{ display: 'flex', alignItems: 'center', gap: 0.6, color }}>
                {icon}
                <Typography
                    sx={{
                        fontFamily: 'var(--font-mono)',
                        fontSize: 10,
                        letterSpacing: '0.12em',
                        textTransform: 'uppercase',
                        color: 'var(--text-dim)',
                    }}
                >
                    {label}
                </Typography>
            </Box>
            <Typography
                sx={{
                    fontFamily: 'var(--font-mono)',
                    fontSize: 22,
                    fontWeight: 700,
                    lineHeight: 1,
                    mt: 1,
                    color: played ? 'var(--text)' : 'var(--muted)',
                }}
            >
                {rating}
                {provisional && (
                    <Box component="span" sx={{ color: 'var(--muted)', fontSize: 15 }}>
                        ?
                    </Box>
                )}
            </Typography>
            <Typography sx={{ fontSize: 11.5, color: 'var(--muted)', mt: 0.5 }}>
                {games} {games === 1 ? 'game' : 'games'}
            </Typography>
        </Box>
    )
}
