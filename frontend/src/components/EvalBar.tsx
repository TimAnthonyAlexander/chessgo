import { useEffect, useRef } from 'react'
import { Box } from '@mui/material'
import type { Color } from '../api/client'

/** Engine evaluation expressed from White's perspective. */
export interface WhiteEval {
    type: 'cp' | 'mate'
    white: number // cp (centipawns) or signed mate distance; + favors White
}

interface EvalBarProps {
    ev: WhiteEval | null
    orientation: Color
    // Optional second-opinion marker (e.g. Stockfish's eval): a thin colored line
    // drawn at that eval's height, so you can see how close the two engines are.
    // Most pages don't pass this. `sfColor` defaults to the Stockfish arrow violet.
    sfEv?: WhiteEval | null
    sfColor?: string
}

// Lichess "Winning chances": a sigmoid of centipawns fit from real game data, so
// swings near 0.0 move the bar a lot and distant swings barely move it.
function whiteWinPercent(ev: WhiteEval | null): number {
    if (!ev) return 50
    if (ev.type === 'mate') return ev.white > 0 ? 100 : ev.white < 0 ? 0 : 50
    const cp = Math.max(-1000, Math.min(1000, ev.white))
    return 50 + 50 * (2 / (1 + Math.exp(-0.00368208 * cp)) - 1)
}

// Just the value: pawns (e.g. "2.0") or "M" + moves. No sign, no percentage.
function evalLabel(ev: WhiteEval | null): string {
    if (!ev) return '0.0'
    if (ev.type === 'mate') return `M${Math.abs(ev.white)}`
    return (Math.abs(ev.white) / 100).toFixed(1)
}

export default function EvalBar({ ev, orientation, sfEv, sfColor = '#b06bff' }: EvalBarProps) {
    // While the engine is still computing the new position's eval, `ev` is null.
    // Keep showing (and animating from) the last known eval instead of snapping the
    // bar to center, so it slides old → new once the result arrives.
    const lastRef = useRef<WhiteEval | null>(ev)
    useEffect(() => {
        if (ev) lastRef.current = ev
    }, [ev])
    const shown = ev ?? lastRef.current

    const whitePct = whiteWinPercent(shown)
    const sfPct = sfEv ? whiteWinPercent(sfEv) : 0
    const whiteAhead = shown ? shown.white >= 0 : true
    const whiteAnchor = orientation === 'w' ? 'bottom' : 'top' // White grows from its own side

    // The single value prints at the winning side's end of the bar.
    const winningSide: Color = whiteAhead ? 'w' : 'b'
    const numberAtBottom = winningSide === orientation

    return (
        <Box
            sx={{
                position: 'relative',
                width: { xs: 26, md: 38 },
                flexShrink: 0,
                borderRadius: '3px',
                overflow: 'hidden',
                bgcolor: '#191c22', // black's region (background)
                border: '1px solid var(--line-soft)',
            }}
        >
            {/* White's region grows from White's side of the board */}
            <Box
                sx={{
                    position: 'absolute',
                    left: 0,
                    right: 0,
                    [whiteAnchor]: 0,
                    height: `${whitePct}%`,
                    background: 'linear-gradient(180deg, #f3eee2, #e4dccb)',
                    transition: 'height 0.45s cubic-bezier(0.4, 0, 0.2, 1)',
                }}
            />

            {/* Square-aligned ticks */}
            {[1, 2, 3, 4, 5, 6, 7].map((i) => (
                <Box
                    key={i}
                    sx={{
                        position: 'absolute',
                        left: 0,
                        right: 0,
                        top: `${i * 12.5}%`,
                        height: '1px',
                        background: 'rgba(120,120,120,0.28)',
                        pointerEvents: 'none',
                    }}
                />
            ))}

            {/* Stockfish's eval level — a thin colored line at its win-% height,
                measured from the SAME side White grows from, so it reads directly
                against the fill's top edge (how close the two engines are). */}
            {sfEv && (
                <Box
                    sx={{
                        position: 'absolute',
                        left: 0,
                        right: 0,
                        [whiteAnchor]: `${sfPct}%`,
                        height: '2px',
                        transform: whiteAnchor === 'bottom' ? 'translateY(50%)' : 'translateY(-50%)',
                        background: sfColor,
                        boxShadow: `0 0 6px ${sfColor}`,
                        opacity: 0.9,
                        transition: `${whiteAnchor} 0.45s cubic-bezier(0.4, 0, 0.2, 1)`,
                        pointerEvents: 'none',
                        zIndex: 3,
                    }}
                />
            )}

            {/* The single eval value, at the winning side's end */}
            <Box
                sx={{
                    position: 'absolute',
                    left: 0,
                    right: 0,
                    [numberAtBottom ? 'bottom' : 'top']: 4,
                    textAlign: 'center',
                    fontFamily: 'var(--font-mono)',
                    fontSize: { xs: 9.5, md: 11.5 },
                    fontWeight: 700,
                    letterSpacing: '-0.02em',
                    lineHeight: 1,
                    color: whiteAhead ? '#1c1f26' : '#e9e1cf', // dark on white fill, light on black fill
                    pointerEvents: 'none',
                }}
            >
                {evalLabel(shown)}
            </Box>
        </Box>
    )
}
