<?php

namespace App\Controllers;

use BaseApi\App;
use BaseApi\Controllers\Controller;
use BaseApi\Http\JsonResponse;
use App\Models\User;
use App\Services\WsTicketService;

/**
 * Issues a WebSocket ticket for the realtime hub (SPEC §multiplayer). Public:
 * an anonymous player gets a casual-only ticket; a logged-in user (once frontend
 * auth exists) gets their account identity so rated play is possible.
 *
 *   GET /ws-ticket  → { ticket, wsUrl, identity:{name, anon, rating} }
 */
class WsTicketController extends Controller
{
    /** Stable per-browser anonymous id (from the client's ?anon=). */
    public string $anon = '';

    public function __construct(private readonly WsTicketService $tickets)
    {
    }

    public function get(): JsonResponse
    {
        // Optional session auth: resolve the logged-in user from the session
        // (SessionStartMiddleware ran). $request->user is only set on the
        // token-auth path, so fall back to the session user_id for the SPA.
        $user = $this->request->user ?? null;
        if (!is_array($user) || empty($user['id'])) {
            $uid = $_SESSION['user_id'] ?? null;
            if ($uid) {
                $found = User::find((string)$uid);
                $user = $found instanceof User ? $found->jsonSerialize() : null;
            }
        }

        if (is_array($user) && !empty($user['id'])) {
            $ratings = [
                'bullet' => (int)($user['rating_bullet'] ?? 1500),
                'blitz' => (int)($user['rating_blitz'] ?? 1500),
                'rapid' => (int)($user['rating_rapid'] ?? 1500),
                'classical' => (int)($user['rating_classical'] ?? 1500),
            ];
            $identity = [
                'sub' => (string)$user['id'],
                'anon' => false,
                'name' => (string)($user['name'] ?? 'Player'),
                'rating' => $ratings['blitz'], // default shown when category is unknown
                'ratings' => $ratings,
            ];
        } else {
            // Anonymous: a stable browser id (sub) lets the hub reconnect/resume.
            $anonId = preg_replace('/[^A-Za-z0-9_-]/', '', $this->anon) ?? '';
            $anonId = substr($anonId, 0, 64);
            if ($anonId === '') {
                $anonId = 'anon-' . bin2hex(random_bytes(8));
            }
            $identity = ['sub' => $anonId, 'anon' => true, 'name' => 'Anonymous', 'rating' => 0];
        }

        return JsonResponse::ok([
            'ticket' => $this->tickets->mint($identity),
            'wsUrl' => (string) (App::config('gomachine.ws_public_url') ?? 'ws://127.0.0.1:6467/ws'),
            'identity' => [
                'name' => $identity['name'],
                'anon' => $identity['anon'],
                'rating' => $identity['rating'],
            ],
        ]);
    }
}
