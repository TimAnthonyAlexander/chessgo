import type { ReactNode } from 'react'
import { Box, Typography } from '@mui/material'

// Small shared primitives for the Premove Trainer's side cards — the same
// shapes Puzzles.tsx keeps as local (unexported) helpers, duplicated here
// (rather than reaching into that file) since this page owns its own
// component directory.

/** Where a live attempt is, once a game exists (see PremoveTrainer.tsx §11):
 *   queuing   — board accepts premove input; GO/Enter/Space releases the chain
 *   releasing — the release request is in flight; input blocked
 *   animating — playing the server's `playout` back at `ply_ms`; input blocked
 *   result    — status !== 'ongoing'; a result card with NEXT
 */
export type Phase = 'queuing' | 'releasing' | 'animating' | 'result'

export function Card({ children, sx }: { children: ReactNode; sx?: object }) {
    return (
        <Box
            sx={{
                bgcolor: 'var(--surface)',
                border: '1px solid var(--line-soft)',
                borderRadius: 'var(--radius)',
                boxShadow: 'var(--shadow)',
                ...sx,
            }}
        >
            {children}
        </Box>
    )
}

export function Chip({ children }: { children: ReactNode }) {
    return (
        <Box
            sx={{
                display: 'inline-flex',
                alignItems: 'center',
                gap: 0.5,
                px: 1,
                py: 0.4,
                borderRadius: 'var(--radius)',
                fontSize: 12.5,
                color: 'var(--text-dim)',
                bgcolor: 'var(--surface-2)',
                border: '1px solid var(--line)',
            }}
        >
            {children}
        </Box>
    )
}

export function Row({ children }: { children: ReactNode }) {
    return <Box sx={{ display: 'flex', alignItems: 'center', gap: 1.25 }}>{children}</Box>
}

/**
 * Which colour the player has. Board orientation alone doesn't answer this
 * legibly in a sparse endgame — with three or four pieces on the board there's
 * no familiar back rank to read it off, and you're always the side to move here,
 * so there's no "whose turn" cue either. It has to be stated.
 */
export function SideBadge({ color }: { color: 'w' | 'b' }) {
    const white = color === 'w'

    return (
        <Box sx={{ display: 'inline-flex', alignItems: 'center', gap: 0.75 }}>
            <Box
                aria-hidden
                sx={{
                    width: 13,
                    height: 13,
                    borderRadius: 'var(--radius)',
                    bgcolor: white ? '#f0efe9' : '#2b2926',
                    border: '1px solid',
                    borderColor: white ? 'rgba(0,0,0,0.35)' : 'rgba(255,255,255,0.45)',
                    flexShrink: 0,
                }}
            />
            <Typography sx={{ fontSize: 13, color: 'var(--text-dim)', whiteSpace: 'nowrap' }}>
                You're {white ? 'White' : 'Black'}
            </Typography>
        </Box>
    )
}

export function Label({ children }: { children: ReactNode }) {
    return (
        <Typography
            sx={{
                fontFamily: 'var(--font-mono)',
                fontSize: 11,
                letterSpacing: '0.16em',
                textTransform: 'uppercase',
                color: 'var(--muted)',
                mb: 1,
            }}
        >
            {children}
        </Typography>
    )
}
