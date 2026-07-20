<?php

namespace App\Controllers;

use BaseApi\Controllers\Controller;
use BaseApi\Http\JsonResponse;
use App\Services\GomachineClient;
use App\Services\ZugzwangClient;

/**
 * Admin-only "engine vs engine" driver. Plays ONE ply — gomachine or zugzwang at
 * a target Elo rating, or Stockfish at a UCI_Elo — applies it, and returns the new
 * state. The frontend alternates sides and loops with a delay so an admin can watch
 * the engines compete. Stateless (FEN-in), like the rest of the engine API.
 *
 *   POST /admin/engine-vs/move
 *     { fen, side: "gomachine"|"zugzwang"|"stockfish", rating?, elo?, movetime?,
 *       nodes?, depth?, aggr?, book? }
 *   → { bestmove, san, fen, status, result?, sideToMove, claimableDraws, by }
 *
 * This controller deliberately bypasses {@see \App\Services\EngineSelector} and
 * holds BOTH concrete clients directly — the whole point of this view is
 * EXPLICIT per-side engine choice (no auto-fallback muddying which engine
 * actually played a move); `by` in the response always reflects `side` truthfully.
 *
 * zugzwang shares gomachine's exact `/bestmove`+`/move` request/response shape
 * (byte-compatible, WIRING_RECON.md §A), so the "zugzwang" branch below is
 * identical to "gomachine" except for which client it calls. zugzwang now
 * spawns its own Stockfish subprocess (`/sf-bestmove`, `zugzwang/src/sf_uci.cpp`)
 * — the "stockfish" side is driven through the zugzwang client.
 *
 * `aggr` (0..100, default 50 = neutral) is gomachine/zugzwang's aggression style;
 * it applies to those sides ONLY (Stockfish never receives it). `book`
 * (gomachine/zugzwang only) consults the opening book on the rating path.
 *
 * The search budget is pinned to EXACTLY ONE dimension per side: gomachine/
 * zugzwang accept movetime / nodes / depth (depth→nodes→movetime precedence);
 * Stockfish accepts movetime / depth (depth wins). The frontend sends only the
 * active one.
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

    public function __construct(
        private readonly GomachineClient $gomachine,
        private readonly ZugzwangClient $zugzwang,
    ) {
    }

    public function post(): JsonResponse
    {
        $user = $this->request->user;
        if (!is_array($user) || ($user['role'] ?? '') !== 'admin') {
            return JsonResponse::error('admin only', 403);
        }

        $this->validate([
            'fen' => 'required|string',
            'side' => 'in:gomachine,zugzwang,stockfish',
            'aggr' => 'integer|min:0|max:100',
            'nodes' => 'integer|min:0',
            'depth' => 'integer|min:0',
        ]);

        $depth = max(0, min(60, $this->depth));  // fixed-depth budget (all engines)
        $nodes = max(0, $this->nodes);           // fixed-nodes budget (gomachine/zugzwang only)
        // Movetime only binds when neither depth nor nodes is the active limit; clamp
        // it to a sane watch range then.
        $movetime = max(20, min(5000, $this->movetime));

        if ($this->side === 'stockfish') {
            // Stockfish is driven exclusively through the zugzwang client, which
            // spawns its own Stockfish subprocess per call. It never receives the
            // aggression/nodes/book knobs; depth wins over movetime when set.
            $mt = $depth > 0 ? 0 : $movetime;
            $best = $this->zugzwang->stockfishMove($this->fen, $this->elo, $mt, $depth);
            $engine = $this->zugzwang;
        } else {
            // gomachine and zugzwang share the identical bestMove()/move() request
            // shape — only which client is called differs.
            $engine = $this->side === 'zugzwang' ? $this->zugzwang : $this->gomachine;
            if ($this->rating <= 0) {
                // "Unlosable" sentinel (rating 0, the slider's lowest stop) — route to
                // the worst-move engine, exactly as BotGameService does for the /bot
                // Unlosable bot. The engine plays the WORST legal move it can find
                // (ignoring aggression / book / search budget), so an Unlosable-vs-
                // Unlosable pairing is two engines racing to hang everything.
                $best = $engine->worstMove($this->fen, []);
            } else {
                $aggr = max(0, min(100, $this->aggr)); // clamp; 50 = neutral (engine is byte-identical)
                // Send only the active budget dimension (the engine applies
                // depth→nodes→movetime precedence, but keep it unambiguous).
                $mt = ($depth > 0 || $nodes > 0) ? 0 : $movetime;
                $best = $engine->bestMove(
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
        }

        $uci = $best['bestmove'] ?? null;
        if (!is_string($uci) || $uci === '') {
            return JsonResponse::ok(['bestmove' => null, 'reason' => 'no move (game over?)']);
        }

        // Apply via the SAME client that computed the move (it just answered, so
        // it's definitely reachable) — never mixes engines within one ply.
        $applied = $engine->move($this->fen, $uci);
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
