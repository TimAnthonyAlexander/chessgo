<?php

namespace App\Controllers;

use BaseApi\Controllers\Controller;
use BaseApi\Http\JsonResponse;
use App\Models\Notification;

/**
 *   GET /notifications → { items: [...], unread: n }
 *
 * Newest first, capped at 50. `unread` is a separate always-accurate count
 * (not just count of the capped page), so a badge stays correct even past 50
 * backlogged notifications.
 */
class NotificationController extends Controller
{
    private const CAP = 50;

    public function get(): JsonResponse
    {
        $user = $this->request->user;
        $me = is_string($user['id'] ?? null) ? $user['id'] : null;
        if ($me === null || $me === '') {
            return JsonResponse::unauthorized();
        }

        $items = Notification::query()
            ->where('user_id', '=', $me)
            ->orderByDesc('created_at')
            ->limit(self::CAP)
            ->get();

        $unread = Notification::query()
            ->where('user_id', '=', $me)
            ->whereNull('read_at')
            ->count();

        return JsonResponse::ok([
            'items' => array_values($items),
            'unread' => $unread,
        ]);
    }
}
