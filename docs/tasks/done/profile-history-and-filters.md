# Profile: per-pool rating history and game search — 2026-07-28

Uncommitted in the working tree. Typechecks and PHP-lints clean.

The profile showed one sparkline, for the player's primary pool only; the other
seven pools were bare numbers with no trend. Game history had category and result
filters and nothing else — no way to find your games against a particular person.

## Shipped

**Rating history.** The old hero sparkline was reconstructed client-side from the
first page of 10 recent games, far too sparse to split across seven pools.
`GET /users/{name}` (`ProfileController.php`) now returns
`ratingHistory: Record<string, number[]>` — one series per pool, from
`Game.category` + `rating_after`, plus puzzles from `PuzzleAttempt.rating_after`,
each capped at the last 20 rated results, oldest first. Built with `ModelQuery`
chains, no raw SQL, no schema change.

`RatingsPanel.tsx` renders a small `RatingSparkline` on every pool row. The
client-side `ratingSeries` helper went away as dead code, and `primaryRating()`
now reads the same authoritative source instead of re-deriving a partial one.

**Game filters.** `ProfileGamesController.php` gained `opponent` (parameterized
`LIKE` against whichever side isn't the profiled player) and inclusive `from`/`to`
day bounds on `created_at`, composing with the existing category and result
filters via `whereGroup`. `GamesPanel.tsx` gained a filter bar: search box
debounced 300ms locally, two native date inputs, styled to match the existing
hand-rolled chip controls. Pagination and the loading skeleton are untouched.
