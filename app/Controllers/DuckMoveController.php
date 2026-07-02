<?php

namespace App\Controllers;

use BaseApi\Controllers\Controller;
use BaseApi\Http\JsonResponse;
use App\Services\GomachineClient;
use RuntimeException;

/**
 * Duck Chess move validation + application for the analysis board's free-play
 * mode (SPEC §6). Stateless, PUBLIC, no persisted game: takes a FEN + current
 * duck square + a composite `"<pieceUCI>:<duckSquare>"` move and returns the
 * resulting position.
 *
 *   POST /duck/move { fen: "<FEN>", duck?: "<square>", move: "e2e4:a6" }
 *   → { legal, error?, newFen, duck, san, sideToMove, status, result, moves }
 *
 * The composite move packs the piece move and the duck's new square (e.g.
 * "e2e4:e5", "e7e8q:h6"), hence the max:8 length — the engine validates legality.
 * On a legal move that leaves the game ONGOING, the next position's legal piece
 * moves are included as `moves` so the client can keep playing without a second
 * round-trip. An illegal move returns 400 with `{legal:false, error}`.
 */
class DuckMoveController extends Controller
{
    public string $fen = '';

    public string $duck = '';

    public string $move = '';

    public function __construct(private readonly GomachineClient $engine)
    {
    }

    public function post(): JsonResponse
    {
        $this->validate([
            'fen' => 'required|string',
            'move' => 'required|string|max:8',
        ]);

        try {
            $res = $this->engine->duckMove($this->fen, $this->duck, $this->move);
        } catch (RuntimeException $e) {
            return JsonResponse::error('engine error: ' . $e->getMessage(), 502);
        }

        if (!($res['legal'] ?? false)) {
            return JsonResponse::badRequest($res['error'] ?? 'illegal move');
        }

        $newFen = (string) ($res['newFen'] ?? '');
        $newDuck = (string) ($res['duck'] ?? '');
        $status = (string) ($res['status'] ?? '');

        // On a legal, still-ongoing position, hand the client the next position's
        // legal piece moves so it can keep playing without a second round-trip.
        $moves = [];
        if ($status === 'ongoing' && $newFen !== '') {
            try {
                $next = $this->engine->duckLegalMoves($newFen, $newDuck);
                $moves = $next['moves'] ?? [];
            } catch (RuntimeException $e) {
                return JsonResponse::error('engine error: ' . $e->getMessage(), 502);
            }
        }

        return JsonResponse::ok([
            'legal' => true,
            'newFen' => $newFen,
            'duck' => $newDuck,
            'san' => $res['san'] ?? '',
            'sideToMove' => $res['sideToMove'] ?? '',
            'status' => $status,
            'result' => $res['result'] ?? null,
            'moves' => $moves,
        ]);
    }
}
