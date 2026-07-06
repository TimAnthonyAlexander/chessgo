<?php

namespace App\Controllers;

use BaseApi\Controllers\Controller;
use BaseApi\Http\JsonResponse;
use App\Services\GuessGameService;
use RuntimeException;

/**
 * "Guess the Elo" — generate a new round (SPEC §Guess the Elo). Public/guest.
 *
 *   POST /guess-the-elo → { id, startFen, result, status, moves: [{ply,uci,san,fen}] }
 *
 * The server plays a full gomachine-vs-itself game at a SECRET target Elo and
 * returns ONLY the moves (never the rating). The client watches it, then submits
 * a guess to POST /guess-the-elo/{id}/guess for the reveal. Presented to the user
 * as "loading a random game" — the generation + hidden rating stay server-side.
 *
 * Session is OPTIONAL (SessionStartMiddleware): a signed-in player is recorded as
 * the round's owner; anonymous callers still play.
 */
class GuessGameController extends Controller
{
    /** Standard start position, echoed so the client can render ply 0. */
    private const START_FEN = 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1';

    public function __construct(private readonly GuessGameService $games)
    {
    }

    public function post(): JsonResponse
    {
        $uid = null;
        $u = $this->request->user ?? null;
        if (is_array($u) && !empty($u['id'])) {
            $uid = (string) $u['id'];
        }

        try {
            $game = $this->games->generate($uid);
        } catch (RuntimeException) {
            return JsonResponse::error('could not generate a game — engine unavailable', 503);
        }

        // Explicit payload — the model's `rating` is the answer and must NOT ship.
        return JsonResponse::created([
            'id' => $game->id,
            'startFen' => self::START_FEN,
            'result' => $game->result,
            'status' => $game->status,
            'moves' => $game->getMoves(),
        ]);
    }
}
