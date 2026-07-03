import { type ReactNode } from 'react'
import { Box, Typography } from '@mui/material'
import { Crown, Eye, Rabbit, Timer, Zap } from 'lucide-react'
import type { SpectateSide } from '../lib/spectate'
import { type Variant, VARIANT_LABEL } from '../lib/variants'
import { PANEL_SHADOW } from './PanelUI'

/** Left-side card for the spectator view: what kind of game you're watching
 * (time-control category, rated/casual, variant) and who's playing. Mirrors
 * LiveModeCard so the watch page reads like the rest of the app. */
export default function SpectateInfoCard({
    pool,
    rated,
    variant,
    white,
    black,
    moveCount,
    live,
}: {
    pool: string
    rated: boolean
    variant: Variant
    white: SpectateSide
    black: SpectateSide
    moveCount: number
    live: boolean
}) {
    const cat = categoryFor(pool)

    return (
        <Box
            sx={{
                display: { xs: 'none', md: 'block' },
                bgcolor: 'var(--surface)',
                border: '1px solid var(--line-soft)',
                borderRadius: '14px',
                p: 2.5,
                boxShadow: PANEL_SHADOW,
            }}
        >
            <Box sx={{ display: 'flex', alignItems: 'center', gap: 1, color: 'var(--accent)' }}>
                <Eye size={17} />
                <Typography
                    sx={{
                        fontFamily: 'var(--font-mono)',
                        fontSize: 11,
                        letterSpacing: '0.2em',
                        textTransform: 'uppercase',
                        color: 'var(--text-dim)',
                    }}
                >
                    {rated ? 'Rated' : 'Casual'}
                </Typography>
                {variant !== 'standard' && (
                    <Box
                        sx={{
                            ml: 'auto',
                            px: 1,
                            py: 0.3,
                            borderRadius: '6px',
                            fontFamily: 'var(--font-mono)',
                            fontSize: 10.5,
                            fontWeight: 700,
                            letterSpacing: '0.1em',
                            textTransform: 'uppercase',
                            color: 'var(--accent)',
                            bgcolor: 'var(--accent-soft)',
                            border: '1px solid var(--accent-line)',
                        }}
                    >
                        {VARIANT_LABEL[variant]}
                    </Box>
                )}
            </Box>

            <Box sx={{ display: 'flex', alignItems: 'center', gap: 1, mt: 1 }}>
                <Box sx={{ color: 'var(--accent)', display: 'flex' }}>{cat.icon}</Box>
                <Typography
                    sx={{
                        fontFamily: 'var(--font-display)',
                        fontSize: 32,
                        fontWeight: 600,
                        lineHeight: 1,
                    }}
                >
                    {cat.label}
                </Typography>
            </Box>
            <Typography
                sx={{
                    fontFamily: 'var(--font-mono)',
                    fontSize: 14,
                    color: 'var(--text-dim)',
                    mt: 0.75,
                }}
            >
                {pool}
            </Typography>

            <Box sx={{ borderTop: '1px solid var(--line-soft)', mt: 2.25, pt: 2.25 }}>
                <Label>Players</Label>
                <PlayerRow color="w" side={white} />
                <PlayerRow color="b" side={black} sx={{ mt: 1.25 }} />
            </Box>

            <Box sx={{ borderTop: '1px solid var(--line-soft)', mt: 2.25, pt: 2.25 }}>
                <Label>Status</Label>
                <Typography sx={{ fontWeight: 600, fontSize: 15 }}>
                    {live ? 'In progress' : 'Finished'}
                    <Box component="span" sx={{ color: 'var(--text-dim)', fontWeight: 400 }}>
                        {' · '}
                        {moveCount === 1 ? '1 move' : `${moveCount} moves`}
                    </Box>
                </Typography>
            </Box>
        </Box>
    )
}

/** A single player line: a color swatch (white/black to move), name, rating. */
function PlayerRow({ color, side, sx }: { color: 'w' | 'b'; side: SpectateSide; sx?: object }) {
    return (
        <Box sx={{ display: 'flex', alignItems: 'center', gap: 1.25, ...sx }}>
            <Box
                sx={{
                    width: 16,
                    height: 16,
                    flexShrink: 0,
                    borderRadius: '4px',
                    bgcolor: color === 'w' ? '#f0f0f0' : '#2a2a2a',
                    border: '1px solid var(--line)',
                }}
            />
            <Typography sx={{ fontWeight: 600, fontSize: 15, minWidth: 0 }} noWrap>
                {side.name}
            </Typography>
            {!side.anon && (
                <Typography
                    sx={{
                        ml: 'auto',
                        fontFamily: 'var(--font-mono)',
                        fontSize: 13,
                        color: 'var(--text-dim)',
                    }}
                >
                    {side.rating}
                </Typography>
            )}
        </Box>
    )
}

function Label({ children }: { children: ReactNode }) {
    return (
        <Typography
            sx={{
                fontFamily: 'var(--font-mono)',
                fontSize: 10.5,
                letterSpacing: '0.16em',
                textTransform: 'uppercase',
                color: 'var(--muted)',
                mb: 0.75,
            }}
        >
            {children}
        </Typography>
    )
}

/** Map a "base+inc" pool (minutes + seconds) to a Lichess-style category. */
function categoryFor(pool: string): { label: string; icon: ReactNode } {
    const [baseMin, incSec] = pool.split('+').map((n) => Number(n) || 0)
    const estSec = baseMin * 60 + incSec * 40
    if (estSec < 180) return { label: 'Bullet', icon: <Rabbit size={17} /> }
    if (estSec < 480) return { label: 'Blitz', icon: <Zap size={17} /> }
    if (estSec < 1500) return { label: 'Rapid', icon: <Timer size={17} /> }
    return { label: 'Classical', icon: <Crown size={17} /> }
}
