<?php

namespace App\Controllers;

use BaseApi\Controllers\Controller;
use BaseApi\Http\JsonResponse;
use App\Models\Game;
use App\Models\User;

/**
 * Paginated game history for a profile ("load more" below the embedded first
 * page from {@see ProfileController}). Light rows only — the board fetches a
 * single game's moves/analysis on demand when one is opened.
 *
 *   GET /users/{name}/games?offset=<n>
 */
class ProfileGamesController extends Controller
{
    /** Page size — also the hard cap on what one request can return. */
    private const PER_PAGE = 30;

    /** Bound from path {name}. */
    public string $name = '';

    /** Bound from ?offset= (rows to skip). Clamped to >= 0. */
    public int $offset = 0;

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

        $offset = max(0, $this->offset);

        $games = Game::query()
            ->where('white_user_id', '=', $user->id)
            ->orWhere('black_user_id', '=', $user->id)
            ->orderByDesc('created_at')
            ->limit(self::PER_PAGE + 1) // +1 sentinel to detect a further page
            ->offset($offset)
            ->get();

        $hasMore = count($games) > self::PER_PAGE;
        $rows = array_map(
            static fn (Game $g): array => $g->summaryRow(),
            array_slice($games, 0, self::PER_PAGE),
        );

        return JsonResponse::ok([
            'games' => $rows,
            'offset' => $offset,
            'hasMore' => $hasMore,
        ]);
    }
}
