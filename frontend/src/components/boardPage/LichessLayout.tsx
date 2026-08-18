import type { ReactNode } from 'react'
import { Box } from '@mui/material'
import type { BoardPageProps } from './types'
import { BOARD_MAX, EDGE_GAP, GAP_EVAL_EXTRA, PAGE_PAD } from './types'

// The Lichess-shaped board page, and the app's default. The board is a FIXED
// square, centered in the viewport, and its size + position are identical on every
// page regardless of what the side columns contain — adding, removing, or
// overflowing side content never moves or resizes the board.
//
// How the guarantees hold:
//  - A 3-column grid `SIDE · board · SIDE`, centered (`fit-content` + `mx:auto`),
//    with TIGHT gaps so the cards sit close to the board. Both side columns are
//    ALWAYS rendered (empty when a page has no left/right content) so the layout is
//    stable. The eval-bar gap on the board's LEFT is reserved UNCONDITIONALLY, so
//    the board sits in the identical spot on every page and toggling an eval bar
//    on/off never shifts it — the bar just fills (or vacates) the reserved gap.
//  - The board column is a FIXED length (`BOARD_SIZE`), never `1fr`/`auto`, so no
//    amount of side content can steal or add width to it.
//  - Side columns are a fixed width AND fixed height (= the board's height), so tall
//    content scrolls inside the column instead of growing the row and nudging the
//    board.
//  - The eval bar (when present) is ABSOLUTELY positioned into the reserved left gap
//    (`right:100%`), contributing zero layout width — so an eval-bar page and an
//    eval-bar-less page render the exact same board box in the exact same place, and
//    a page that toggles its bar keeps the board perfectly still.
//
// The board's top edge is also fixed (top-aligned under the nav + page padding), so
// it lands at the same y on every page too.
//
// `top`/`bottom` exist for the chess.com layout's player strips. This layout honours
// them (board-width, above/below) so a page can pass them unconditionally, but the
// Lichess arrangement keeps player rows inside the `right` panel — so in practice
// pages leave them undefined here and nothing about the geometry changes.

// Fixed side-column width (desktop). The board is flanked by two of these.
const SIDE_W = 320
// Horizontal room the layout reserves besides the board: two side columns, the two
// base edge gaps, the eval-bar's extra left gap (reserved unconditionally so the
// board SIZE stays identical whether or not a page shows the bar), and the outer
// page padding. The board's width term subtracts this so a width-bound viewport
// never overflows. GAP_EVAL_EXTRA is reserved here AND applied as the board's left
// margin unconditionally, so size and position stay in lockstep.
const H_RESERVE = SIDE_W * 2 + EDGE_GAP * 2 + GAP_EVAL_EXTRA + PAGE_PAD // = 756

// The board square. Binds to whichever hits first: the viewport height minus the
// 60px nav + padding (the usual desktop case), the viewport width minus the
// reserved side room, or a generous absolute cap. Side columns reuse this as their
// height so they align.
export const BOARD_SIZE = `min(calc(100dvh - 112px), calc(100vw - ${H_RESERVE}px), ${BOARD_MAX}px)`

