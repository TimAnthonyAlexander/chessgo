<?php

namespace App\Controllers;

use BaseApi\Controllers\Controller;
use BaseApi\Http\JsonResponse;
use App\Models\FriendLink;
use App\Services\NotificationService;

/**
 *   POST /friends/{id}/accept — only the addressee may accept.
 */
class FriendAcceptController extends Controller
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

        $link->status = 'accepted';
        $link->save();

        $this->notifications->push($link->requester_id, 'friend_accepted', [
            'userId' => $me,
        ]);

        return JsonResponse::ok(['status' => 'accepted']);
    }
}
