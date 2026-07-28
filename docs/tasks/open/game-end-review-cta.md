# Surface Blunder Rewind on the game-end screen

**Status:** not started. The feature exists; only the entry point is missing.

`components/BlunderRewind.tsx` is the best thing on the analysis surface — you
replay each of your blunders from the position before it and get graded live
against engine best play. Chess.com charges for the equivalent ("Retry
Mistakes"). We give it away and then hide it: the only way in is to navigate to
`/analysis/:id` and find the banner.

The Analysis page now renders a `BlunderRewindBanner` (see `pages/Analysis.tsx`,
the `blunderPuzzles.length > 0` block). The game-end screens still don't.

## To do

- `pages/LiveGame.tsx` game-over block (~640-722) and `pages/BotGame.tsx`
  (~864-907): after the result line and rating delta, show the blunder count and
  a primary action that goes straight into Blunder Rewind for that game, not just
  to the analysis board.
- Blunder detection needs the game's analysis. Check what `GET /games/{id}/analysis`
  returns and whether it is ready at game end or has to be requested. If it is
  asynchronous, show the count once it arrives rather than blocking the screen.
- Order the actions: Rematch first (see `rematch-finish-and-wire.md`), then
  "Review N blunders", then Lobby / New game. Keep `BoardActions` where it is.
- If the player had no blunders, say so in one line instead of showing a dead
  button.

## Done when

Finishing a game with blunders offers the rewind in one click from the board you
just played on.
