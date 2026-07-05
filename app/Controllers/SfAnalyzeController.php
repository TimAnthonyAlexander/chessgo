<?php

namespace App\Controllers;

use BaseApi\Controllers\Controller;
use BaseApi\Http\JsonResponse;
use App\Models\User;
use App\Services\GomachineClient;
use App\Services\AnticheatService;

/**
 * Full-strength Stockfish best move for a position — powers the Analysis board's
 * optional "Stockfish arrow" (a second opinion drawn alongside gomachine's, so
 * you can see where the two engines disagree). Stateless FEN-in, like /analyze,
 * but the search runs in a freshly spawned Stockfish at FULL strength
 * (UCI_LimitStrength off). Returns just the move — the arrow needs nothing else.
 *
 *   POST /sf-analyze   { fen: "<FEN>", movetime?: <ms> }
 *   → { bestmove: "<uci>"|null, san: "<san>"|null, eval: {type,value}|null }
 *
 * `eval` is from the side-to-move's POV (like /analyze), so the UI can plot
 * Stockfish's own read of the position next to gomachine's.
 *
 * `movetime` (optional, clamped 50..2000ms; default 300) trades depth for
 * latency. If Stockfish isn't installed the engine replies non-2xx and the
 * request errors — the client simply omits the arrow.
 */
class SfAnalyzeController extends Controller
{
    public string $fen = '';

    public int $movetime = 0;

    public function __construct(
        private readonly GomachineClient $engine,
        private readonly AnticheatService $anticheat,
    ) {
    }

    public function post(): JsonResponse
    {
        $this->validate([
            'fen' => 'required|string',
        ]);

        // Anti-cheat: flag a logged-in user requesting a full-strength Stockfish
        // move while they have a live game in progress (advisory, admin-reviewed).
        $this->anticheat->checkAnalysisDuringGame($this->currentUser(), $this->fen, 'sf-analyze');

        $movetime = $this->movetime > 0 ? max(50, min(2000, $this->movetime)) : 300;
        // elo 0 → full strength (UCI_LimitStrength stays off in the engine handler).
        $res = $this->engine->stockfishMove($this->fen, 0, $movetime);

        return JsonResponse::ok([
            'bestmove' => $res['bestmove'] ?? null,
            'san' => $res['san'] ?? null,
            'eval' => $res['eval'] ?? null,
        ]);
    }

    /**
     * Resolve the optional logged-in user (session cookie for the SPA, or token
     * auth). Mirrors WsTicketController. Returns null when anonymous.
     *
     * @return array<string, mixed>|null
     */
    private function currentUser(): ?array
    {
        $user = $this->request->user ?? null;
        if (is_array($user) && !empty($user['id'])) {
            return $user;
        }

        $uid = $_SESSION['user_id'] ?? null;
        if ($uid) {
            $found = User::find((string) $uid);
            if ($found instanceof User) {
                return $found->jsonSerialize();
            }
        }

        return null;
    }
}
