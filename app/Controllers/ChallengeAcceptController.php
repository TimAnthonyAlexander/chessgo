<?php

namespace App\Controllers;

use BaseApi\Controllers\Controller;
use BaseApi\Http\JsonResponse;
use App\Models\Challenge;
use App\Services\HubClient;
use App\Services\NotificationService;

/**
 *   POST /challenges/{id}/accept — opponent only.
 *
 * Mints a 6-char uppercase alphanumeric code, asks the hub to stand up a
 * server-side challenge under it (HubClient::createServerChallenge), stores
 * the code + marks accepted, notifies the challenger (carrying the code), and
 * returns { code } so the accepter can navigate straight to /challenge/{code}.
 *
 * Unlike everywhere else this API talks to the hub, a hub failure here MUST
 * surface as an error — there is no game to join without it.
 */
class ChallengeAcceptController extends Controller
{
    public string $id = '';

    private const CODE_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';

    private const CODE_LENGTH = 6;

    private const TTL_SECONDS = 86400;

    public function __construct(
        private readonly NotificationService $notifications,
        private readonly HubClient $hub,
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
        if ($challenge->expires_at !== null && $challenge->expires_at < gmdate('Y-m-d H:i:s')) {
            return JsonResponse::badRequest('challenge has expired');
        }

        $code = self::generateCode();

        $ok = $this->hub->createServerChallenge([
            'code' => $code,
            'pool' => $challenge->pool,
            'color' => $challenge->color,
            'rated' => $challenge->rated,
            'variant' => $challenge->variant,
            'fen' => $challenge->fen ?? '',
            'creatorSub' => $challenge->challenger_id,
            'opponentSub' => $challenge->opponent_id,
            'ttlSeconds' => self::TTL_SECONDS,
        ]);

        if (!$ok) {
            return JsonResponse::error('could not create the game on the realtime server', 502);
        }

        $challenge->status = 'accepted';
        $challenge->code = $code;
        $challenge->save();

        $this->notifications->push($challenge->challenger_id, 'challenge_accepted', [
            'challengeId' => $challenge->id,
            'userId' => $me,
            'code' => $code,
        ]);

        return JsonResponse::ok(['code' => $code]);
    }

    private static function generateCode(): string
    {
        $alphabetLength = strlen(self::CODE_ALPHABET);
        $code = '';
        for ($i = 0; $i < self::CODE_LENGTH; $i++) {
            $code .= self::CODE_ALPHABET[random_int(0, $alphabetLength - 1)];
        }

        return $code;
    }
}
