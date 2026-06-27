<?php

namespace App\Controllers;

use BaseApi\App;
use BaseApi\Controllers\Controller;
use BaseApi\Http\JsonResponse;
use App\Models\Puzzle;
use App\Services\GomachineClient;

/**
 * "Puzzle of the day" — one deterministic puzzle, the SAME for everyone for the
 * whole UTC day, rotating daily.
 *
 *   GET /puzzles/daily
 *   → { id, rating, start_fen, opponent_move, fen, color, legal_moves, ply, themes }
 *
 * Determinism: the puzzle is chosen by the UTC date (gmdate('Y-m-d')) — an
 * OFFSET keyed by crc32(date) into the rating-banded set, ordered by id. Every
 * visitor that day gets the same puzzle; it changes at UTC midnight.
 *
 * Mirrors PuzzleController::get for serving: it auto-plays moves[0] (the
 * opponent's setup move, per Lichess convention puzzle.fen is BEFORE it) via the
 * engine to compute the post-setup fen + legal moves + color, and the solution
 * line is NEVER sent to the client. The returned `id` is the Puzzle UUID, which
 * POST /puzzles/{id}/move consumes (Puzzle::find($id)). Themes are added for
 * display.
 */
class DailyPuzzleController extends Controller
{
    /** Difficulty band the daily puzzle is drawn from (approachable but real). */
    private const MIN_RATING = 1200;

    private const MAX_RATING = 1900;

    public function __construct(
        private readonly GomachineClient $engine,
    ) {}

    public function get(): JsonResponse
    {
        $puzzle = $this->pickDaily();
        if (!$puzzle instanceof Puzzle) {
            return JsonResponse::notFound('No daily puzzle available');
        }

        $solution = $puzzle->getMoves();
        if (count($solution) < 2) {
            return JsonResponse::error('Malformed puzzle', 500);
        }

        // Auto-play the opponent's setup move; the player solves from the result.
        $applied = $this->engine->move($puzzle->fen, $solution[0]);
        if (empty($applied['legal'])) {
            return JsonResponse::error('Malformed puzzle', 500);
        }
        $playerFen = $applied['newFen'];
        $legal = $this->engine->legalMoves($playerFen);

        return JsonResponse::ok([
            'id' => $puzzle->id,
            'rating' => $puzzle->rating,
            'start_fen' => $puzzle->fen,
            'opponent_move' => $solution[0],
            'fen' => $playerFen,
            'color' => $applied['sideToMove'] ?? 'w',
            'legal_moves' => $legal['moves'] ?? [],
            'ply' => 1,
            'themes' => $puzzle->getThemes(),
        ]);
    }

    /**
     * Pick the deterministic puzzle for today's UTC date: a stable OFFSET, keyed
     * by crc32(date), into the rating-banded set ordered by id. Same input ⇒ same
     * row, all day — and a different row tomorrow.
     */
    private function pickDaily(): ?Puzzle
    {
        $count = (int) App::db()->scalar(
            'SELECT COUNT(*) FROM puzzle WHERE rating BETWEEN ? AND ?',
            [self::MIN_RATING, self::MAX_RATING],
        );
        if ($count <= 0) {
            return null;
        }

        $date = gmdate('Y-m-d');
        $offset = crc32($date) % $count; // non-negative: crc32 ≥ 0, count > 0

        $rows = App::db()->raw(
            "SELECT id FROM puzzle
             WHERE rating BETWEEN ? AND ?
             ORDER BY id
             LIMIT 1 OFFSET $offset",
            [self::MIN_RATING, self::MAX_RATING],
        );
        $id = $rows[0]['id'] ?? null;
        if ($id === null) {
            return null;
        }

        $puzzle = Puzzle::find((string) $id);

        return $puzzle instanceof Puzzle ? $puzzle : null;
    }
}
