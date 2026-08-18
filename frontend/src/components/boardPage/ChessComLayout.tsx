import type { ReactNode } from 'react'
import { Box } from '@mui/material'
import type { BoardPageProps } from './types'
import { BOARD_MAX, EDGE_GAP, GAP_EVAL_EXTRA, PAGE_PAD } from './types'

// The chess.com-shaped board page. Same prop contract as the Lichess layout, a
// different arrangement of it:
//
//   [eval] [ opponent strip / BOARD / your strip ]  [ one tall rail ]
//
// What actually makes this read as chess.com rather than as a rearranged Lichess:
//  - Player identity + clock live in FULL-BOARD-WIDTH strips hugging the board,
//    not as narrow rows inside the side panel. That's the defining difference, and
//    it's why pages hand their player rows to `top`/`bottom` when this layout is
//    active instead of nesting them in `right`.
//  - There is ONE side column, not two. Whatever a page put in `left` stacks under
//    what it put in `right`, in a single scrolling rail.
//  - The board+strips block and the rail are centered as a GROUP, so the board sits
//    left of centre the way chess.com's does, without drifting on ultrawide.
//
// The invariant carried over from the Lichess layout: nothing in the rail can move
// or resize the board. The board column is a fixed length, the rail is a fixed
// width and a fixed height, and the eval bar is absolutely positioned into a gap
// that is reserved whether or not a bar is shown. Tall rail content scrolls inside
// the rail.
//
// The one guarantee this layout deliberately does NOT make is the Lichess layout's
// "identical board box on every page". A page with player strips reserves vertical
// room for them and so gets a slightly smaller board than a page without — exactly
// as chess.com's own game and analysis boards differ. What still holds, and is what
// actually matters, is that the board never moves WITHIN a page: the strip height is
// reserved for the whole page's life, so toggling an eval bar, a chat, or anything
// in the rail leaves the board perfectly still.

// The single right rail. Wider than the Lichess side column (320) because it now
// carries what used to be two columns.
const RAIL_W = 360
// Reserved height of one player strip, plus the gap between it and the board. Fixed
// (not content-sized) so the board's size term is knowable up front and the board
// cannot shift when a strip's content changes — a rating appearing, a clock going
// to tenths, a "disconnected" line showing up.
const STRIP_H = 56
const STRIP_GAP = 8
const STRIP_BLOCK = STRIP_H + STRIP_GAP

// Nav + page padding, matching the Lichess layout's 112.
const V_CHROME = 112
// Horizontal room reserved besides the board: the eval bar's gap (unconditional),
// the board↔rail gap, the rail, and the outer page padding.
const H_RESERVE = GAP_EVAL_EXTRA + EDGE_GAP + RAIL_W + PAGE_PAD // = 466

/** The board square for this layout. `strips` reserves the two player strips. */
function boardSize(strips: boolean): string {
    const v = V_CHROME + (strips ? STRIP_BLOCK * 2 : 0)
    return `min(calc(100dvh - ${v}px), calc(100vw - ${H_RESERVE}px), ${BOARD_MAX}px)`
}

/** Full height of the board column including its strips — the rail matches it, so
 *  the rail's top and bottom edges line up with the whole block, not just the
 *  board. */
function stackHeight(strips: boolean): string {
    const size = boardSize(strips)
    return strips ? `calc(${size} + ${STRIP_BLOCK * 2}px)` : size
}

