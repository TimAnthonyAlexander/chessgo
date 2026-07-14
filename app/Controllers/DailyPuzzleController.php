<?php

namespace App\Controllers;

use BaseApi\App;
use BaseApi\Controllers\Controller;
use BaseApi\Http\JsonResponse;
use App\Models\Puzzle;
use App\Services\CacheHelper;
use App\Services\EngineSelector;

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

    /** Cache namespace + TTL for the computed daily payload. The cache key is the
     * UTC date, so it rotates itself at midnight; the TTL just needs to comfortably
     * cover a day (a hair over 24h so a same-day miss can't expire early). */
    private const CACHE_NS = 'puzzle_daily';

    private const CACHE_TTL = 90000; // 25h

    public function __construct(
        private readonly EngineSelector $engine,
    ) {}

    public function get(): JsonResponse
    {
        // The daily puzzle is identical for everyone all UTC day, so the whole
        // computed payload (including the two engine round-trips below) is cached
        // under the date. Only the first caller per day pays the cold cost; every
        // refresh/visitor after that is a file-cache hit. A null result (no puzzle
        // / malformed / engine hiccup) is self-healing — Cache::get can't tell it
        // from a miss, so it simply recomputes next call instead of pinning a bad
        // day. No jitter: one key per day makes stampede-spreading pointless.
        $payload = CacheHelper::remember(
            self::CACHE_NS,
            gmdate('Y-m-d'),
            self::CACHE_TTL,
            fn(): ?array => $this->buildDaily(),
            false,
        );

        if ($payload === null) {
            return JsonResponse::notFound('No daily puzzle available');
        }

        return JsonResponse::ok($payload);
    }

    /**
     * Compute today's daily-puzzle payload (the cache-miss path). Returns null on
     * any failure so the caller renders a 404 and nothing bad is cached.
     *
     * @return array<string, mixed>|null
     */
    private function buildDaily(): ?array
    {
        $puzzle = $this->pickDaily();
        if (!$puzzle instanceof Puzzle) {
            return null;
        }

        $solution = $puzzle->getMoves();
        if (count($solution) < 2) {
            return null;
        }

        // Auto-play the opponent's setup move; the player solves from the result.
        $applied = $this->engine->move($puzzle->fen, $solution[0]);
        if (empty($applied['legal'])) {
            return null;
        }
        $playerFen = $applied['newFen'];
        $legal = $this->engine->legalMoves($playerFen);

        return [
            'id' => $puzzle->id,
            'rating' => $puzzle->rating,
            'start_fen' => $puzzle->fen,
            'opponent_move' => $solution[0],
            'fen' => $playerFen,
            'color' => $applied['sideToMove'] ?? 'w',
            'legal_moves' => $legal['moves'] ?? [],
            'ply' => 1,
            'themes' => $puzzle->getThemes(),
        ];
    }

    /**
     * Pick the deterministic puzzle for today's UTC date.
     *
     * A keyset seek, NOT a COUNT + `LIMIT 1 OFFSET n`: the old approach filesorted
     * the whole ~80k-row rating band and skipped n rows on every call. Instead we
     * derive an 8-hex boundary from crc32(date) and take the first in-band puzzle
     * whose (UUID) id >= that boundary in primary-key order — an index seek that
     * stops at the first match. Same date ⇒ same boundary ⇒ same row all day, a
     * different row tomorrow; UUIDv5 ids are hash-uniform so the pick is well
     * spread. Wrap-around (boundary past the last in-band id) falls back to the
     * first in-band row.
     */
    private function pickDaily(): ?Puzzle
    {
        $boundary = sprintf('%08x-0000-0000-0000-000000000000', crc32(gmdate('Y-m-d')) & 0xffffffff);

        $rows = App::db()->raw(
            "SELECT id FROM puzzle
             WHERE rating BETWEEN ? AND ? AND id >= ?
             ORDER BY id
             LIMIT 1",
            [self::MIN_RATING, self::MAX_RATING, $boundary],
        );

        if (empty($rows)) {
            $rows = App::db()->raw(
                "SELECT id FROM puzzle
                 WHERE rating BETWEEN ? AND ?
                 ORDER BY id
                 LIMIT 1",
                [self::MIN_RATING, self::MAX_RATING],
            );
        }

        $id = $rows[0]['id'] ?? null;
        if ($id === null) {
            return null;
        }

        $puzzle = Puzzle::find((string) $id);

        return $puzzle instanceof Puzzle ? $puzzle : null;
    }
}
