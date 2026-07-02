<?php

namespace App\Controllers;

use BaseApi\Controllers\Controller;
use BaseApi\Http\JsonResponse;
use App\Services\GomachineClient;
use RuntimeException;

/**
 * Full-strength Duck Chess analysis for the analysis board's free-play mode
 * (SPEC §6). Stateless, PUBLIC, no persisted game: takes a FEN + current duck
 * square and returns the duck engine's best composite move + evaluation, always
 * at full power (rating 0 = no cap).
 *
 *   POST /duck/analyze { fen: "<FEN>", duck?: "<square>", movetime?: <ms> }
 *   → { eval: {type:"cp"|"mate", value}|null, bestmove, bestSan, sideToMove }
 *
 * `bestmove` is the composite `"<pieceUCI>:<duckSquare>"` the engine would play.
 * `movetime` (optional) is the per-move search budget in ms (default 250).
 */
class DuckAnalyzeController extends Controller
{
    public string $fen = '';

    public string $duck = '';

    public int $movetime = 0;

    public function __construct(private readonly GomachineClient $engine)
    {
    }

    public function post(): JsonResponse
    {
        $this->validate([
            'fen' => 'required|string',
        ]);

        $movetime = $this->movetime > 0 ? max(50, min(2000, $this->movetime)) : 250;

        try {
            // rating 0 = full strength (the engine treats Rating<=0 as "no cap").
            $res = $this->engine->duckBestMove($this->fen, $this->duck, 0, $movetime);
        } catch (RuntimeException $e) {
            return JsonResponse::error('engine error: ' . $e->getMessage(), 502);
        }

        return JsonResponse::ok([
            'eval' => $res['eval'] ?? null,
            'bestmove' => $res['bestmove'] ?? null,
            'bestSan' => $res['san'] ?? null,
            'sideToMove' => $res['sideToMove'] ?? '',
        ]);
    }
}
