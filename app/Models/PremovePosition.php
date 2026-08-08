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

    /**
     * Length of a chain of premoves that MATES against every defence — the
     * defining property of this pool. Queue these N moves, release, and it mates
     * whatever the defender plays. Nothing else qualifies.
     *
     * This replaced a weaker `safe_depth` that only required each queued move to
     * stay legal and still winning. That is satisfiable by shuffling: a queen can
     * circle a corner forever without progressing, so KQvK scored a perfect 10
     * while still playing like a calculation exercise. Requiring the chain to
     * actually mate is what makes the mode premoving rather than tactics.
     *
     * Forcing needs a BARE enemy king. Measured: every signature with any
     * defending material scores 0 (KQvKR 0/30, KPvK 0/20 even with 26-move
     * chains) because defender material multiplies their options and no chain
     * survives. KRvK is 0 too — a lone rook cannot herd a king blind.
     */
    public int $forced_chain_len = 0;

    /** Difficulty this position is served/rated against. Derived from
     *  forced_chain_len + piece_count — see
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
