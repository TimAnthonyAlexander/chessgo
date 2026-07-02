// Shared layout constants for the two homepage "board cards" (Daily puzzle +
// Live now). Keeping the strip height identical is what makes both boards line
// up at the same Y: each card is header → [top strip / board / bottom strip],
// so equal-height headers + equal-height top strips ⇒ the grids align.

/** Fixed height (px) of the meta strip above/below each card's board. */
export const STRIP_H = 42

/** An empty position — rendered while loading so the board (squares) is present
 * from the first paint and only the pieces pop in once data arrives. */
export const EMPTY_FEN = '8/8/8/8/8/8/8/8 w - - 0 1'
