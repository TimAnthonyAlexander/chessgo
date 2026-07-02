import type { ReactNode } from 'react'
import { Box } from '@mui/material'

// One layout to rule every board page. The board is a FIXED square, centered in the
// viewport, and its size + position are identical on every page regardless of what
// the side columns contain — adding, removing, or overflowing side content never
// moves or resizes the board.
//
// How the guarantees hold:
//  - A 3-column grid `SIDE · board · SIDE`, centered (`fit-content` + `mx:auto`),
//    with TIGHT gaps so the cards sit close to the board. Both side columns are
//    ALWAYS rendered (empty when a page has no left/right content) so the layout is
//    stable. The board is dead-centered when there's no eval bar; when a bar IS
//    shown it claims a little extra room on the LEFT (where it floats), nudging the
//    board a few px right so BOTH cards hug the board+bar block evenly instead of
//    leaving the right card stranded far out.
//  - The board column is a FIXED length (`BOARD_SIZE`), never `1fr`/`auto`, so no
//    amount of side content can steal or add width to it.
//  - Side columns are a fixed width AND fixed height (= the board's height), so tall
//    content scrolls inside the column instead of growing the row and nudging the
//    board.
//  - The eval bar (when present) is ABSOLUTELY positioned into the left gap
//    (`right:100%`), contributing zero layout width — so an eval-bar page and an
//    eval-bar-less page render the exact same board box in the exact same place.
//
// The board's top edge is also fixed (top-aligned under the nav + page padding), so
// it lands at the same y on every page too.

// Fixed side-column width (desktop). The board is flanked by two of these.
const SIDE_W = 320
// The ONE uniform gap between the board-block and whatever sits next to it: the
// eval-bar↔board gap, the right-card↔board gap, and the left-card↔board gap when
// there's no bar. Keeping them all equal is what makes the spacing read as even.
const EDGE_GAP = 10
// Eval-bar width (matches EvalBar's md width). When a bar is shown the left card
// sits EDGE_GAP from the bar and the bar sits EDGE_GAP from the board, so the left
// gap grows by (EDGE_GAP + EVAL_W) on top of the base EDGE_GAP.
const EVAL_W = 38
const GAP_EVAL_EXTRA = EDGE_GAP + EVAL_W // extra left gap only when the bar is present
// Horizontal room the layout reserves besides the board: two side columns, the two
// base edge gaps, the eval-bar's extra left gap (reserved unconditionally so the
// board SIZE stays identical whether or not a page shows the bar), and the outer
// page padding (px:3 → 24px each side). The board's width term subtracts this so a
// width-bound viewport never overflows.
const H_RESERVE = SIDE_W * 2 + EDGE_GAP * 2 + GAP_EVAL_EXTRA + 48 // = 756

// The board square — the SINGLE source of truth for board size across the app.
// Binds to whichever hits first: the viewport height minus the 60px nav + padding
// (the usual desktop case), the viewport width minus the reserved side room, or a
// generous absolute cap. Side columns reuse this as their height so they align.
export const BOARD_SIZE = `min(calc(100vh - 112px), calc(100vw - ${H_RESERVE}px), 1160px)`

interface BoardPageProps {
    /** The board itself (a `<Board/>`), rendered at the fixed board size. */
    children: ReactNode
    /** Left side column (e.g. info cards). Fixed width, board-height, scrolls internally. */
    left?: ReactNode
    /** Right side column (e.g. move list + controls). Same footprint as the left. */
    right?: ReactNode
    /** Optional eval bar, floated flush against the board's left edge without taking
     *  any layout width — so it never resizes or shifts the board. */
    evalBar?: ReactNode
}

export default function BoardPage({ children, left, right, evalBar }: BoardPageProps) {
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
                    centered. Fixed width + board height; content scrolls internally. */}
                <SideColumn order={{ xs: 3, md: 0 }}>{left}</SideColumn>

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
                        // Extra left gap ONLY when the eval bar is shown, so the floated bar
                        // claims that space (instead of the right card being left far out).
                        // The board nudges a few px right; with no bar both gaps are equal.
                        ml: { md: evalBar ? `${GAP_EVAL_EXTRA}px` : 0 },
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
                        }}
                    >
                        {children}
                    </Box>
                </Box>

                {/* Right column — always rendered (empty when unused). */}
                <SideColumn order={{ xs: 2, md: 0 }}>{right}</SideColumn>
            </Box>
        </Box>
    )
}

// A fixed-footprint side column: full width on mobile, a fixed 320px × board-height
// panel on desktop. `minHeight:0` lets a flex-filling child (e.g. a MoveList panel)
// scroll internally instead of stretching the row and moving the board.
function SideColumn({ children, order }: { children?: ReactNode; order: { xs: number; md: number } }) {
    return (
        <Box
            sx={{
                order,
                width: { xs: '100%', md: `${SIDE_W}px` },
                height: { md: BOARD_SIZE },
                minWidth: 0,
                minHeight: 0,
                display: 'flex',
                flexDirection: 'column',
            }}
        >
            {children}
        </Box>
    )
}
