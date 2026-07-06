<?php

namespace App\Controllers;

use BaseApi\Controllers\Controller;
use BaseApi\Http\JsonResponse;
use App\Models\GuessGame;
use App\Services\GuessGameService;

/**
 * "Guess the Elo" — lock in a guess and reveal the answer (SPEC §Guess the Elo).
 *
 *   POST /guess-the-elo/{id}/guess  { guess: 700..2500 }
 *     → { actual, guess, delta, score, result }
 *
 * The true rating lives only in the DB until this call, so scoring is entirely
 * server-side (the client never had the answer). One-shot: a second guess on the
 * same round returns the FIRST result unchanged — you can't re-roll your score.
 */
class GuessAnswerController extends Controller
{
    public string $id = '';

    public int $guess = 0;

    public function __construct(private readonly GuessGameService $games)
    {
    }

    public function post(): JsonResponse
    {
        if ($this->id === '') {
            return JsonResponse::badRequest('game id is required');
        }

        $this->validate([
            'guess' => 'required|integer|min:700|max:2500',
        ]);

        $game = GuessGame::find($this->id);
        if (!$game instanceof GuessGame) {
            return JsonResponse::notFound('game not found');
        }

        // Idempotent: once answered, always report the original guess + score.
        if ($game->isAnswered()) {
            return JsonResponse::ok($this->reveal($game));
        }

        $game->guess = $this->games->clampGuess($this->guess);
        $game->score = $this->games->score($game->guess, $game->rating);
        $game->answered_at = date('c');
        $game->save();

        return JsonResponse::ok($this->reveal($game));
    }

    /** @return array<string, mixed> */
    private function reveal(GuessGame $game): array
    {
        return [
            'actual' => $game->rating,
            'guess' => $game->guess,
            'delta' => abs(($game->guess ?? 0) - $game->rating),
            'score' => $game->score,
            'result' => $game->result,
        ];
    }
}
