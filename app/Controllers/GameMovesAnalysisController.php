<?php

namespace App\Controllers;

use BaseApi\Controllers\Controller;
use BaseApi\Http\JsonResponse;
use App\Services\GameAnalysisService;
use RuntimeException;

/**
 * Stateless full-game engine analysis for an ad-hoc move list — no persisted
 * Game record, nothing cached, nothing written to the database. Powers Blunder
 * Rewind for games {@see GameAnalysisController} can't reach because they have no
 * Game row to resolve by hub_game_id (bot games chiefly — BotGame is a separate
 * model with no hub_game_id). Same payload shape as GET /games/{id}/analysis.
 *
 * Standard rules only: the frontend only ever sends a move list through this
 * path for standard/alternating games (see BotGame.tsx / BoardActions.tsx —
 * Chess960/Duck/Crazyhouse/Antichess replay via their own id-based or
 * dedicated-engine paths).
 *
 *   POST /games/analysis   { moves: string[], startFen?: string }
 */
class GameMovesAnalysisController extends Controller
{
    public string $startFen = '';

    public function __construct(private readonly GameAnalysisService $analysis)
    {
    }

    public function post(): JsonResponse
    {
        // `moves` is a plain array param — scalar property binding doesn't cover
        // arrays (see CandidatesController's `history`), so read + validate it
        // from the raw body directly.
        $body = $this->request->body ?? [];
        $moves = array_values(array_map('strval', (array) ($body['moves'] ?? [])));

        if ($moves === [] || in_array('', $moves, true)) {
            return JsonResponse::badRequest('moves must be a non-empty list of UCI strings');
        }

        $startFen = $this->startFen !== '' ? $this->startFen : null;

        try {
            $result = $this->analysis->analyzeMoves($moves, $startFen);
        } catch (RuntimeException $e) {
            return JsonResponse::error('analysis failed: ' . $e->getMessage(), 502);
        }

        return JsonResponse::ok($result);
    }
}
