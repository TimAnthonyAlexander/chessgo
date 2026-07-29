# Ply scrubbing on the spectate page

**Status:** not started. Split out of `board-keyboard-and-screenreader.md`
(completed 2026-07-29) once it turned out to be a real task, not a footnote.

`pages/Spectate.tsx` has a move list but you cannot scrub it. `MoveList` is
rendered with `currentPly={moveEntries.length}` hardcoded and `onSelectPly` a
no-op (~`:293-299`), so the board always shows the live position. Neither
`useMoveNavKeys` nor click-to-jump works.

## Why it isn't a two-line fix

The obvious move — add a `selectedPly` state and wire `useMoveNavKeys` — doesn't
work, because **there is no per-ply FEN to show**. `moveEntries` is built at
`Spectate.tsx:163-169` from `g.moves`, and `MoveEntry.fen` is an empty-string
placeholder. Rendering a historical position needs a board-to-FEN serializer that
does not exist on the client today, and it would have to handle:

- Crazyhouse drops (pocket state is part of the position)
- Chess960 start positions (castling rights aren't inferable from king/rook files)
- Duck placements (the duck square is position state)
- Per-ply check status, which Spectate doesn't track

Doing it approximately would render wrong positions on three variants, which is
worse than not offering it.

## The options, cheapest first

1. **Ask the hub for it.** The hub already has authoritative per-ply state for a
   live game. If it can include a FEN per move in the payload Spectate already
   receives, the page becomes a pure display change and every variant is correct
   by construction. Check what `gomachine/internal/hub` sends today.
2. **Ask zugzwang.** The engine owns rules for all variants and is stateless. A
   `(startFen, moves[]) → fen[]` call would be correct for free, at the cost of a
   round trip per game rather than per ply.
3. **Client-side serializer.** Cheapest per-request, most likely to be subtly
   wrong on variants. Only worth it if 1 and 2 are both closed.

Prefer 1 or 2 — the engine and hub are already the rules authority, and this is
exactly the kind of thing the client is not supposed to re-implement.

## Done when

Arrow keys and clicking a move in the spectate move list move the board through
the game, correctly on standard, Chess960, Crazyhouse and Duck.
