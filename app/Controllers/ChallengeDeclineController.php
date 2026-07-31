<?php

namespace App\Controllers;

use BaseApi\Controllers\Controller;
use BaseApi\Http\JsonResponse;
use App\Models\Challenge;
use App\Services\NotificationService;

/**
 *   POST /challenges/{id}/decline — opponent only.
 */
class ChallengeDeclineController extends Controller
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

        $challenge = Challenge::find($this->id);
        if (!$challenge instanceof Challenge) {
            return JsonResponse::notFound('not found');
        }
        if ($challenge->opponent_id !== $me) {
            return JsonResponse::forbidden();
        }
        if ($challenge->status !== 'pending') {
            return JsonResponse::badRequest('challenge is not pending');
        }

        $challenge->status = 'declined';
        $challenge->save();

        $this->notifications->push($challenge->challenger_id, 'challenge_declined', [
            'challengeId' => $challenge->id,
            'userId' => $me,
        ]);

        return JsonResponse::ok(['status' => 'declined']);
    }
}
