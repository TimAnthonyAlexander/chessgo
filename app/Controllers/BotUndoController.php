<?php

namespace App\Controllers;

use BaseApi\Controllers\Controller;
use BaseApi\Http\JsonResponse;
use App\Models\BotGame;
use App\Services\BotGameService;

/**
 * Take back the human's last move in a bot game, including any bot reply that
 * has been played since (SPEC §6). It becomes the human's turn again in the
 * position before that move.
 *
 *   POST /bot-games/{id}/undo
 */
class BotUndoController extends Controller
{
    public string $id = '';

    public function __construct(private readonly BotGameService $games)
    {
    }

    public function post(): JsonResponse
    {
        $game = BotGame::find($this->id);
        if (!$game instanceof BotGame) {
            return JsonResponse::notFound('game not found');
        }

        $outcome = $this->games->undo($game);
        if (!($outcome['ok'] ?? false)) {
            return JsonResponse::unprocessable($outcome['error'] ?? 'undo rejected');
        }

        return JsonResponse::ok($this->games->present($game));
    }
}
