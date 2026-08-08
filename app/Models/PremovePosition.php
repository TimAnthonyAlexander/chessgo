<?php

namespace App\Models;

use BaseApi\Models\BaseModel;

/**
 * A single generated Premove Trainer position — a low-piece Syzygy endgame
 * kept because MANY legal moves preserve the win, not because exactly one
 * does. See docs/tasks/open/premove-trainer.md §3.
 *
 * Built (and re-buildable, idempotently) by scripts/build_premove_positions.php.
 * The engine (zugzwang) is the sole authority on legality, evaluation and
 * Syzygy WDL — this model just stores the result of that verdict, plus the
 * inputs that produced `rating`, so the difficulty formula can be recalibrated
 * from real attempt data later without re-generating the pool.
 *
 * There is no solution to redact here (unlike Puzzle) — the entire point of
 * this mode is that many moves win, so the position itself is safe to hand to
 * the client in full.
 */
class PremovePosition extends BaseModel
{
    /** Full FEN of the generated position (side to move is the winning side). */
    public string $fen = '';

    /** Material signature, e.g. "KPvK", "KRPvKR" — see §3.2 of the spec. */
    public string $signature = '';

    /** Side to move in `fen`: 'w' or 'b'. Always the side Syzygy calls winning. */
    public string $side_to_move = 'w';

    /** Total pieces on the board, including both kings. */
    public int $piece_count = 0;

    /** round(100 * winning_moves / legal_moves). The load-bearing filter value —
     *  what makes this a premove drill instead of a puzzle. */
    public int $breadth_pct = 0;

    /** Legal moves from `fen` whose /candidates eval is a TB-win score
     *  (>= 20000 cp, or a positive mate score) for the side to move. */
    public int $winning_moves = 0;

    /** Total legal moves from `fen` (the /legal-moves count). */
    public int $legal_moves = 0;

    /** Plies (half-moves) from `fen` to checkmate when BOTH sides are played
     *  full-strength by the engine (DTZ-optimal for the defender too). */
    public int $conversion_plies = 0;

    /** Difficulty this position is served/rated against. Derived from
     *  conversion_plies + breadth_pct + piece_count — see
     *  RatingFormula::compute() in the builder script for the (explicitly
     *  uncalibrated) heuristic. Stored so the formula can be revisited from
     *  real attempt data without re-generating the pool. */
    public int $rating = 1500;

    /**
     * @var array<int, mixed>
     */
    public static array $indexes = [
        'rating' => 'index',
        ['signature', 'rating'],
    ];
}
