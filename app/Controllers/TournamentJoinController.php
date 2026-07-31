<?php

namespace App\Controllers;

use BaseApi\Controllers\Controller;
use BaseApi\Http\JsonResponse;
use App\Models\Tournament;
use App\Models\TournamentPlayer;
use App\Models\User;
use App\Services\Glicko2Service;

/**
 *   POST /tournaments/{id}/join
 *
 * Idempotent: joining twice is a no-op (and re-joining after a withdrawal
 * clears `withdrawn` on the same row rather than inserting a second one — the
 * unique (tournament_id, user_id) index on {@see TournamentPlayer} makes that
 * the only safe shape). Requires auth (guests have no account to score
 * against); a finished tournament can no longer be joined.
 *
 * Entry restrictions (`min_rating`/`max_rating`/`titled_only`) are checked
 * against the tournament's own rating category (see
 * {@see Tournament::ratingCategory()}) — e.g. a Duck Chess tournament checks
 * `rating_duck`, a "3+0" standard one checks `rating_blitz`.
 */
class TournamentJoinController extends Controller
{
    /** Bound from path {id}. */
    public string $id = '';

    public function __construct(
        private readonly Glicko2Service $glicko,
    ) {
    }

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

        if ($tournament->min_rating !== null || $tournament->max_rating !== null || $tournament->titled_only) {
            $user = User::find($me);
            if (!$user instanceof User) {
                return JsonResponse::unauthorized();
            }

            if ($tournament->titled_only && $user->displayTitle() === null) {
                return JsonResponse::badRequest('this tournament is titled players only');
            }

            $category = $tournament->ratingCategory($this->glicko);
            $rating = (int) $user->{'rating_' . $category};

            if ($tournament->min_rating !== null && $rating < $tournament->min_rating) {
                return JsonResponse::badRequest(sprintf(
                    'this tournament requires a %s rating of at least %d (yours is %d)',
                    $category,
                    $tournament->min_rating,
                    $rating,
                ));
            }

            if ($tournament->max_rating !== null && $rating > $tournament->max_rating) {
                return JsonResponse::badRequest(sprintf(
                    'this tournament requires a %s rating of at most %d (yours is %d)',
                    $category,
                    $tournament->max_rating,
                    $rating,
                ));
            }
        }

        // NOT firstWhereConditions(['tournament_id' => ..., 'user_id' => ...]) —
        // that helper expects a LIST of {column,operator,value} arrays, not a
        // flat column=>value map; passed a flat map it throws. Chained
        // where()->first() is the form the rest of this codebase uses safely.
        $player = TournamentPlayer::query()
            ->where('tournament_id', '=', $tournament->id)
            ->where('user_id', '=', $me)
            ->first();

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
