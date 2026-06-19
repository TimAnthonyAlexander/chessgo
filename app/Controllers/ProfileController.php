<?php

namespace App\Controllers;

use BaseApi\Controllers\Controller;
use BaseApi\Http\JsonResponse;
use App\Models\Game;
use App\Models\PuzzleAttempt;
use App\Models\User;
use App\Services\Glicko2Service;

/**
 * Public player profile, keyed by display name (the natural key the UI holds —
 * games store names, the nav shows the name). Anonymous-accessible: a finished
 * account's ratings + record are not secret. Email + password are never exposed.
 *
 *   GET /users/{name}
 *
 * Returns the account's per-category ratings (rating/RD/games/provisional), the
 * isolated puzzle rating + solved count, an overall win/loss/draw record across
 * all persisted games, and the most recent games as light rows (no move blobs —
 * the board opens them via the analysis endpoint). Game pagination lives on the
 * sibling {@see ProfileGamesController} ("load more").
 */
class ProfileController extends Controller
{
    /** How many recent games to embed in the first profile payload. */
    private const RECENT_GAMES = 30;

    /** Bound from path {name}. */
    public string $name = '';

    public function get(): JsonResponse
    {
        $name = trim($this->name);
        if ($name === '') {
            return JsonResponse::badRequest('name is required');
        }

        $user = User::firstWhere('name', '=', $name);
        if (!$user instanceof User) {
            return JsonResponse::notFound('user not found');
        }

        $id = $user->id;

        $games = Game::query()
            ->where('white_user_id', '=', $id)
            ->orWhere('black_user_id', '=', $id)
            ->orderByDesc('created_at')
            ->limit(self::RECENT_GAMES + 1) // +1 to know if there's a next page
            ->get();
        $hasMore = count($games) > self::RECENT_GAMES;
        $rows = array_map(
            static fn (Game $g): array => $g->summaryRow(),
            array_slice($games, 0, self::RECENT_GAMES),
        );

        $puzzleSolved = PuzzleAttempt::query()
            ->where('user_id', '=', $id)
            ->where('solved', '=', true)
            ->count();

        return JsonResponse::ok([
            'id' => $id,
            'name' => $user->name,
            'role' => $user->role,
            'created_at' => $user->created_at,
            'ratings' => $this->ratings($user),
            'puzzle' => [
                'rating' => $user->rating_puzzle,
                'rd' => $user->rd_puzzle,
                'games' => $user->games_puzzle,
                'solved' => $puzzleSolved,
                'provisional' => ((float) $user->rd_puzzle) > Glicko2Service::PROVISIONAL_RD,
            ],
            'record' => $this->record($id),
            'games' => $rows,
            'hasMore' => $hasMore,
        ]);
    }

    /**
     * Per-time-control rating tiles (display-only — RD drives the provisional "?").
     *
     * @return array<string, array<string, mixed>>
     */
    private function ratings(User $user): array
    {
        $out = [];
        foreach (['bullet', 'blitz', 'rapid', 'classical'] as $cat) {
            $rd = (float) $user->{'rd_' . $cat};
            $out[$cat] = [
                'rating' => $user->{'rating_' . $cat},
                'rd' => $rd,
                'games' => $user->{'games_' . $cat},
                'provisional' => $rd > Glicko2Service::PROVISIONAL_RD,
                'rated_at' => $user->{'rated_at_' . $cat},
            ];
        }

        return $out;
    }

    /**
     * Win/loss/draw across every persisted game the account played, from the
     * account's own perspective (a 1-0 is a win as White, a loss as Black).
     * Computed with count queries so the move/analysis blobs are never loaded.
     *
     * @return array<string, int>
     */
    private function record(string $id): array
    {
        $count = static fn (string $color, string $result): int => Game::query()
            ->where($color . '_user_id', '=', $id)
            ->where('result', '=', $result)
            ->count();

        $wins = $count('white', '1-0') + $count('black', '0-1');
        $losses = $count('white', '0-1') + $count('black', '1-0');
        $draws = $count('white', '1/2-1/2') + $count('black', '1/2-1/2');

        return [
            'wins' => $wins,
            'losses' => $losses,
            'draws' => $draws,
            'total' => $wins + $losses + $draws,
        ];
    }
}
