# Keyboard play and a screen-reader-readable board

**Status:** completed — 2026-07-29, except Spectate move-scrubbing (split out).

**Made opt-in on 2026-07-29** behind a new `keyboardBoard` pref, default **off**.
Keyboard play is a minority need and its two side effects are not: focusable
squares leave a focus ring on an ordinary click, and the board cursor takes the
arrow keys away from move-list scrubbing. With the pref off, squares carry no
`tabIndex` at all (a `div` without one can't take focus, so the click ring is
gone), `onBoardKeyDown` bails immediately so arrows keep reaching the move-nav
registry, and the roles degrade `grid`/`gridcell` → `table`/`cell` — the honest
markup for a matrix that is readable but not interactive. **The ARIA labels and
the live region are unconditional**, so the position and every move stay
screen-reader readable whether or not keyboard play is enabled.

`role="grid"` + `role="row"` (via `display: contents`, so the CSS grid layout is
untouched) + `role="gridcell"` with roving tabindex — chosen over 64 buttons
because the container already owns pointer hit-testing and 64 focusable elements
wreck screen-reader browse mode on an 8x8. Reasoning is a comment in `Board.tsx`.
Keyboard cursor reuses the same `ownPieceAt`/`targets`/`commit` functions as the
pointer path, with Duck placement and the Crazyhouse drop-arm following the same
branch order as `onPointerDown`. New `--focus` token across all 16 board themes
drives a ring distinct from `.sel`/`.last`/`.check`. Polite live region keyed off
`fen`, so it announces landed moves and check/mate but not cursor movement.
No new Board props — all 9 other consumers untouched.

**Two conflicts the task didn't mention**, both resolved: arrow keys were already
globally bound by `useMoveNavKeys` through the window-level registry in
`lib/shortcuts.ts` (fires regardless of focus, active on LiveGame/BotGame/
GuessTheElo/EngineVsEngine) — handled with `preventDefault()` +
`stopPropagation()` on the container handler, which halts bubbling before
`window`, so move-nav is suppressed only while a square holds focus. And
`Board.tsx` already owned a window Escape listener for the promotion picker, so
that listener was *extended* rather than raced with a second one.

The Spectate `showEvalBar` half landed. Move-scrubbing did not — see
`docs/tasks/open/spectate-ply-scrubbing.md` for why it's its own task.

A grep for `role=` or `tabIndex` in `components/Board.tsx` returns nothing. The
board is pointer-only, so a keyboard-only or screen-reader user cannot play or
review a game at all. Lichess ships a full Blind Mode (accessible HTML table,
live move announcements, single-letter commands); we ship nothing.

An earlier attempt was stopped mid-edit and reverted along with the Spectate
changes it was bundled with. Nothing from it survives.

## Scope

Deliberately smaller than Lichess's Blind Mode. No command language.

- Board container gets a suitable role and `aria-label`; squares expose their
  name and occupant so the position is readable. Decide between a grid/table
  semantic and 64 buttons, and write down why.
- Keyboard move path: arrows move a focus cursor square to square, Enter/Space
  selects the piece then the destination, Escape cancels. Reuse the existing
  selection and legal-move machinery that click-to-move already uses — one move
  submission path, no forked legality. The engine stays the rules authority; the
  board only renders the `legalMoves` it was handed.
- Focus ring visually distinct from selection and last-move highlights, driven by
  theme tokens.
- Polite live region announcing the move played, plus check/mate when the props
  already carry it.
- Must not disturb pointer input, drag and drop, premoves, the promotion picker,
  Duck's second-phase placement, or either hint mechanism (`hintReveal` hold-H,
  and the puzzle trainer's `hintStage`).

## Also in scope (reverted with it)

`pages/Spectate.tsx` renders its own `EvalBar` gated only on
`isAdmin && showEval` (~line 173) and never reads the site-wide `showEvalBar`
preference. It also has no move-navigation keys; wire `lib/useMoveNavKeys.ts` in
if the page has a move list worth scrubbing.

## Done when

A game can be played start to finish with the keyboard alone, and VoiceOver reads
the position and each move.
