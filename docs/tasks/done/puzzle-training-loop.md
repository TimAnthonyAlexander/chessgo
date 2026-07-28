# Puzzle trainer: hint, retry, streak — 2026-07-28

Uncommitted in the working tree. Typechecks and lints clean.

The trainer had themes, timed sessions and a rating, but none of the things that
make it a training loop: no hint, no way to replay the puzzle you just failed,
no streak.

## Shipped

**Two-stage hint.** First press rings the piece that should move; second press
rings the full move. The puzzle payload never carries the solution (confirmed
against `PuzzleController::post`), so the hint comes from the engine —
`analyze(fen, { movetime: 400 })`, fetched lazily on first press and cached per
position. `Board.tsx` gained one additive optional prop, `hintStage:
'piece' | 'move' | null`, independent of the pre-existing `hintReveal` hold-H
admin peek; BotGame and LiveGame pass nothing new and are unchanged.

**Retry.** `applyResult` is already idempotent — an existing `puzzle_attempt` row
short-circuits to `delta: 0` — so a retry resubmits safely with no backend change.
A retried attempt isn't pushed to the session history (the original failure stands
as the record), doesn't touch the streak, and shows a "not rescored" chip instead
of a misleading +0.

**Streak.** Current streak (session only, resets on failure) and best streak,
persisted under `chessgo.puzzleStreak` and sanitized on read the way
`lib/settings.ts` sanitizes its blob. Hinted and retried solves don't extend it.
Rendered as a number and a label — no flame, no emoji, deliberately distinct from
the navbar's daily-activity streak.

## Known hole

A hinted solve still earns full rating, because rating is decided server-side and
the server has no concept of a hint. Tracked in
`docs/tasks/open/hinted-puzzles-unrated.md`.
