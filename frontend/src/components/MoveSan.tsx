import { Fragment, type ReactNode } from 'react'
import { Box } from '@mui/material'
import { sanToGlyph } from '../lib/chess'
import { DuckGlyph } from './DuckGlyph'

/**
 * Render a move's SAN with piece glyphs, and — for Duck Chess — the literal 🦆 in
 * the SAN (e.g. "e4 🦆c5") swapped for the DuckGlyph SVG so the move table matches
 * the board. Non-duck SANs render exactly as `sanToGlyph` returns them.
 */
export function MoveSan({ san }: { san: string }): ReactNode {
    const glyphed = sanToGlyph(san)
    if (!glyphed.includes('🦆')) return glyphed

    const parts = glyphed.split('🦆')
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
