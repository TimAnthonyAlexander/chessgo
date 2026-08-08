<?php

namespace App\Controllers;

use BaseApi\Controllers\Controller;
use BaseApi\Http\JsonResponse;
use App\Models\PremoveGame;
use App\Models\User;
use App\Services\NoPuzzleAvailableException;
use App\Services\PremoveTrainerService;

/**
 * Premove Trainer: deal a new attempt and fetch an existing one's state
 * (docs/tasks/open/premove-trainer.md §8, the frozen contract). Release lives
 * on the separate {@see PremoveReleaseController} (its own sub-resource).
 *
 *   POST /premove-games        { format: "rated" | "casual" }
 *   GET  /premove-games/{id}
 *
 * Session is OPTIONAL, same shape as PuzzleController: a logged-in user gets
 * rating-matched + de-duplicated puzzles and an isolated rating_premove
 * update; an anonymous player still plays — including the rated format's real
 * clock — but is never rated (contract §6).
 */
class PremoveGameController extends Controller
{
    public string $id = '';

    /** "rated" | "casual" (post-only). */
    public string $format = '';

    public function __construct(private readonly PremoveTrainerService $trainer)
    {
    }

    public function post(): JsonResponse
    {
        $this->validate([
            'format' => 'required|string|in:rated,casual',
        ]);

        $user = $this->resolveUser();

        try {
            $game = $this->trainer->create($user, $this->format);
        } catch (NoPuzzleAvailableException) {
            return JsonResponse::error('no puzzle available', 503);
        }

        return JsonResponse::created($this->trainer->present($game));
    }

    public function get(): JsonResponse
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

        return JsonResponse::ok($this->trainer->present($game));
    }

    /**
     * A rated attempt belongs to exactly one account, and rating_premove is
     * public on the leaderboard — so only the owner may read it or release into
     * it. An anonymous attempt (`user_id === null`) carries no identity to check
     * and nothing to steal: it is unrated by construction, so it stays open.
     *
     * Answered as 404 rather than 403 so probing an id can't confirm that a game
     * exists.
     */
    private function owns(PremoveGame $game): bool
    {
        if ($game->user_id === null) {
            return true;
        }

        return $this->resolveUser()?->id === $game->user_id;
    }

    /**
     * Resolve the optional authenticated user: token-auth payload first, then
     * the SPA session — mirroring PuzzleController::resolveUser().
     */
    private function resolveUser(): ?User
    {
        $u = $this->request->user ?? null;
        $uid = null;
        if (is_array($u) && !empty($u['id'])) {
            $uid = (string) $u['id'];
        } elseif (!empty($_SESSION['user_id'])) {
            $uid = (string) $_SESSION['user_id'];
        }

        if ($uid === null) {
            return null;
        }
        $found = User::find($uid);

        return $found instanceof User ? $found : null;
    }
}
