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
 *   POST /analyze   { fen: "<FEN>" }
 *   → { eval: {type:"cp"|"mate", value}, bestmove, depth }
 */
class AnalyzeController extends Controller
{
    public string $fen = '';

    public function __construct(private readonly GomachineClient $engine)
    {
    }

    public function post(): JsonResponse
    {
        $this->validate([
            'fen' => 'required|string',
        ]);

        $res = $this->engine->analyze($this->fen);

        return JsonResponse::ok([
            'eval' => $res['eval'] ?? null,
            'bestmove' => $res['bestmove'] ?? null,
            'depth' => $res['depth'] ?? null,
        ]);
    }
}
