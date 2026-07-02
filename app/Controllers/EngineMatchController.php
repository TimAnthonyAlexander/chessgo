<?php

namespace App\Controllers;

use BaseApi\Controllers\Controller;
use BaseApi\Http\JsonResponse;
use App\Services\GomachineClient;

/**
 * Admin-only "engine vs engine" driver. Plays ONE ply — gomachine at a target
 * Elo rating, or Stockfish at a UCI_Elo — applies it, and returns the new state.
 * The frontend alternates sides and loops with a delay so an admin can watch the
 * two engines compete. Stateless (FEN-in), like the rest of the engine API.
 *
 *   POST /admin/engine-vs/move
 *     { fen, side: "gomachine"|"stockfish", rating?, elo?, movetime?, aggr? }
 *   → { bestmove, san, fen, status, result?, sideToMove, claimableDraws, by }
 *
 * `aggr` (0..100, default 50 = neutral) is gomachine's aggression style; it applies
 * to the gomachine side ONLY (Stockfish never receives it).
 *
 * Repetition history is intentionally omitted (the view is ephemeral); the
 * frontend ends games on checkmate/stalemate/fifty-move + a hard ply cap.
 */
class EngineMatchController extends Controller
{
    public string $fen = '';

    public string $side = 'gomachine';

    public int $rating = 1500;

    public int $elo = 1500;

    public int $movetime = 100;

    public int $aggr = 50;

    public function __construct(private readonly GomachineClient $engine)
    {
    }

    public function post(): JsonResponse
    {
        $user = $this->request->user;
        if (!is_array($user) || ($user['role'] ?? '') !== 'admin') {
            return JsonResponse::error('admin only', 403);
        }

        $this->validate([
            'fen' => 'required|string',
            'side' => 'in:gomachine,stockfish',
            'aggr' => 'integer|min:0|max:100',
        ]);

        $movetime = max(20, min(5000, $this->movetime)); // clamp the budget
        if ($this->side === 'stockfish') {
            // Stockfish never receives the aggression knob — it's a gomachine-only style.
            $best = $this->engine->stockfishMove($this->fen, $this->elo, $movetime);
        } else {
            $aggr = max(0, min(100, $this->aggr)); // clamp; 50 = neutral (engine is byte-identical)
            $best = $this->engine->bestMove($this->fen, $this->rating, [], $movetime, $aggr);
        }

        $uci = $best['bestmove'] ?? null;
        if (!is_string($uci) || $uci === '') {
            return JsonResponse::ok(['bestmove' => null, 'reason' => 'no move (game over?)']);
        }

        $applied = $this->engine->move($this->fen, $uci);
        if (empty($applied['legal'])) {
            return JsonResponse::ok(['bestmove' => null, 'reason' => 'engine returned an illegal move']);
        }

        return JsonResponse::ok([
            'bestmove' => $uci,
            'san' => $applied['san'] ?? ($best['san'] ?? null),
            'fen' => $applied['newFen'] ?? null,
            'status' => $applied['status'] ?? 'ongoing',
            'result' => $applied['result'] ?? null,
            'sideToMove' => $applied['sideToMove'] ?? null,
            'claimableDraws' => $applied['claimableDraws'] ?? [],
            'eval' => $best['eval'] ?? null,
            'by' => $this->side,
        ]);
    }
}
