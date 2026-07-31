<?php

namespace App\Controllers;

use BaseApi\Controllers\Controller;
use BaseApi\Http\JsonResponse;
use App\Models\Notification;

/**
 *   POST /notifications/read-all — marks every unread notification for the
 *   caller as read.
 */
class NotificationReadAllController extends Controller
{
    public function post(): JsonResponse
    {
        $user = $this->request->user;
        $me = is_string($user['id'] ?? null) ? $user['id'] : null;
        if ($me === null || $me === '') {
            return JsonResponse::unauthorized();
        }

        $now = date('Y-m-d H:i:s');
        $updated = 0;
        foreach (Notification::query()->where('user_id', '=', $me)->whereNull('read_at')->get() as $n) {
            $n->read_at = $now;
            $n->save();
            $updated++;
        }

        return JsonResponse::ok(['updated' => $updated]);
    }
}
