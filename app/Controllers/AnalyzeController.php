<?php

namespace App\Controllers;

use BaseApi\Controllers\Controller;
use BaseApi\Http\JsonResponse;
use App\Models\User;
use App\Services\GomachineClient;
use App\Services\AnticheatService;

/**
 * Full-strength position analysis for the eval bar (SPEC §6). Stateless: takes a
 * FEN, returns the engine's best move + evaluation at full power, regardless of
 * any game's bot difficulty.
 *
 *   POST /analyze   { fen: "<FEN>", movetime?: <ms>, depth?: <ply> }
 *   → { eval: {type:"cp"|"mate", value}, bestmove, pv: [uci...], depth }
 *
 * `pv` is the principal variation (the engine's predicted best line) as UCI
 * moves from this position, used by the analysis board's engine line. `movetime`
 * (optional, clamped 50..2000ms) lets a caller trade depth for latency — e.g. the
 * engine-vs-engine watch view polls a fast eval every ply; default is full power.
 *
 * `depth` (optional, clamped 1..40) searches to a fixed ply depth instead of by
 * time. The analysis board polls with increasing depths to "stream" a refining
 * evaluation (instant shallow guess, then deeper), and keeps climbing with larger
 * `movetime` ceilings the longer the user stays on one position. A time ceiling
 * still applies so a deep request can't hang; when the returned `depth` is less
 * than requested, the ceiling cut it short — the caller uses that (no further
 * deepening despite more budget) to decide it has settled. `depth` takes priority
 * over `movetime`, which then acts as that ceiling.
 */
class AnalyzeController extends Controller
{
    public string $fen = '';

    public int $movetime = 0;

    public int $depth = 0;

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

        // Anti-cheat: a logged-in user analyzing a position while they have a live
        // game in progress is a strong engine-use tell. Advisory only — this
        // raises a flag for admin review, never blocks the analysis or bans.
        $this->anticheat->checkAnalysisDuringGame($this->currentUser(), $this->fen, 'analyze');

        $depth = $this->depth > 0 ? max(1, min(40, $this->depth)) : 0;
        // With a depth target, movetime is a safety ceiling (deep request can't
        // hang the pool); without one it's the search budget. The analysis board's
        // "keep deepening while parked on a position" ladder passes a large ceiling
        // on its deep rungs — allow up to 45s there — while non-depth callers (the
        // fast eval bar / watch view) stay clamped to 2s. The engine returns as soon
        // as it REACHES the target depth, so the big ceiling only bites on positions
        // too complex to get there.
        $movetime = $this->movetime > 0
            ? ($depth > 0 ? max(500, min(45000, $this->movetime)) : max(50, min(2000, $this->movetime)))
            : ($depth > 0 ? 4000 : 1500);
        $res = $this->engine->analyze($this->fen, $movetime, $depth);

        return JsonResponse::ok([
            'eval' => $res['eval'] ?? null,
            'bestmove' => $res['bestmove'] ?? null,
            'pv' => $res['pv'] ?? null,
            'depth' => $res['depth'] ?? null,
        ]);
    }

    /**
     * Resolve the optional logged-in user (session cookie for the SPA, or token
     * auth). Mirrors WsTicketController: $request->user is set only on the token
     * path, so fall back to the session user_id. Returns null when anonymous.
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
