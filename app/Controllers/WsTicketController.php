<?php

namespace App\Controllers;

use BaseApi\Controllers\Controller;
use BaseApi\Http\JsonResponse;
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
    public function __construct(private readonly WsTicketService $tickets)
    {
    }

    public function get(): JsonResponse
    {
        $user = $this->request->user ?? null;

        if (is_array($user) && !empty($user['id'])) {
            $identity = [
                'sub' => (string)$user['id'],
                'anon' => false,
                'name' => (string)($user['name'] ?? 'Player'),
                'rating' => (int)($user['rating'] ?? 1500),
            ];
        } else {
            $identity = ['sub' => '', 'anon' => true, 'name' => 'Anonymous', 'rating' => 0];
        }

        return JsonResponse::ok([
            'ticket' => $this->tickets->mint($identity),
            'wsUrl' => $_ENV['WS_PUBLIC_URL'] ?? 'ws://127.0.0.1:6467/ws',
            'identity' => [
                'name' => $identity['name'],
                'anon' => $identity['anon'],
                'rating' => $identity['rating'],
            ],
        ]);
    }
}
