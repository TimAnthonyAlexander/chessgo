<?php

namespace App\Controllers;

use BaseApi\Controllers\Controller;
use BaseApi\Http\JsonResponse;
use App\Models\BotGame;
use App\Services\BotGameService;

/**
 * Submit the human's move in a bot game; the bot's reply (if any) is computed
 * and applied in the same request (SPEC §7.2).
 *
 *   POST /bot-games/{id}/move   { move: "e2e4" }   // UCI long algebraic
 */
class BotMoveController extends Controller
{
    public string $id = '';

    public string $move = '';

    public function __construct(private readonly BotGameService $games)
    {
    }

    public function post(): JsonResponse
    {
        $this->validate([
            'move' => 'required|string|max:5',
        ]);

        $game = BotGame::find($this->id);
        if (!$game instanceof BotGame) {
            return JsonResponse::notFound('game not found');
        }

        $outcome = $this->games->humanMove($game, $this->move);
        if (!($outcome['ok'] ?? false)) {
            return JsonResponse::unprocessable($outcome['error'] ?? 'move rejected');
        }

        return JsonResponse::ok($this->games->present($game));
    }
}
