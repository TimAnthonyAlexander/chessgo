<?php

namespace App\Controllers;

use BaseApi\Controllers\Controller;
use BaseApi\Http\JsonResponse;
use App\Models\Tournament;
use App\Models\TournamentPlayer;

/**
 *   POST /tournaments/{id}/withdraw
 *
 * Sets `withdrawn` on the caller's standing row (the hub's active-arenas feed
 * filters withdrawn players out of pairing). Re-joining via
 * {@see TournamentJoinController} clears it again. A no-op (not an error) if
 * the caller was never a participant.
 */
class TournamentWithdrawController extends Controller
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

        // NOT firstWhereConditions(['tournament_id' => ..., 'user_id' => ...]) —
        // that helper expects a LIST of {column,operator,value} arrays, not a
        // flat column=>value map; passed a flat map it throws. Chained
        // where()->first() is the form the rest of this codebase uses safely.
        $player = TournamentPlayer::query()
            ->where('tournament_id', '=', $tournament->id)
            ->where('user_id', '=', $me)
            ->first();

        if (!$player instanceof TournamentPlayer) {
            return JsonResponse::ok(['withdrawn' => true]);
        }

        if (!$player->withdrawn) {
            $player->withdrawn = true;
            $player->save();
        }

        return JsonResponse::ok(['withdrawn' => true]);
    }

    private function authedUserId(): ?string
    {
        $user = $this->request->user;
        $id = $user['id'] ?? null;

        return is_string($id) && $id !== '' ? $id : null;
    }
}
