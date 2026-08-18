import type { ReactNode } from 'react'

// The ONE prop contract every board-page layout implements. A page composes its
// slots once; the active layout decides where they land. Adding a layout means
// adding a file here — never touching a page.
export interface BoardPageProps {
    /** The board itself (a `<Board/>`), rendered at the layout's board size. */
    children: ReactNode
    /** Left side column (e.g. info cards). */
    left?: ReactNode
    /** Right side column (e.g. move list + controls). */
    right?: ReactNode
    /** Player strip ABOVE the board — opponent identity, rating, captured, clock.
     *  Only the chess.com layout has a natural home for this; the Lichess layout
     *  renders it board-width above the board if a page passes one, but Lichess-
     *  shaped pages keep their player rows inside the `right` panel instead. */
    top?: ReactNode
    /** Player strip BELOW the board — you. Same rules as `top`. */
    bottom?: ReactNode
    /** Let the right column shrink to its content instead of filling the board's
     *  height, and centre it vertically against the board. For pages whose right
     *  card is deliberately compact (a fixed-height move list rather than one that
     *  fills), where a full-height column would leave a tall empty tail.
     *  The column keeps its fixed WIDTH and its board-height CAP either way, so the
     *  board still can't be moved or resized by what's in here.
     *  Lichess layout only — the chess.com rail is always full height, by design. */
    rightFit?: boolean
    /** Same, for the left column. Lichess layout only. */
    leftFit?: boolean
    /** Optional eval bar, floated flush against the board's left edge without taking
     *  any layout width — so it never resizes or shifts the board. Both layouts. */
    evalBar?: ReactNode
}

// Shared geometry both layouts agree on.
//
// The ONE uniform gap between the board-block and whatever sits next to it: the
// eval-bar↔board gap, the rail↔board gap, and the card↔board gap when there's no
// bar. Keeping them all equal is what makes the spacing read as even.
export const EDGE_GAP = 10
// Eval-bar width (matches EvalBar's md width). The bar sits EDGE_GAP from the
// board, so the board's left gap is always (EDGE_GAP + EVAL_W) larger than its
// right gap — reserved whether or not a page shows a bar, in BOTH layouts, so
// toggling one never moves the board.
export const EVAL_W = 38
export const GAP_EVAL_EXTRA = EDGE_GAP + EVAL_W
// Outer page padding (px:3 → 24px each side).
export const PAGE_PAD = 48
// Absolute ceiling on the board square, shared so the two layouts agree on how
// big a board is ever allowed to get.
export const BOARD_MAX = 1160
