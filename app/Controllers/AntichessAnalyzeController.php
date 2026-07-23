<?php

namespace App\Controllers;

use BaseApi\Controllers\Controller;
use BaseApi\Http\JsonResponse;
use App\Services\EngineSelector;
use RuntimeException;

/**
 * Full-strength Antichess (Losing Chess / Räuberschach) analysis for the admin
 * best-move readout and the analysis board's free-play mode. Stateless, PUBLIC,
 * no persisted game: takes a FEN and returns the antichess engine's best LEGAL
 * move + evaluation, at full power by default.
 *
 *   POST /antichess/analyze { fen: "<FEN>", movetime?: <ms>, rating?: <elo>,
 *                             depth?: <plies>, nodes?: <count> }
 *   → { eval: {type:"cp"|"mate", value}|null, bestmove, bestSan, sideToMove }
 *
 * Why a dedicated route (not the standard /analyze): the standard engine plays
 * by standard rules, so for an antichess position its "best move" is frequently
 * ILLEGAL (it ignores the compulsory-capture rule) and, even when legal, points
 * the wrong way (antichess material is inverted). This routes to the antichess
 * engine instead, exactly as /duck/analyze does for Duck.
 *
 * `rating` 0 (the default) = no cap: the engine treats a missing rating as full
 * strength. A positive rating caps strength (used by the admin engine-vs-engine
 * watch view); with none set the search is full strength for `movetime` 250ms.
 */
class AntichessAnalyzeController extends Controller
{
    public string $fen = '';

    public int $movetime = 0;

    public int $rating = 0;

    public int $depth = 0;

    public int $nodes = 0;

    public function __construct(private readonly EngineSelector $engine)
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
            // rating 0 => omit the rating cap => full-strength (clean) search.
            $res = $this->engine->antichessBestMove($this->fen, $rating, $movetime, $depth, $nodes);
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
