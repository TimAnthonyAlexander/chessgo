<?php

namespace App\Controllers;

use BaseApi\Controllers\Controller;
use BaseApi\Http\JsonResponse;
use App\Services\GomachineClient;
use RuntimeException;

/**
 * Duck Chess legal piece moves for the analysis board's free-play mode (SPEC §6).
 * Stateless, PUBLIC, no persisted game: takes a FEN + current duck square and
 * returns the legal PIECE moves (UCI long algebraic). The duck placement that
 * follows each piece move is chosen when the move is submitted.
 *
 *   POST /duck/legal-moves { fen: "<FEN>", duck?: "<square>" }
 *   → { moves: ["e2e4", ...] }
 *
 * `duck` is the current duck square ("" / omitted if not yet placed). Duck Chess
 * has no check, so king-captures are included and no check filter is applied —
 * the engine owns all of that.
 */
class DuckLegalMovesController extends Controller
{
    public string $fen = '';

    public string $duck = '';

    public function __construct(private readonly GomachineClient $engine)
    {
    }

    public function post(): JsonResponse
    {
        $this->validate([
            'fen' => 'required|string',
        ]);

        try {
            $res = $this->engine->duckLegalMoves($this->fen, $this->duck);
        } catch (RuntimeException $e) {
            return JsonResponse::error('engine error: ' . $e->getMessage(), 502);
        }

        return JsonResponse::ok([
            'moves' => $res['moves'] ?? [],
        ]);
    }
}
