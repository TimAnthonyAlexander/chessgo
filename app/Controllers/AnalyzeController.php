<?php

namespace App\Controllers;

use BaseApi\Controllers\Controller;
use BaseApi\Http\JsonResponse;
use App\Services\GomachineClient;

/**
 * Full-strength position analysis for the eval bar (SPEC §6). Stateless: takes a
 * FEN, returns the engine's best move + evaluation at full power, regardless of
 * any game's bot difficulty.
 *
 *   POST /analyze   { fen: "<FEN>", movetime?: <ms> }
 *   → { eval: {type:"cp"|"mate", value}, bestmove, pv: [uci...], depth }
 *
 * `pv` is the principal variation (the engine's predicted best line) as UCI
 * moves from this position, used by the analysis board's engine line. `movetime`
 * (optional, clamped 50..2000ms) lets a caller trade depth for latency — e.g. the
 * engine-vs-engine watch view polls a fast eval every ply; default is full power.
 */
class AnalyzeController extends Controller
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

        $movetime = $this->movetime > 0 ? max(50, min(2000, $this->movetime)) : 1500;
        $res = $this->engine->analyze($this->fen, $movetime);

        return JsonResponse::ok([
            'eval' => $res['eval'] ?? null,
            'bestmove' => $res['bestmove'] ?? null,
            'pv' => $res['pv'] ?? null,
            'depth' => $res['depth'] ?? null,
        ]);
    }
}
