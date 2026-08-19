import { Box, Typography } from '@mui/material'
import { CircleAlert, Equal } from 'lucide-react'
import MiniBoard from '../../MiniBoard'
import { metaBool, metaStr } from './shared'

/** The `analysis_during_game` evidence view: the position the player fetched from
 * an analysis endpoint next to the live game position at that moment, as two mini
 * boards. When the two boards are byte-identical the backend sets `exact_match` —
 * the near-zero-false-positive signal — which we surface as a bold badge. */
export default function ExactMatchBoards({ meta }: { meta: Record<string, unknown> }) {
    const analyzed = metaStr(meta, 'analyzed_fen')
    const live = metaStr(meta, 'live_fen')
    const endpoint = metaStr(meta, 'endpoint')
    const exact = metaBool(meta, 'exact_match') === true

    return (
        <Box sx={{ display: 'flex', flexDirection: 'column', gap: 1.25 }}>
            {exact && (
                <Box
                    sx={{
                        display: 'inline-flex',
                        alignSelf: 'flex-start',
                        alignItems: 'center',
                        gap: 0.75,
                        px: 1.25,
                        py: 0.625,
                        borderRadius: 'var(--radius)',
                        bgcolor: 'color-mix(in srgb, #ca4a4a 18%, transparent)',
                        border: '1px solid color-mix(in srgb, #ca4a4a 46%, transparent)',
                        color: '#e06a6a',
                    }}
                >
                    <CircleAlert size={15} />
                    <Typography
                        sx={{
                            fontFamily: 'var(--font-mono)',
                            fontSize: 11.5,
                            fontWeight: 800,
                            letterSpacing: '0.08em',
                        }}
                    >
                        EXACT BOARD MATCH
                    </Typography>
                </Box>
            )}

            <Box
                sx={{
                    display: 'grid',
                    gridTemplateColumns: { xs: '1fr', sm: '1fr auto 1fr' },
                    alignItems: 'center',
                    gap: 1.5,
                }}
            >
                <BoardCell title="Analyzed position" fen={analyzed} accent={exact} />
                <Box
                    sx={{
                        display: 'flex',
                        justifyContent: 'center',
                        color: exact ? '#e06a6a' : 'var(--muted)',
                    }}
                >
                    <Equal size={20} />
                </Box>
                <BoardCell title="Live game position" fen={live} accent={exact} />
            </Box>

            {endpoint && (
                <Typography sx={{ fontSize: 11.5, color: 'var(--text-dim)' }}>
                    Endpoint:{' '}
                    <Box
                        component="span"
                        sx={{ fontFamily: 'var(--font-mono)', color: 'var(--text)' }}
                    >
                        {endpoint}
                    </Box>
                </Typography>
            )}
        </Box>
    )
}

function BoardCell({ title, fen, accent }: { title: string; fen: string | null; accent: boolean }) {
    return (
        <Box sx={{ minWidth: 0 }}>
            <Typography
                sx={{
                    fontFamily: 'var(--font-mono)',
                    fontSize: 9.5,
                    letterSpacing: '0.1em',
                    textTransform: 'uppercase',
                    color: 'var(--muted)',
                    mb: 0.625,
                }}
            >
                {title}
            </Typography>
            <Box
                sx={{
                    width: '100%',
                    maxWidth: 180,
                    borderRadius: 'var(--radius)',
                    overflow: 'hidden',
                    border: '2px solid',
                    borderColor: accent
                        ? 'color-mix(in srgb, #ca4a4a 55%, transparent)'
                        : 'var(--line-soft)',
                }}
            >
                {fen ? (
                    <MiniBoard fen={fen} />
                ) : (
                    <Box
                        sx={{
                            aspectRatio: '1',
                            display: 'flex',
                            alignItems: 'center',
                            justifyContent: 'center',
                            bgcolor: 'var(--surface-2)',
                            color: 'var(--muted)',
                            fontSize: 11.5,
                        }}
                    >
                        no FEN
                    </Box>
                )}
            </Box>
            {fen && (
                <Typography
                    sx={{
                        fontFamily: 'var(--font-mono)',
                        fontSize: 9.5,
                        color: 'var(--muted)',
                        mt: 0.5,
                        wordBreak: 'break-all',
                        maxWidth: 180,
                    }}
                >
                    {fen}
                </Typography>
            )}
        </Box>
    )
}
