<?php

namespace App\Models;

use BaseApi\Models\BaseModel;

/**
 * Denormalized puzzle↔theme index for fast theme-filtered serving.
 *
 * One row per (puzzle, theme). `rating` is copied from the parent puzzle so a
 * composite (theme, rating) index answers "a puzzle of theme T near rating R"
 * with an index range scan instead of a JSON LIKE full-table scan. Written
 * once at import time alongside the Puzzle. See docs/SPEC.md §Puzzles.
 */
class PuzzleTheme extends BaseModel
{
    /** References Puzzle::ext_id (the Lichess PuzzleId). */
    public string $puzzle_ext_id = '';

    /** A single Lichess theme tag, e.g. "fork", "mateIn3", "endgame". */
    public string $theme = '';

    /** Copied from the parent puzzle for index-only range queries. */
    public int $rating = 1500;

    /**
     * (theme, rating) drives filtered serving; (puzzle_ext_id, theme) is unique
     * so re-running the importer with INSERT IGNORE can't create duplicate rows.
     *
     * @var array<int|string, mixed>
     */
    public static array $indexes = [
        ['theme', 'rating'],
        ['puzzle_ext_id', 'theme', 'type' => 'unique'],
    ];
}
