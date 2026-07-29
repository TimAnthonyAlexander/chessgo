# Surface Blunder Rewind on the game-end screen

**Status:** completed — 2026-07-29. Needed backend work the task didn't anticipate.

Both game-over screens now fetch analysis after the game ends (never blocking),
count blunders for the viewer's own colour, and show "Review N blunders" ordered
after Rematch — or "No blunders this game." instead of a dead button.
`?rewind=1` deep-links straight into Blunder Rewind and strips itself on entry so
exiting doesn't bounce back in.

**The blocker this task missed:** bot games could not reach Blunder Rewind at
all. `BotGame` has no `hub_game_id`, `GameAnalysisController` only resolves
`Game`, and the `{moves, startFen}` path made `Analysis.tsx` set `game = null`,
so `blunderPuzzles` was permanently empty. Fixed by refactoring
`GameAnalysisService::build()` to take a metadata array instead of a `Game`,
adding `analyzeMoves()` + `deriveResult()`, and exposing `POST /games/analysis`
via `GameMovesAnalysisController` at `60/1m` — tighter than the persisted
route's `300/1m` because every call is an uncacheable ~2s engine burst. **This is
a new on-demand engine-cost surface; revisit the limit if it gets hit.**

Doc corrections: rematch was *not* already first in `BotGame.tsx` (it rendered
after "New game" — fixed); the LiveGame game-over block had moved to ~651-754.

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
