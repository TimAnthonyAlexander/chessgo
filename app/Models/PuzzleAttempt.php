<?php

namespace App\Models;

use BaseApi\Database\Relations\BelongsTo;
use BaseApi\Models\BaseModel;

/**
 * A user's first encounter with a puzzle: the rated outcome and the Elo delta.
 *
 * Only ONE attempt per (user, puzzle) is recorded — the first one is the rated
 * one (Lichess model). Its existence drives both de-duplication (don't re-serve
 * a seen puzzle) and rating idempotency (never double-apply Elo for a puzzle).
 * Anonymous solvers are not recorded. See docs/SPEC.md §Puzzles.
 */
class PuzzleAttempt extends BaseModel
{
    public string $user_id = '';

    /** References Puzzle::id (the UUID PK; case-safe, unlike the Lichess ext_id). */
    public string $puzzle_id = '';

    /** True = solved with no wrong move; false = failed. */
    public bool $solved = false;

    /** User's rating_puzzle before this attempt. */
    public int $rating_before = 1500;

    /** User's rating_puzzle after this attempt. */
    public int $rating_after = 1500;

    /**
     * @var array<int|string, mixed>
     */
    public static array $indexes = [
        ['user_id', 'puzzle_id', 'type' => 'unique'],
    ];

    public function user(): BelongsTo
    {
        return $this->belongsTo(User::class);
    }
}
