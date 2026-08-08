<?php

namespace App\Controllers;

use BaseApi\App;
use BaseApi\Controllers\Controller;
use BaseApi\Http\JsonResponse;
use App\Models\User;
use App\Services\BearerAuth;
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
        // Who is calling? Three sources, in order, and NONE of them may be the
        // only one: the ticket's identity decides whether live play is rated and
        // whether the hub can tie this connection to games the same account has
        // open elsewhere, so falling through to anonymous is a real bug, not a
        // graceful degradation.
        //
        //   1. $request->user  — set by OptionalAuthMiddleware when it's in effect.
        //   2. the bearer token, resolved HERE (BearerAuth) — the middleware was
        //      silently not applying in production, which handed every iOS client
        //      an anonymous ticket keyed by its install id.
        //   3. the session — the SPA's cookie path.
        $user = $this->request->user ?? null;
        if (!is_array($user) || empty($user['id'])) {
            $user = BearerAuth::user($this->request);
        }

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
                // Every variant has its own isolated pool — the hub matches and
                // displays that variant's games by this rating (categoryFor →
                // the same key). A category MISSING from this map silently falls
                // back to Identity.Rating (blitz) in auth.Identity.RatingFor, so
                // forgetting one here doesn't fail loudly — it just pairs that
                // variant's players by their blitz strength.
                'chess960' => (int)($user['rating_chess960'] ?? 1500),
                'duck' => (int)($user['rating_duck'] ?? 1500),
                'crazyhouse' => (int)($user['rating_crazyhouse'] ?? 1500),
                'antichess' => (int)($user['rating_antichess'] ?? 1500),
                'secretqueen' => (int)($user['rating_secretqueen'] ?? 1500),
            ];
            $identity = [
                'sub' => (string)$user['id'],
                'anon' => false,
                'name' => (string)($user['name'] ?? 'Player'),
                'rating' => $ratings['blitz'], // default shown when category is unknown
                'ratings' => $ratings,
            ];
            // Derived title (real title wins, otherwise admins show "AM"). $user
            // always came from User::jsonSerialize() here (request->user,
            // BearerAuth, or the session lookup below all resolve through
            // UserProvider::byId / User::find()->jsonSerialize()), so
            // $user['title'] is already the derived displayTitle() value — omit
            // the claim entirely for a titleless account rather than sending
            // null/empty, so it never reaches the hub as a placeholder.
            if (is_string($user['title'] ?? null) && $user['title'] !== '') {
                $identity['title'] = $user['title'];
            }
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
