# Server-side proof that a puzzle hint was actually taken

**Status:** not started. Known, accepted risk from `hinted-puzzles-unrated.md`
(completed 2026-07-29).

Puzzle solves now carry a `hinted` boolean, and when it's set the server skips
the Glicko update. The flag is **untrusted client input with no server-side
corroboration**, so a modified client can send `hinted: true` on every failure
and never lose puzzle rating again.

## Why this was shipped anyway

The lie is one-directional. `solved` is still decided server-side against the
puzzle's solution, so a liar cannot fabricate a rating *gain* — only avoid a
loss. Real proof-of-hint needs persistent state that `hinted-puzzles-unrated.md`
explicitly forbade adding.

## Why it still matters

`rating_puzzle` is on the **public leaderboard** (`LeaderboardController.php:28`)
and the profile. A one-directional lie is still rating inflation on a ranked,
publicly visible number: never losing rating is enough to climb given time.

## Sketch

The server already sees hint traffic — stage 1 of the trainer's hint calls
`analyze()` for the best move. Options, cheapest first:

1. **Session-scoped hint memo.** Record "a hint was served for puzzle P to user U
   in this session" server-side when the hint request comes in, and trust *that*
   rather than the client's flag. No schema change if it lives in the session or
   a short-TTL cache; the client flag becomes a hint, not the authority.
2. **A `hinted` column on `puzzle_attempt`.** Honest and durable, and makes the
   data queryable ("how many solves are hinted?"). Costs a model edit plus
   `migrate:generate` / `migrate:apply` — trivially cheap, and the reason it was
   skipped was the task's own scope rule, not the cost.
3. **Distinguish the hint endpoint from generic `/analyze`** so hint requests are
   unambiguous in the first place.

Option 1 plus 2 is probably the real answer: authoritative and auditable.

## Done when

Claiming a hint you weren't served does not protect your rating.
