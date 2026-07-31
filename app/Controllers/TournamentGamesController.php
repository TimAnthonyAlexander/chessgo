<?php

namespace App\Controllers;

use BaseApi\Controllers\Controller;
use BaseApi\Http\JsonResponse;
use App\Services\HubClient;

/**
 * Live games currently being played inside one Arena tournament — the
 * "Games in progress" section on the tournament detail page. Public, same as
 * the rest of the tournament read endpoints.
 *
 *   GET /tournaments/{id}/games → { games: [{gameId, pool, variant, ply,
 *     white: {name, rating, title}, black: {name, rating, title}}, ...] }
 *
 * Thin proxy over {@see HubClient::arenaGames()} — the hub already shapes,
 * orders (most-interesting first), and caps the list (20). An unreachable hub
 * or an id with no running games both come back as an empty list, never an
 * error, so the tournament page always renders.
 *
 * Bot-ness is deliberately server-side only across this codebase: the hub's
 * row includes a `bot` flag per side, which is stripped here before the
 * response leaves BaseAPI.
 */
class TournamentGamesController extends Controller
{
    /** Bound from path {id}. */
    public string $id = '';

    public function __construct(private readonly HubClient $hub)
    {
    }

    public function get(): JsonResponse
    {
        $id = trim($this->id);
        if ($id === '') {
            return JsonResponse::ok(['games' => []]);
        }

        $games = array_map(
            fn (array $g): array => [
                'gameId' => $g['gameId'] ?? null,
                'pool' => $g['pool'] ?? null,
                'variant' => $g['variant'] ?? null,
                'ply' => $g['ply'] ?? 0,
                'white' => $this->stripBot($g['white'] ?? []),
                'black' => $this->stripBot($g['black'] ?? []),
            ],
            $this->hub->arenaGames($id),
        );

        return JsonResponse::ok(['games' => $games]);
    }

    /**
     * @param array<string, mixed> $side
     * @return array{name: mixed, rating: mixed, title: mixed}
     */
    private function stripBot(array $side): array
    {
        return [
            'name' => $side['name'] ?? null,
            'rating' => $side['rating'] ?? null,
            'title' => $side['title'] ?? null,
        ];
    }
}
