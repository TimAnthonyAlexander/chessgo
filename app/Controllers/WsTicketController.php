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
    /** Stable per-browser anonymous id (from the client's ?anon=). */
    public string $anon = '';

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
            'wsUrl' => $_ENV['WS_PUBLIC_URL'] ?? 'ws://127.0.0.1:6467/ws',
            'identity' => [
                'name' => $identity['name'],
                'anon' => $identity['anon'],
                'rating' => $identity['rating'],
            ],
        ]);
    }
}
