# Accessibility sweep — 2026-07-28

Uncommitted in the working tree. Typechecks clean.

First real accessibility pass on the site. Scoped to everything except the board
itself, which is a bigger job — see
`docs/tasks/open/board-keyboard-and-screenreader.md`.

## Shipped

- **`pages/Watch.tsx`** — `GameCard` was a plain `onClick` div with no `tabIndex`,
  `role` or key handling, so live games were unreachable by keyboard. Now matches
  the house pattern already used by Home's `ActionCell`/`TimeCell`, with an
  `aria-label` naming both players and the time control.
- **`components/EvalBar.tsx`** — had zero aria attributes. Now `role="meter"` with
  min/max/now and an `aria-valuetext` that says the evaluation in words ("White is
  winning, +2.4", "Mate in 3 for Black"). Decorative internals hidden.
- **`components/ChatPanel.tsx`** — no live region, so incoming messages were never
  announced. Now `role="log"` + `aria-live="polite"`, keyboard-focusable, labelled
  input.
- **`components/MoveTree.tsx`** — judgment glyphs conveyed meaning through colour
  and symbol only. Each now carries an accessible name (Blunder, Mistake,
  Inaccuracy…), and move nodes are real buttons with `aria-current="step"`,
  matching `MoveList`.
- **`components/MoveList.tsx`** — already good; added a container label only.
- **`styles.css`** — `prefers-reduced-motion` was honored nowhere in the repo. The
  reduce block now also zeroes `--piece-anim`, so the OS setting wins over the
  animation-speed preference.

Semantics and keyboard only. No restyling beyond focus rings consistent with the
one `MoveList` already used.