export default function LichessLayout({
    children,
    left,
    right,
    top,
    bottom,
    evalBar,
    rightFit,
    leftFit,
}: BoardPageProps) {
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
                    gridTemplateColumns: { xs: '1fr', md: `${SIDE_W}px auto ${SIDE_W}px` },
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
                {/* Left column — always rendered (empty when unused) so the board stays
                    centered. Fixed width + board height; content scrolls internally.
                    When NO eval bar is present, the reserved bar gap on the board's left
                    would otherwise sit empty between this card and the board, so we slide
                    the card right to hug the board (matching the tight right-card gap).
                    The board keeps its reserved margin either way, so it never moves —
                    only the card shifts, and toggling a page's bar on/off slides just
                    this card, never the board. */}
                <SideColumn
                    order={{ xs: 3, md: 0 }}
                    shiftRight={evalBar ? 0 : GAP_EVAL_EXTRA}
                    fit={leftFit}
                    fitAlign="start"
                >
                    {left}
                </SideColumn>

                {/* Center — the board, with the eval bar floated into the left gap on md
                    (absolute, no layout width) and inlined on xs. */}
                <Box
                    sx={{
                        order: { xs: 1, md: 0 },
                        position: 'relative',
                        display: 'flex',
                        alignItems: 'stretch',
                        alignSelf: 'start',
                        width: { xs: '100%', md: BOARD_SIZE },
                        minWidth: 0,
                        // The eval-bar gap is reserved on the left UNCONDITIONALLY (matching
                        // H_RESERVE, which already reserves it for board SIZE). So the board
                        // lands in the exact same place on every board page — whether or not a
                        // page shows the bar, and whether a toggleable bar is on or off. The
                        // bar (absolutely positioned, zero layout width) floats into this
                        // reserved space when present; toggling it never moves the board.
                        ml: { md: `${GAP_EVAL_EXTRA}px` },
                    }}
                >
                    {evalBar && (
                        <Box
                            sx={{
                                display: 'flex',
                                flexShrink: 0,
                                // md: float just left of the board, out of the flow, so it
                                // adds no width and the board stays put. The `+ 10px` in the
                                // offset is the visible gap between the bar and the board (a
                                // plain margin collapses on an abs-positioned element). xs:
                                // inline gutter via mr.
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
                    <Box
                        sx={{
                            flex: { xs: 1, md: 'none' },
                            width: { md: '100%' },
                            minWidth: 0,
                            display: 'flex',
                            flexDirection: 'column',
                        }}
                    >
                        {top}
                        {children}
                        {bottom}
                    </Box>
                </Box>

                {/* Right column — always rendered (empty when unused). */}
                <SideColumn order={{ xs: 2, md: 0 }} fit={rightFit}>
                    {right}
                </SideColumn>
            </Box>
        </Box>
    )
}

// A fixed-footprint side column: full width on mobile, a fixed 320px × board-height
// panel on desktop. `minHeight:0` lets a flex-filling child (e.g. a MoveList panel)
// scroll internally instead of stretching the row and moving the board.
function SideColumn({
    children,
    order,
    shiftRight = 0,
    fit = false,
    fitAlign = 'center',
}: {
    children?: ReactNode
    order: { xs: number; md: number }
    // Desktop-only visual nudge toward the board (px), used to close the reserved
    // eval-bar gap for the left card when a page has no bar. A transform (not a
    // margin) so it never reflows the grid or moves the board — mobile is untouched.
    shiftRight?: number
    // Shrink to content and centre against the board, instead of standing a full
    // board-height tall. The board-height becomes a max rather than a fixed size, so
    // the column still can never grow the grid row — the board stays put either way.
    // Desktop only; on mobile the column is full-width and stacks as before.
    fit?: boolean
    // Where a `fit` column sits against the board: centred, or aligned to the board's
    // top edge. Only meaningful when `fit` is set.
    fitAlign?: 'start' | 'center'
}) {
    return (
        <Box
            sx={{
                order,
                width: { xs: '100%', md: `${SIDE_W}px` },
                height: fit ? undefined : { md: BOARD_SIZE },
                maxHeight: fit ? { md: BOARD_SIZE } : undefined,
                // `alignItems: 'start'` on the grid keeps every other column top-aligned;
                // a fit column opts into its own alignment via `fitAlign`.
                alignSelf: fit ? { md: fitAlign } : undefined,
                // Only bites if a fit column's content somehow exceeds the board height —
                // it scrolls internally rather than stretching the row.
                overflowY: fit ? { md: 'auto' } : undefined,
                minWidth: 0,
                minHeight: 0,
                display: 'flex',
                flexDirection: 'column',
                transform: shiftRight ? { md: `translateX(${shiftRight}px)` } : undefined,
            }}
        >
            {children}
        </Box>
    )
}
