# Don't rate a puzzle that was solved with a hint

**Status:** not started. Rating hole is live.

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
