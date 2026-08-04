import { Box, Typography } from '@mui/material'
import { fmtValue, type TutorUnit } from './format'

/** A horizontal bar comparing "yours" against a peer figure — the hand-rolled
 * chart primitive Tutor uses for phases/pieces/openings (no charting library
 * in this project; see RatingSparkline for the sibling idiom on line charts).
 * The peer figure is drawn as a thin tick over the same track rather than its
 * own bar, so the two never fight for attention. Neutral colouring always —
 * only the strengths/weaknesses list is allowed to use --danger. */
export default function BarCompare({
    label,
    mine,
    peer,
    sample,
    peerSample,
    unit,
    showPeer = true,
}: {
    label: string
    mine: number
    peer: number
    sample: number
    peerSample?: number
    unit: TutorUnit
    showPeer?: boolean
}) {
    const max = Math.max(Math.abs(mine), Math.abs(peer), 1e-6)
    const minePct = Math.min(100, (Math.abs(mine) / max) * 100)
    const peerPct = Math.min(100, (Math.abs(peer) / max) * 100)

    return (
        <Box sx={{ py: 1 }}>
            <Box sx={{ display: 'flex', justifyContent: 'space-between', gap: 1.5, mb: 0.5 }}>
                <Typography sx={{ fontSize: 13, minWidth: 0 }}>{label}</Typography>
                <Typography
                    sx={{
                        fontFamily: 'var(--font-mono)',
                        fontSize: 12,
                        color: 'var(--text-dim)',
                        flexShrink: 0,
                        whiteSpace: 'nowrap',
                    }}
                >
                    {fmtValue(mine, unit)}
                    {showPeer && ` · peer ${fmtValue(peer, unit)}`}
                </Typography>
            </Box>
            <Box
                sx={{
                    position: 'relative',
                    height: 6,
                    bgcolor: 'var(--surface-2)',
                    borderRadius: '999px',
                }}
            >
                <Box
                    sx={{
                        position: 'absolute',
                        inset: 0,
                        width: `${minePct}%`,
                        bgcolor: 'var(--accent)',
                        borderRadius: '999px',
                    }}
                />
                {showPeer && (
                    <Box
                        sx={{
                            position: 'absolute',
                            top: -2,
                            bottom: -2,
                            left: `${peerPct}%`,
                            width: 2,
                            bgcolor: 'var(--text-dim)',
                            borderRadius: '999px',
                        }}
                    />
                )}
            </Box>
            <Typography sx={{ fontSize: 11, color: 'var(--muted)', mt: 0.4 }}>
                {sample} {sample === 1 ? 'game' : 'games'}
                {showPeer && peerSample != null ? ` · peer sample ${peerSample}` : ''}
            </Typography>
        </Box>
    )
}
