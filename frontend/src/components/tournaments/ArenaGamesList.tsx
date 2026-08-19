import { Box, Typography } from '@mui/material'
import { Link } from 'react-router-dom'
import type { ArenaGame, ArenaGameSide } from '../../api/client'
import TitleBadge from '../TitleBadge'

/** "Games in progress" — live games currently being played inside one running
 * tournament, most-interesting first (server-ordered, capped at 20). Rows link
 * straight into the same spectate view Watch.tsx uses (`/watch/:id`). `null`
 * means "still loading the first poll"; `[]` is a genuine empty tournament and
 * reads as calm, not broken.
 *
 * Sits in a narrow rail beside the standings table on desktop (and full-width,
 * stacked below it, at narrow viewports), so each row stacks its two sides
 * vertically rather than spelling out "A vs B" on one line — that keeps names
 * readable instead of squeezed. The hub's live-games feed doesn't carry a
 * clock (only pool/ply/players), so this shows move count instead. */
export default function ArenaGamesList({ games }: { games: ArenaGame[] | null }) {
    if (games === null) {
        return <Placeholder text="Loading games in progress…" />
    }

    if (games.length === 0) {
        return <Placeholder text="Nothing being played right now." />
    }

    return (
        <Box
            sx={{
                border: '1px solid var(--line-soft)',
                borderRadius: 'var(--radius)',
                bgcolor: 'var(--surface)',
                overflow: 'hidden',
            }}
        >
            {games.map((g, i) => (
                <Box
                    key={g.gameId}
                    component={Link}
                    to={`/watch/${g.gameId}`}
                    sx={{
                        display: 'flex',
                        alignItems: 'flex-start',
                        gap: 1,
                        px: 1.5,
                        py: 1,
                        textDecoration: 'none',
                        color: 'inherit',
                        borderBottom: i < games.length - 1 ? '1px solid var(--line-soft)' : 'none',
                        transition: 'background-color .1s ease',
                        '&:hover': { bgcolor: 'var(--surface-2)' },
                    }}
                >
                    <Box sx={{ display: 'flex', flexDirection: 'column', gap: 0.5, minWidth: 0, flex: 1 }}>
                        <Side label="W" side={g.white} />
                        <Side label="B" side={g.black} />
                    </Box>
                    <Typography
                        sx={{
                            flexShrink: 0,
                            mt: 0.2,
                            fontFamily: 'var(--font-mono)',
                            fontSize: 11.5,
                            color: 'var(--text-dim)',
                        }}
                    >
                        {g.ply} {g.ply === 1 ? 'ply' : 'plies'}
                    </Typography>
                </Box>
            ))}
        </Box>
    )
}

function Side({ label, side }: { label: 'W' | 'B'; side: ArenaGameSide }) {
    return (
        <Box sx={{ display: 'flex', alignItems: 'center', gap: 0.5, minWidth: 0 }}>
            <Box
                component="span"
                sx={{
                    fontFamily: 'var(--font-mono)',
                    fontSize: 10.5,
                    fontWeight: 700,
                    color: 'var(--muted)',
                    flexShrink: 0,
                }}
            >
                {label}
            </Box>
            <TitleBadge title={side.title} />
            <Typography noWrap sx={{ fontSize: 13, fontWeight: 600, minWidth: 0 }}>
                {side.name ?? 'Unknown'}
            </Typography>
            {side.rating != null && (
                <Typography
                    sx={{
                        fontFamily: 'var(--font-mono)',
                        fontSize: 11.5,
                        color: 'var(--text-dim)',
                        flexShrink: 0,
                    }}
                >
                    {side.rating}
                </Typography>
            )}
        </Box>
    )
}

function Placeholder({ text }: { text: string }) {
    return (
        <Box
            sx={{
                py: 5,
                textAlign: 'center',
                color: 'var(--muted)',
                fontSize: 13.5,
                border: '1px dashed var(--line)',
                borderRadius: 'var(--radius)',
            }}
        >
            {text}
        </Box>
    )
}
