# Don't rate a puzzle that was solved with a hint

**Status:** completed — 2026-07-29.

Client sends `hinted` with the solving move; `applyResult` takes it as a fourth
parameter and, when set, records the `PuzzleAttempt` with
`rating_before === rating_after` (so it consumes the first-attempt slot) and
skips the Glicko update entirely. The response carries `unrated: bool` and
`reason: 'hint'|'replay'|null`, so the UI distinguishes a hinted solve from a
replay instead of showing a bare "+0". `recordActivity` (daily flame) and the
client-side "hint doesn't extend the session streak" rule are unchanged.

**Trust decision (open risk):** `rating_puzzle` *is* on the public leaderboard
(`LeaderboardController.php:28`), so a modified client can claim `hinted` on
every failure to dodge rating losses forever. Shipped trusting the flag: the lie
is one-directional (`solved` stays engine-verified, so a gain can't be
fabricated, only a loss avoided) and real proof-of-hint needs the schema change
this task forbids. See `docs/tasks/open/server-side-hint-proof.md`.

One doc correction: `post()` has never used `$this->validate([...])` for
`move`/`fen`/`ply` — it casts manually with early `badRequest` returns. `hinted`
was added the same way rather than introducing a second pattern.

The puzzle trainer now has a two-stage hint (piece, then full move). Rating is
decided entirely server-side in `PuzzleController::applyResult`, and the server
has no concept of a hint, so **a hinted solve earns full puzzle rating today**.
Neither Lichess nor chess.com rates a puzzle you were shown the answer to.

The frontend already tracks a `hinted` flag on its local `Outcome` and marks
those solves in the session history strip; it just isn't sent anywhere.

## Design

- Client sends a `hinted` boolean with the solving move to `POST /puzzles/{id}/move`.
- When set, the server records the attempt as it does now but applies no rating
  change to either the user or the puzzle. The response says so explicitly (a
  flag, not a bare `delta: 0`) so the UI can be honest rather than showing a
  misleading "+0".
- `applyResult` is already idempotent through its `alreadyPlayed` check against
  `puzzle_attempt`; the two paths have to compose without double-counting.
- **No schema change.** Skipping the rating update at request time is enough. Do
  not add a column, do not touch a model, do not run the migration generator for
  this.
- The flag is untrusted client input: validate it, and note that a client can lie
  in the other direction too, claiming a hint to dodge a rating loss. Decide
  whether that matters at this scale and write down the reasoning.

## Done when

Taking a hint costs you the rating on that puzzle, and the result card says that
plainly. The existing rule that a hinted solve doesn't extend the streak stays.
