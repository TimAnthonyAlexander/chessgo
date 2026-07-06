<?php

namespace App\Controllers;

use BaseApi\Controllers\Controller;
use BaseApi\Http\JsonResponse;
use App\Models\User;
use App\Services\StreakService;

/**
 * "The Flame" — read the current user's daily-activity streak for the homepage
 * widget.
 *
 *   GET /streak   (optional session)
 *   → { current, longest, lastActiveDate, freezeTokens, activeToday }
 *
 * Session is OPTIONAL (SessionStartMiddleware): an anonymous caller gets a neutral
 * empty streak rather than a 401/500, so the widget can render a "sign in to start
 * a streak" state without special-casing the network error.
 */
class StreakController extends Controller
{
    public function __construct(
        private readonly StreakService $streak,
    ) {}

    public function get(): JsonResponse
    {
        $user = $this->resolveUser();
        if (!$user instanceof User) {
            return JsonResponse::ok([
                'current' => 0,
                'longest' => 0,
                'lastActiveDate' => null,
                'freezeTokens' => 0,
                'activeToday' => false,
            ]);
        }

        $view = $this->streak->view($user);

        return JsonResponse::ok([
            'current' => $view['current'],
            'longest' => $user->longest_streak,
            'lastActiveDate' => $user->last_active_date,
            'freezeTokens' => $user->freeze_tokens,
            'activeToday' => $view['activeToday'],
        ]);
    }

    /**
     * Resolve the optional authenticated user: token-auth payload first, then the
     * SPA session — mirroring PuzzleController/WsTicketController.
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
