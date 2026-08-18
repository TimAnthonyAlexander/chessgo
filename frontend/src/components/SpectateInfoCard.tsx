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
    rated,
    live,
    flat = false,
}: {
    pool: string
    variant: Variant
    fen: string
    rated: boolean
    /** Game still in progress — drives the Live marker. */
    live: boolean
    /** Drop this card's own chrome and end in a hairline, so it can head the game
     *  panel as its first block instead of standing as a separate card. The
     *  side-rail layout uses this: mode first, then the moves, one continuous box.
     *  The contents are unchanged — unlike the game pages' mode cards, this one
     *  also carries the captured-material readout, and the side rail has no player
     *  strips to move that into. */
    flat?: boolean
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
                bgcolor: flat ? 'var(--bg-2)' : 'var(--surface)',
                border: flat ? 'none' : '1px solid var(--line-soft)',
                borderBottom: flat ? '1px solid var(--line-soft)' : undefined,
                borderRadius: flat ? 0 : 'var(--panel-radius)',
                p: flat ? 1.75 : 2.5,
                boxShadow: flat ? 'none' : PANEL_SHADOW,
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

            {/* Rated/casual, the pool, and the Live marker — these used to sit in the
                right panel's header row, which is gone; this card is the one place the
                game's mode is described now. */}
            <Box sx={{ display: 'flex', alignItems: 'center', gap: 1, mt: 1.25 }}>
                <Typography
                    sx={{
                        fontFamily: 'var(--font-mono)',
                        fontSize: 13,
                        color: 'var(--text-dim)',
                    }}
                >
                    {pool}
                </Typography>
                <Box
                    sx={{
                        px: 1,
                        py: 0.3,
                        borderRadius: '6px',
                        fontSize: 10.5,
                        fontWeight: 700,
                        letterSpacing: '0.1em',
                        textTransform: 'uppercase',
                        border: '1px solid',
                        color: rated ? 'var(--accent)' : 'var(--text-dim)',
                        bgcolor: rated ? 'var(--accent-soft)' : 'transparent',
                        borderColor: rated ? 'var(--accent-line)' : 'var(--line)',
                    }}
                >
                    {rated ? 'Rated' : 'Casual'}
                </Box>
                {live && (
                    <Box
                        sx={{
                            ml: 'auto',
                            display: 'flex',
                            alignItems: 'center',
                            gap: 0.5,
                            fontSize: 10,
                            fontWeight: 700,
                            letterSpacing: '0.1em',
                            textTransform: 'uppercase',
                            color: '#7bb661',
                        }}
                    >
                        <Box
                            sx={{ width: 6, height: 6, borderRadius: '50%', bgcolor: '#7bb661' }}
                        />
                        Live
                    </Box>
                )}
            </Box>

            {showCaptured && (
            <Box sx={{ borderTop: '1px solid var(--line-soft)', mt: 2, pt: 2 }}>
                <Label>Material</Label>
                <Box sx={{ display: 'flex', flexDirection: 'column', gap: 1.25, mt: 1 }}>
                    <MaterialRow label="White" pieces={mat.capturedByWhite} color="b" />
                    <Box sx={{ height: '1px', bgcolor: 'var(--line-soft)' }} />
                    <MaterialRow label="Black" pieces={mat.capturedByBlack} color="w" />
                </Box>
            </Box>
            )}
        </Box>
    )
}

/** One side's captured pieces (the opponent's colour). No numeric advantage — the
 *  pieces themselves say who is up and by how much. */
function MaterialRow({
    label,
    pieces,
    color,
}: {
    label: string
    pieces: string[]
    color: 'w' | 'b'
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
