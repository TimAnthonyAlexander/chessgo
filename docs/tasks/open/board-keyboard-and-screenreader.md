# Keyboard play and a screen-reader-readable board

**Status:** attempted, reverted, not started again.

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
