import { Fragment, type ReactNode } from 'react'
import { Box } from '@mui/material'
import { formatSan, useNotation } from '../lib/settings'
import { DuckGlyph } from './DuckGlyph'

/**
 * The ONE place a move is rendered for display. Formats the SAN per the user's
 * notation preference (plain SAN by default, figurine piece glyphs when chosen)
 * and — for Duck Chess — swaps the literal 🦆 in the SAN (e.g. "e4 🦆c5") for the
 * DuckGlyph SVG so the move table matches the board. Every move-list / notation
 * surface routes through this so notation is unified app-wide.
 */
export function MoveSan({ san }: { san: string }): ReactNode {
    const notation = useNotation()
    const text = formatSan(san, notation)
    if (!text.includes('🦆')) return text

    const parts = text.split('🦆')
    return (
        <>
            {parts.map((part, i) => (
                <Fragment key={i}>
                    {part}
                    {i < parts.length - 1 && (
                        <Box
                            component="span"
                            sx={{
                                display: 'inline-flex',
                                verticalAlign: '-0.14em',
                                mx: '0.5px',
                            }}
                        >
                            <DuckGlyph />
                        </Box>
                    )}
                </Fragment>
            ))}
        </>
    )
}
