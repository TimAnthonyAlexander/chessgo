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

    public function __construct(private readonly GomachineClient $engine)
    {
    }

    public function post(): JsonResponse
    {
        $this->validate([
            'fen' => 'required|string',
        ]);

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
}
