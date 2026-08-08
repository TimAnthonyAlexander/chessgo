<?php

namespace App\Controllers;

use BaseApi\Controllers\Controller;
use BaseApi\Http\JsonResponse;
use App\Models\PremoveGame;
use App\Services\PremoveTrainerService;

/**
 * Premove Trainer: release a queued chain of premoves and play it out
 * (docs/tasks/open/premove-trainer.md §8, §5). One code path for a fresh
 * chain and for the requeue-after-collapse chain — see the contract §4 for
 * why that's deliberate (a single move is just a chain of length 1).
 *
 *   POST /premove-games/{id}/release   { chain: ["e2e4", "d1h5", ...] }
 */
class PremoveReleaseController extends Controller
{
    public string $id = '';

    public function __construct(private readonly PremoveTrainerService $trainer)
    {
    }

    public function post(): JsonResponse
    {
        if ($this->id === '') {
            return JsonResponse::badRequest('game id is required');
        }
        $game = PremoveGame::find($this->id);
        if (!$game instanceof PremoveGame) {
            return JsonResponse::notFound('game not found');
        }
        if (!$this->owns($game)) {
            return JsonResponse::notFound('game not found');
        }

        // `chain` is a plain array param — scalar property binding doesn't
        // cover arrays (see GameMovesAnalysisController's `moves` for the same
        // pattern) — so it's read straight off the raw body.
        $body = $this->request->body ?? [];
        $chain = array_values(array_map('strval', (array) ($body['chain'] ?? [])));

        try {
            $result = $this->trainer->release($game, $chain);
        } catch (\InvalidArgumentException $e) {
            return JsonResponse::unprocessable($e->getMessage());
        }

        return JsonResponse::ok($this->trainer->present($game, $result['playout'], $result['collapsedAt']));
    }

    /**
     * Only the owner may release into a rated attempt — otherwise anyone holding
     * an id could flag someone else's clock, or hand them a rating gain, and
     * rating_premove is public on the leaderboard. An anonymous attempt
     * (`user_id === null`) has no identity to check and is unrated by
     * construction, so it stays open.
     *
     * 404 rather than 403 so probing an id can't confirm a game exists.
     */
    private function owns(PremoveGame $game): bool
    {
        if ($game->user_id === null) {
            return true;
        }

        $u = $this->request->user ?? null;
        $uid = null;
        if (is_array($u) && !empty($u['id'])) {
            $uid = (string) $u['id'];
        } elseif (!empty($_SESSION['user_id'])) {
            $uid = (string) $_SESSION['user_id'];
        }

        return $uid !== null && $uid === $game->user_id;
    }
}
