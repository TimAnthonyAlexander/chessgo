<?php

namespace App\Controllers;

use BaseApi\Controllers\Controller;
use BaseApi\Http\JsonResponse;
use App\Services\GomachineClient;

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

    public function __construct(private readonly GomachineClient $engine)
    {
    }

    public function post(): JsonResponse
    {
        $this->validate([
            'fen' => 'required|string',
        ]);

        $movetime = $this->movetime > 0 ? max(50, min(2000, $this->movetime)) : 300;
        // elo 0 → full strength (UCI_LimitStrength stays off in the engine handler).
        $res = $this->engine->stockfishMove($this->fen, 0, $movetime);

        return JsonResponse::ok([
            'bestmove' => $res['bestmove'] ?? null,
            'san' => $res['san'] ?? null,
            'eval' => $res['eval'] ?? null,
        ]);
    }
}
