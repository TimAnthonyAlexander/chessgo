<?php

namespace App\Controllers;

use BaseApi\Controllers\Controller;
use BaseApi\Http\JsonResponse;
use App\Models\Notification;

/**
 *   POST /notifications/read — body { ids: [] } — marks the given
 *   notifications read. Ids the caller doesn't own are silently skipped
 *   (scoped to user_id in the query), not errored.
 */
class NotificationReadController extends Controller
{
    /** @var list<string> */
    public array $ids = [];

    public function post(): JsonResponse
    {
        $user = $this->request->user;
        $me = is_string($user['id'] ?? null) ? $user['id'] : null;
        if ($me === null || $me === '') {
            return JsonResponse::unauthorized();
        }

        $this->validate([
            'ids' => 'required|array',
        ]);

        $ids = array_values(array_filter(array_map('strval', $this->ids), static fn (string $id): bool => $id !== ''));
        if ($ids === []) {
            return JsonResponse::ok(['updated' => 0]);
        }

        $now = date('Y-m-d H:i:s');
        $updated = 0;
        foreach (Notification::query()->whereIn('id', $ids)->where('user_id', '=', $me)->get() as $n) {
            if ($n->read_at === null) {
                $n->read_at = $now;
                $n->save();
                $updated++;
            }
        }

        return JsonResponse::ok(['updated' => $updated]);
    }
}
