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
 *   POST /duck/analyze { fen: "<FEN>", duck?: "<square>", movetime?: <ms>,
 *                        rating?: <elo>, depth?: <plies>, nodes?: <count> }
 *   → { eval: {type:"cp"|"mate", value}|null, bestmove, bestSan, sideToMove }
 *
 * `bestmove` is the composite `"<pieceUCI>:<duckSquare>"` the engine would play.
 * All strength/budget knobs are optional — with none set the search is full
 * strength for `movetime` 250ms (the free-mode analysis board's behaviour, kept
 * byte-identical). The admin engine-vs-engine (Duck mode) view drives per-side
 * strength through `rating` (>0 caps it) plus exactly one of `depth`/`nodes`/
 * `movetime` (depth→nodes→movetime precedence).
 */
class DuckAnalyzeController extends Controller
{
    public string $fen = '';

    public string $duck = '';

    public int $movetime = 0;

    public int $rating = 0;

    public int $depth = 0;

    public int $nodes = 0;

    public function __construct(private readonly GomachineClient $engine)
    {
    }

    public function post(): JsonResponse
    {
        $this->validate([
            'fen' => 'required|string',
            'rating' => 'integer|min:0',
            'depth' => 'integer|min:0',
            'nodes' => 'integer|min:0',
        ]);

        $movetime = $this->movetime > 0 ? max(50, min(2000, $this->movetime)) : 250;
        $rating = max(0, $this->rating);
        $depth = max(0, $this->depth);
        $nodes = max(0, $this->nodes);

        try {
            // No rating (0) = full strength (the engine treats a missing Rating as
            // "no cap"); a positive rating caps strength for the Duck-mode watch view.
            $res = $this->engine->duckBestMove($this->fen, $this->duck, $rating, $movetime, $depth, $nodes);
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
