# Opening drill vs bot (play a line, auto-restart on deviation)

**Gap.** Chess.com and Lichess forums have years of requests for "let me drill
an opening against the computer and restart automatically when I go off-book";
reported as a recurring ask on both sites' forums. Neither ships it — the only
workaround either site offers is "set up the position, then play vs computer,"
which is manual and doesn't track anything. We have a real advantage here:
zugzwang is a rating-parameterized engine we control end to end (port 6476),
and we already classify openings in the analysis UI.

## What exists today (and what doesn't)

- `frontend/src/components/OpeningPanel.tsx` does **not** hold a line
  database. It's a thin renderer over the engine's `/candidates` endpoint
  (`frontend/src/api/client.ts`: `candidates(fen, {history, multipv, movetime,
  depth}) → Candidates { opening: Opening|null, moves: CandidateMove[] }`).
  Opening naming is computed in **zugzwang** (`zugzwang/src/openings.{h,cpp}`):
  a compiled table keyed by Zobrist hash, `struct Opening { eco; name; }`,
  ported from the Lichess `chess-openings` dataset via `gomachine
  compile-openings`. Classification is current-position naming only — there is
  no exposed move list / PGN tree for "here is the rest of the Najdorf main
  line," just "this position is named X."
  - There's a second, unrelated "book" in zugzwang: `zugzwang/src/book.{h,cpp}`
    is a precomputed eval/PV book consulted by `/bestmove` search, not a named
    line repertoire. Per `zugzwang/CLAUDE.md`, book moves are skipped whenever
    a rating/weakening is requested — and bot games always pass a rating
    (`BotGameService`), so **bot games do not currently consult the book at
    all**. There is no "stay in this specific line" mode in `/bestmove` or
    `/candidates` today; both are pure search with a naming/eval overlay.
- **We have no masters-game database.** Say this plainly rather than invent a
  source: the Zobrist-keyed opening table only stores name/ECO for hashes it
  recognizes, not move sequences, and there's no ingested corpus of master
  games to sample lines from. The cheapest real source is the same one
  zugzwang's naming table was built from: the **Lichess `chess-openings` TSV
  dataset** (public, MIT-licensed, ~3500 named lines with explicit move
  sequences in SAN, `github.com/lichess-org/chess-openings`). It already
  defines exactly the granularity we want (a line = a named sequence of moves)
  and it's the same corpus our naming already traces to, so line names will
  match what the analysis board already calls things. Cost: one-time import,
  no ongoing dependency.
- Bot game creation: `app/Services/BotGameService.php::create(int $rating,
  string $humanColor, ?string $startFen = null, string $variant = 'standard')`.
  Custom starting FEN **is already supported** for standard/chess960/handicap
  variants via `applyStartFen()` (validated through the engine's `legalMoves`,
  rejects finished positions) — not for duck/crazyhouse (always standard
  start). No time-control param exists (bot games are untimed).
  `app/Models/BotGame.php`: `rating`, `human_color`, `variant`, `fen`,
  `side_to_move`, `status`, `result`, `moves` (TEXT, JSON-encoded array via
  manual `getMoves()/setMoves()` — the array-cast footgun applies), plus
  internal `history_fens` (TEXT, JSON, stripped from `jsonSerialize()`).
- Frontend bot flow: `frontend/src/pages/BotGame.tsx` — setup screen (rating
  slider, color picker, variant), then `playMove(game.id, uci)` round-trips
  human move + bot reply in one call; `OpeningPanel` is embedded live via a
  rebuilt tree from `moves`.

## Design

**Repertoire source.** Import the Lichess `chess-openings` TSV (five files,
`a.tsv`..`e.tsv`) as static JSON bundled with the frontend, or as a small
BaseAPI-served table if we want server-side deviation checking (see below) —
either way it's a one-time conversion script, not a live dependency. Each line:
`{eco, name, pgn: string[]}` (moves in SAN, from the starting position). Filter
to a curated subset for v1 (the ~200-300 lines a club player would actually
want to drill) rather than exposing all ~3500 — most of the long tail is
transposition trivia nobody drills on purpose.

