<?php

namespace App\Controllers;

use BaseApi\Controllers\Controller;
use BaseApi\Http\JsonResponse;
use App\Models\Tournament;
use App\Models\TournamentPlayer;

/**
 *   POST /tournaments/{id}/join
 *
 * Idempotent: joining twice is a no-op (and re-joining after a withdrawal
 * clears `withdrawn` on the same row rather than inserting a second one — the
 * unique (tournament_id, user_id) index on {@see TournamentPlayer} makes that
 * the only safe shape). Requires auth (guests have no account to score
 * against); a finished tournament can no longer be joined.
 */
class TournamentJoinController extends Controller
{
    /** Bound from path {id}. */
    public string $id = '';

    public function post(): JsonResponse
    {
        $me = $this->authedUserId();
        if ($me === null) {
            return JsonResponse::unauthorized();
        }

        $tournament = Tournament::find($this->id);
        if (!$tournament instanceof Tournament) {
            return JsonResponse::notFound('tournament not found');
        }

        $tournament->reconcileStatus();
        if ($tournament->status === 'finished') {
            return JsonResponse::badRequest('tournament has already finished');
        }

        $player = TournamentPlayer::firstWhereConditions([
            'tournament_id' => $tournament->id,
            'user_id' => $me,
        ]);

        if ($player instanceof TournamentPlayer) {
            if ($player->withdrawn) {
                $player->withdrawn = false;
                $player->save();
            }

            return JsonResponse::ok(['joined' => true]);
        }

        $player = new TournamentPlayer();
        $player->tournament_id = $tournament->id;
        $player->user_id = $me;
        $player->score = 0;
        $player->games = 0;
        $player->streak = 0;
        $player->withdrawn = false;

        if (!$player->save()) {
            return JsonResponse::error('failed to join tournament', 500);
        }

        return JsonResponse::created(['joined' => true]);
    }

    private function authedUserId(): ?string
    {
        $user = $this->request->user;
        $id = $user['id'] ?? null;

        return is_string($id) && $id !== '' ? $id : null;
    }
}
