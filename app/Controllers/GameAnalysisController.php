<?php

namespace App\Controllers;

use BaseApi\Controllers\Controller;
use BaseApi\Http\JsonResponse;
use App\Models\Game;
use App\Services\GameAnalysisService;
use RuntimeException;

/**
 * Full-game engine analysis for a finished live game: per-ply eval, the engine's
 * best move, and a blunder/mistake/inaccuracy judgment for every move. Computed
 * at full strength on first request and cached on the Game. Public.
 *
 *   GET /games/{id}/analysis
 */
class GameAnalysisController extends Controller
{
    public string $id = '';

    public function __construct(private readonly GameAnalysisService $analysis)
    {
    }

    public function get(): JsonResponse
    {
        if ($this->id === '') {
            return JsonResponse::badRequest('game id is required');
        }
        $game = Game::firstWhere('hub_game_id', '=', $this->id);
        if (!$game instanceof Game) {
            return JsonResponse::notFound('game not found');
        }
        if ($game->getMoves() === []) {
            return JsonResponse::badRequest('game has no moves to analyze');
        }

        try {
            $result = $this->analysis->analyze($game);
        } catch (RuntimeException $e) {
            return JsonResponse::error('analysis failed: ' . $e->getMessage(), 502);
        }

        return JsonResponse::ok($result);
    }
}