export default function ChessComLayout({
    children,
    left,
    right,
    top,
    bottom,
    evalBar,
}: BoardPageProps) {
    // Reserved for the page's whole life, not per-render: a page either has player
    // strips or it doesn't. Keyed off `!== undefined` rather than truthiness so a
    // strip that momentarily renders nothing still holds its space and the board
    // stays put.
    const strips = top !== undefined || bottom !== undefined
    const BOARD_SIZE = boardSize(strips)

    return (
        <Box
            sx={{
                flex: 1,
                display: 'flex',
                justifyContent: 'center',
                alignItems: 'flex-start',
                px: { xs: 2, md: 3 },
                py: { xs: 3, md: 3 },
            }}
        >
            <Box
                sx={{
                    display: 'grid',
                    gridTemplateColumns: { xs: '1fr', md: `auto ${RAIL_W}px` },
                    columnGap: { md: `${EDGE_GAP}px` },
                    rowGap: { xs: 2, md: 0 },
                    alignItems: 'start',
                    justifyContent: 'center',
                    width: { xs: '100%', md: 'fit-content' },
                    maxWidth: '100%',
                    minWidth: 0,
                    mx: 'auto',
                }}
            >
                {/* Board column: opponent strip, board, your strip. */}
                <Box
                    sx={{
                        order: { xs: 1, md: 0 },
                        display: 'flex',
                        flexDirection: 'column',
                        alignSelf: 'start',
                        width: { xs: '100%', md: BOARD_SIZE },
                        minWidth: 0,
                        // The eval bar's gap, reserved unconditionally so toggling a bar
                        // never shifts the board — same contract as the Lichess layout.
                        ml: { md: `${GAP_EVAL_EXTRA}px` },
                    }}
                >
                    {strips && <Strip gap="bottom">{top}</Strip>}

                    {/* The board, and the eval bar floated against ITS left edge — the
                        bar spans the board only, never the strips. */}
                    <Box sx={{ position: 'relative', display: 'flex', minWidth: 0 }}>
                        {evalBar && (
                            <Box
                                sx={{
                                    display: 'flex',
                                    flexShrink: 0,
                                    position: { xs: 'static', md: 'absolute' },
                                    right: { md: `calc(100% + ${EDGE_GAP}px)` },
                                    top: { md: 0 },
                                    bottom: { md: 0 },
                                    mr: { xs: 0.75, md: 0 },
                                }}
                            >
                                {evalBar}
                            </Box>
                        )}
                        <Box sx={{ flex: { xs: 1, md: 'none' }, width: { md: '100%' }, minWidth: 0 }}>
                            {children}
                        </Box>
                    </Box>

                    {strips && <Strip gap="top">{bottom}</Strip>}
                </Box>

                {/* The one rail. Always rendered (empty when a page has neither slot) so
                    the group's centering doesn't jump between pages. `right` sits above
                    `left`: the move list is the primary object, and what a page treats as
                    left-column context (mode card, chat, setup tools) reads as secondary
                    underneath it — which is where chess.com puts the same content. */}
                <Box
                    sx={{
                        order: { xs: 2, md: 0 },
                        width: { xs: '100%', md: `${RAIL_W}px` },
                        height: { md: stackHeight(strips) },
                        minWidth: 0,
                        minHeight: 0,
                        display: 'flex',
                        flexDirection: 'column',
                        gap: 2,
                        // Tall rail content scrolls in place instead of growing the row
                        // and dragging the board with it.
                        overflowY: { md: 'auto' },
                        // Rail cards keep their natural height and let the rail scroll,
                        // rather than being squeezed by a fixed-height flex column —
                        // a card that sizes to its content AND clips its overflow (the
                        // Editor's setup panel, say) would otherwise lose its last rows
                        // silently. Only shrinking is disabled: a card that asks to FILL
                        // the rail (`flex: 1`, which the analysis panel needs so its move
                        // tree gets a definite height) still grows into the spare room.
                        '& > *': { flexShrink: 0 },
                    }}
                >
                    {right}
                    {left}
                </Box>
            </Box>
        </Box>
    )
}

// One player strip: a fixed-height, board-width band above or below the board. Fixed
// height is the point — it's what lets the board's size be computed up front and
// keeps the board still while the strip's contents change.
function Strip({ children, gap }: { children?: ReactNode; gap: 'top' | 'bottom' }) {
    return (
        <Box
            sx={{
                flexShrink: 0,
                minWidth: 0,
                height: { md: `${STRIP_H}px` },
                mt: gap === 'top' ? { md: `${STRIP_GAP}px` } : 0,
                mb: gap === 'bottom' ? { md: `${STRIP_GAP}px` } : 0,
                display: 'flex',
                alignItems: 'stretch',
                '& > *': { flex: 1, minWidth: 0 },
            }}
        >
            {children}
        </Box>
    )
}