**Flow.**
1. User picks a line from a searchable list (reuse the existing
   `OpeningPanel`'s naming/eco display for consistency) and a rating for the
   bot (reuse the existing 700-3500 slider).
2. User picks which side of the line they're drilling (White or Black) — the
   bot plays the other side, but **the bot must also stay in the chosen line**
   for the drill to make sense, not just the human.
3. **Staying in book for the bot's moves**: since there is no "constrained
   search" mode in zugzwang today, the correct-and-cheap approach is: while
   both sides' next move still matches the stored line, play the **line's
   move** directly (no engine call at all) instead of asking `/bestmove` —
   this guarantees the bot never deviates and costs zero engine time for those
   plies. Once the line runs out (both sides have played every stored move),
   fall through to normal rated `/bestmove` play, so the drill naturally
   becomes "now defend the resulting position at your rating" instead of
   ending abruptly. This sidesteps needing a new zugzwang "book-constrained
   search" feature entirely — it's a frontend/PHP orchestration decision, not
   an engine change.
4. **Deviation detection**: compare the human's submitted UCI move against the
   next expected move in the stored line at that ply. If it matches, continue.
   If it doesn't, the drill has ended — this is not an error state, it's the
   whole point of the feature (chess.com/Lichess forum requests explicitly ask
   for " stop me the moment I go off-book"). Options at that point, decide
   explicitly rather than hand-wave:
   - **Auto-restart** (the requested behavior): show the deviation move and
     the "book" move it should have been for one beat (toast, ~2s, non-blocking
     — don't force a modal dismiss), then reset the board to the line's start
     and let the human try again. This matches the "auto-restart on first
     deviation" spec directly.
   - Do **not** silently accept the deviated move and continue playing it out
     — that's just a normal bot game at that point and defeats the drill's
     purpose. If the user wants to explore the deviation, they can start a
     normal `/bot` game from that position (already supported via the FEN
     carry-over `BotGame.tsx` already does from the analysis board).
5. **Promotion / castling / en passant** inside the line: the stored SAN
   already disambiguates these; compare on UCI (from/to/promotion) after
   converting the line's SAN to UCI once at import time, not per-attempt, so
   drill-time comparison is a cheap string match against `history` already
   held by `BotGame.moves`.

**Progress storage.** New BaseAPI model, `OpeningDrillAttempt` (table
`opening_drill_attempt`, singular snake_case), modeled directly on
`app/Models/PuzzleAttempt.php`'s shape:
- `user_id: string`
- `line_id: string` (the ECO+line key, e.g. `"B90-najdorf-main"` — stable
  across the imported dataset so re-imports don't orphan history)
- `side: string` (`white`|`black` — which side of the line was drilled)
- `bot_rating: int`
- `plies_correct: int` (how deep into the line the user got before deviating,
  or the full line length if completed)
- `plies_total: int`
- `completed: bool` (reached the end of the stored line without deviating)
- No unique index on `[user_id, line_id]` — unlike puzzles, a drill is
  *meant* to be repeated, so log every attempt and let "per-line accuracy over
  time" be a query (`AVG(plies_correct/plies_total) GROUP BY line_id ORDER BY
  created_at`) rather than a single rated row. Add an index on
  `['user_id', 'line_id']` (non-unique) for that query.

Schema change process: add the model under `app/Models/OpeningDrillAttempt.php`
with `$columns`/`$indexes` as above, then `php mason migrate:generate` followed
by `php mason migrate:apply -y` — never hand-write the DDL, and the resulting
table name is the singular snake_case default (`opening_drill_attempt`), no
`$table` override needed.

## Where (files)

- New: a one-time import script (Node or PHP, doesn't matter, not shipped as a
  runtime dependency) converting the Lichess TSV into a curated JSON bundle,
  e.g. `frontend/src/data/openingLines.json` or a BaseAPI seed if server-side
  matching is preferred.
- New: `frontend/src/pages/OpeningDrill.tsx` (line picker + rating slider +
  side picker, reusing `RATING_SLIDER_MIN/MAX` from `BotGame.tsx`).
- `app/Services/BotGameService.php`: either extend `create()`/`playBot()` to
  accept an optional line context (skip-engine-while-in-book), or add a
  parallel `OpeningDrillService` that wraps `BotGameService` and intercepts
  moves before delegating — the latter keeps `BotGameService` clean for its
  existing callers (`BotGameController`, `GuessGameService`).
- New: `app/Models/OpeningDrillAttempt.php` (see schema above).
- New controller/routes for recording an attempt and reading per-line history
  (`routes/api.php`), following the existing `PuzzleAttempt`
  controller/route pattern.
- `frontend/src/components/OpeningPanel.tsx`: reused as-is for in-drill naming
  display; no change needed since it already renders off `/candidates`'
  `opening` field.

## Abuse / failure modes

- **Gaming the accuracy stat** by only ever picking lines you've memorized:
  this is a personal practice tool, not a leaderboard — no anti-abuse needed
  beyond not exposing per-line stats as a public ranking.
- **Stale line data** if the curated JSON bundle goes out of sync with
  zugzwang's own opening-naming table (they're two separate assets built from
  the same upstream dataset at different times) — pin both to the same
  `chess-openings` commit/version and note the version in the import script so
  a future re-sync is a diff, not a guess.
- **Bot "deviating" due to a bug in the skip-engine matching** (e.g. an
  under-promotion or en passant edge case not normalized the same way on both
  sides) would silently break the drill for that line. Test the comparison
  against UCI, not SAN, precisely to avoid disambiguation-string mismatches.

## How we'd know it works

- Pick a well-known line (e.g. Italian Game main line), drill as White,
  deviate on purpose at move 4 — verify the toast shows the deviation and the
  board resets to the line start, not to move 1 of a totally different game.
- Verify the bot's replies for the first N plies exactly match the stored
  line's moves with no engine call in between (check response latency — should
  be near-instant for in-book plies, normal engine latency once off the end of
  the line).
- Play a full line through to its end without deviating — verify play falls
  through to normal rated bot search afterward rather than the game ending or
  repeating the last book move forever.
- Drill the same line 5 times with the same deviation point — verify
  `opening_drill_attempt` has 5 rows, not 1, and a per-line accuracy query
  shows the trend.
