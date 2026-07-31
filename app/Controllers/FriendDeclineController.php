<?php

namespace App\Controllers;

use BaseApi\Controllers\Controller;
use BaseApi\Http\JsonResponse;
use App\Models\FriendLink;
use App\Services\NotificationService;

/**
 *   POST /friends/{id}/decline — only the addressee may decline.
 *
 * The row is kept (status='declined') rather than deleted: FriendController's
 * mutual-request handling and re-request-after-decline both key off it.
 */
class FriendDeclineController extends Controller
{
    public string $id = '';

    public function __construct(
        private readonly NotificationService $notifications,
    ) {
    }

    public function post(): JsonResponse
    {
        $user = $this->request->user;
        $me = is_string($user['id'] ?? null) ? $user['id'] : null;
        if ($me === null || $me === '') {
            return JsonResponse::unauthorized();
        }

        $link = FriendLink::find($this->id);
        if (!$link instanceof FriendLink) {
            return JsonResponse::notFound('not found');
        }
        if ($link->addressee_id !== $me) {
            return JsonResponse::forbidden();
        }
        if ($link->status !== 'pending') {
            return JsonResponse::badRequest('request is not pending');
        }

        $link->status = 'declined';
        $link->save();

        return JsonResponse::ok(['status' => 'declined']);
    }
}
