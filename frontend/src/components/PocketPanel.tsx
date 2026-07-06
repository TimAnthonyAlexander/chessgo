import { Box, Typography } from '@mui/material'
import type { Color } from '../api/client'
import Pocket from './Pocket'
import type { PocketPiece, Pockets } from '../lib/variants'

const other = (c: Color): Color => (c === 'w' ? 'b' : 'w')

/**
 * The Crazyhouse "in hand" panel for the board's side column: the opponent's
 * pocket on top and the local player's below (matching the board orientation).
 * Only the local player's own pocket is interactive, and only on their turn.
 * Lives in the BoardPage side column (not stacked around the fixed-square board).
 */
export default function PocketPanel({
    orientation,
    humanColor,
    pockets,
    selected,
    myTurn,
    onSelect,
}: {
    orientation: Color
    humanColor: Color
    pockets: Pockets
    selected: PocketPiece | null
    myTurn: boolean
    onSelect: (p: PocketPiece) => void
}) {
    const top = other(orientation)
    return (
        <Box sx={{ display: 'flex', flexDirection: 'column', gap: 0.75, mb: 1.5 }}>
            <Typography
                sx={{
                    fontFamily: 'var(--font-display)',
                    fontWeight: 700,
                    fontSize: 12.5,
                    color: 'var(--text-dim)',
                    textTransform: 'uppercase',
                    letterSpacing: 0.5,
                }}
            >
                In hand
            </Typography>
            <Pocket
                color={top}
                pocket={pockets}
                selected={selected}
                interactive={myTurn && top === humanColor}
                onSelect={onSelect}
            />
            <Pocket
                color={orientation}
                pocket={pockets}
                selected={selected}
                interactive={myTurn && orientation === humanColor}
                onSelect={onSelect}
            />
        </Box>
    )
}
