<?php

namespace App\Controllers;

use BaseApi\Controllers\Controller;
use BaseApi\Http\JsonResponse;
use App\Models\Game;

/**
 * Fetch a finished live game by its hub game id (the id the realtime hub assigns
 * and the client holds after a game). Public — finished games are not secret.
 *
 *   GET /games/{id}
 */
class GameController extends Controller
{
    public string $id = '';

    public function get(): JsonResponse
    {
        if ($this->id === '') {
            return JsonResponse::badRequest('game id is required');
        }
        $game = Game::firstWhere('hub_game_id', '=', $this->id);
        if (!$game instanceof Game) {
            return JsonResponse::notFound('game not found');
        }

        return JsonResponse::ok($game);
    }
}
