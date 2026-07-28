# A real opening explorer

**Status:** not started. Needs a data source decision first.

`components/OpeningPanel.tsx` is not an opening book. Its own header comment says
"the engine doing all the chess": the ECO name and the candidate moves are
engine-classified, with no games corpus behind them. So there are no popularity
or win-rate numbers, which is the entire reason people open Lichess's explorer.

## The open question

Where the games come from. Three candidates, cheapest first:

1. **Our own games.** We persist every finished game. A "how players on chessgo
   actually continue here" explorer is honest, unique, and needs no third-party
   data — but it needs a position index, and at our volume the tail will be thin
   for anything past a few plies.
2. **Lichess's public database** (`database.lichess.org`). Large, free, and the
   direct comparison point. Ingest cost and storage need measuring before this is
   a plan rather than a wish.
3. **A masters PGN collection.** Small, high signal, no personal data, but a
   different product from (1) and (2).

Pick one and say why before writing any code. The answer changes the schema.

## Implementation notes

- Position keying: Zobrist hash or a normalized FEN prefix. Whatever we pick has
  to survive transpositions, which is most of the value.
- Schema goes through the BaseAPI generator: edit the model, then
  `php mason migrate:generate`, then `php mason migrate:apply -y`. Never raw DDL.
  Table names are singular snake_case.
- Aggregation is per-position: move, count, white/draw/black split, and an
  average rating of the players who reached it. Filters by rating band and time
  control, as Lichess has, if the corpus supports it.
- The panel already has a home in the analysis sidebar; extend it rather than
  adding a second opening surface.
- ≤7-piece endgames are a separate concern (tablebase, not explorer). Out of scope.

## Done when

Hovering a position in analysis shows what real players did there, with counts.
