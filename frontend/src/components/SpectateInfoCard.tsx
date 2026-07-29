import { type ReactNode, useMemo } from 'react'
import { Box, Typography } from '@mui/material'
import { Crown, Rabbit, Timer, Zap } from 'lucide-react'
import { type Variant, VARIANT_LABEL } from '../lib/variants'
import { computeMaterial } from '../lib/material'
import { useSetting } from '../lib/settings'
import { PANEL_SHADOW } from './PanelUI'

// The left column complements the right panel rather than echoing it. The right
// panel already carries the pool, rated badge, player names + clocks and the move
// list — so this card deliberately adds only what's NOT there: the human-readable
// time-control category (the right side shows the raw "3+2" pool only) and a live
// captured-material readout, the one thing a spectator most wants at a glance.
export default function SpectateInfoCard({
    pool,
    variant,
    fen,
}: {
    pool: string
    variant: Variant
    fen: string
}) {
    const cat = categoryFor(pool)
    const mat = useMemo(() => computeMaterial(fen), [fen])
    // Single-key subscription — the showCaptured preference gates this card's
    // Material section the same way it gates the equivalent readouts in
    // LiveGame/BotGame, so one global switch behaves consistently everywhere.
    const showCaptured = useSetting('showCaptured')

    return (
        <Box
            sx={{
                display: { xs: 'none', md: 'block' },
                bgcolor: 'var(--surface)',
                border: '1px solid var(--line-soft)',
                borderRadius: 'var(--panel-radius)',
                p: 2.5,
                boxShadow: PANEL_SHADOW,
            }}
        >
            <Box sx={{ display: 'flex', alignItems: 'center', gap: 1 }}>
                <Box sx={{ color: 'var(--accent)', display: 'flex' }}>{cat.icon}</Box>
                <Typography
                    sx={{
                        fontFamily: 'var(--font-display)',
                        fontSize: 24,
                        fontWeight: 600,
                        lineHeight: 1,
                    }}
                >
                    {cat.label}
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

            {showCaptured && (
            <Box sx={{ borderTop: '1px solid var(--line-soft)', mt: 2, pt: 2 }}>
                <Label>Material</Label>
                <Box sx={{ display: 'flex', flexDirection: 'column', gap: 1.25, mt: 1 }}>
                    <MaterialRow
                        label="White"
                        pieces={mat.capturedByWhite}
                        color="b"
                        adv={mat.diff > 0 ? mat.diff : 0}
                    />
                    <Box sx={{ height: '1px', bgcolor: 'var(--line-soft)' }} />
                    <MaterialRow
                        label="Black"
                        pieces={mat.capturedByBlack}
                        color="w"
                        adv={mat.diff < 0 ? -mat.diff : 0}
                    />
                </Box>
            </Box>
            )}
        </Box>
    )
}

/** One side's captured pieces (opponent's color) + a material advantage badge. */
function MaterialRow({
    label,
    pieces,
    color,
    adv,
}: {
    label: string
    pieces: string[]
    color: 'w' | 'b'
    adv: number
}) {
    return (
        <Box sx={{ display: 'flex', alignItems: 'center', gap: 1, minHeight: 24 }}>
            <Typography
                sx={{
                    width: 44,
                    flexShrink: 0,
                    fontSize: 12.5,
                    fontWeight: 600,
                    letterSpacing: 0.3,
                    color: 'var(--text-dim)',
                }}
            >
                {label}
            </Typography>
            <Box
                sx={{
                    flex: 1,
                    display: 'flex',
                    flexWrap: 'wrap',
                    alignItems: 'center',
                    gap: '1px',
                    minWidth: 0,
                }}
            >
                {pieces.length === 0 ? (
                    <Typography sx={{ fontSize: 13, color: 'var(--muted)' }}>—</Typography>
                ) : (
                    pieces.map((t, i) => (
                        <Box
                            key={i}
                            component="img"
                            src={`/piece/cburnett/${color}${t}.svg`}
                            alt={t}
                            sx={{
                                width: 20,
                                height: 20,
                                ml: i > 0 && pieces[i - 1] === t ? '-7px' : 0,
                            }}
                        />
                    ))
                )}
            </Box>
            {adv > 0 && (
                <Typography
                    sx={{
                        fontFamily: 'var(--font-mono)',
                        fontSize: 13.5,
                        fontWeight: 700,
                        color: 'var(--accent)',
                    }}
                >
                    +{adv}
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
