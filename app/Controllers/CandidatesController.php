<?php

namespace App\Controllers;

use BaseApi\Controllers\Controller;
use BaseApi\Http\JsonResponse;
use App\Services\GomachineClient;

/**
 * Opening explorer for the analysis board (SPEC §6). The engine owns ALL of the
 * chess knowledge here — opening NAMING (its native-Zobrist opening table) and a
 * full-strength MultiPV eval for every legal move — so this controller is a thin,
 * validated passthrough.
 *
 *   POST /candidates { fen: "<FEN>", history?: ["<FEN>"...], multipv?, movetime?, depth? }
 *   → { opening: {eco,name}|null, moves: [{uci, san, eval:{type,value}, pv, depth}] }
 *
 * `history` is the prior-position FENs (root→previous), so the engine resolves the
 * DEEPEST named opening along the line (the Lichess rule), not just the current
 * position. `moves` is ranked best-first; each carries a side-to-move-relative
 * eval the UI renders as a per-move eval bar.
 */
class CandidatesController extends Controller
{
    public string $fen = '';

    public int $multipv = 0;

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

        // history is an array param — read it from the raw body (scalar property
        // binding doesn't cover arrays). Coerce to a clean list of FEN strings.
        $body = $this->request->body ?? [];
        $history = array_values(array_map('strval', (array) ($body['history'] ?? [])));

        $multipv = $this->multipv > 0 ? min(12, $this->multipv) : 0;
        $movetime = $this->movetime > 0 ? max(50, min(2000, $this->movetime)) : 300;
        $depth = $this->depth > 0 ? max(1, min(30, $this->depth)) : 0;

        $res = $this->engine->candidates($this->fen, $history, $multipv, $movetime, $depth);

        return JsonResponse::ok([
            'opening' => $res['opening'] ?? null,
            'moves' => $res['moves'] ?? [],
        ]);
    }
}
