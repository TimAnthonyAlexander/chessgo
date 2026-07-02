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
 *     { fen, side: "gomachine"|"stockfish", rating?, elo?, movetime?, nodes?,
 *       depth?, aggr?, book? }
 *   → { bestmove, san, fen, status, result?, sideToMove, claimableDraws, by }
 *
 * `aggr` (0..100, default 50 = neutral) is gomachine's aggression style; it applies
 * to the gomachine side ONLY (Stockfish never receives it). `book` (gomachine only)
 * consults the opening book on the rating path.
 *
 * The search budget is pinned to EXACTLY ONE dimension per side: gomachine accepts
 * movetime / nodes / depth (depth→nodes→movetime precedence); Stockfish accepts
 * movetime / depth (depth wins). The frontend sends only the active one.
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

    public int $nodes = 0;

    public int $depth = 0;

    public int $aggr = 50;

    public bool $book = false;

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
            'nodes' => 'integer|min:0',
            'depth' => 'integer|min:0',
        ]);

        $depth = max(0, min(60, $this->depth));  // fixed-depth budget (both engines)
        $nodes = max(0, $this->nodes);           // fixed-nodes budget (gomachine only)
        // Movetime only binds when neither depth nor nodes is the active limit; clamp
        // it to a sane watch range then.
        $movetime = max(20, min(5000, $this->movetime));

        if ($this->side === 'stockfish') {
            // Stockfish never receives the aggression/nodes/book knobs. Depth wins over
            // movetime when set.
            $mt = $depth > 0 ? 0 : $movetime;
            $best = $this->engine->stockfishMove($this->fen, $this->elo, $mt, $depth);
        } else {
            $aggr = max(0, min(100, $this->aggr)); // clamp; 50 = neutral (engine is byte-identical)
            // Send only the active budget dimension (the engine applies
            // depth→nodes→movetime precedence, but keep it unambiguous).
            $mt = ($depth > 0 || $nodes > 0) ? 0 : $movetime;
            $best = $this->engine->bestMove(
                $this->fen,
                $this->rating,
                [],
                $mt,
                $aggr,
                $nodes,
                $depth,
                $this->book,
            );
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
