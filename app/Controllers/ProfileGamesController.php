<?php

namespace App\Controllers;

use BaseApi\Controllers\Controller;
use BaseApi\Http\JsonResponse;
use App\Models\Game;
use App\Models\User;

/**
 * One page of a profile's game history (numbered pagination below the embedded
 * first page from {@see ProfileController}). Light rows only — the board fetches
 * a single game's moves/analysis on demand when one is opened.
 *
 * Filtering is server-side (so it spans the whole history, not just the page):
 *   GET /users/{name}/games?page=<n>&category=<pool>&result=<win|loss|draw>
 *
 * `category` is a stored value (bullet|blitz|rapid|classical|duck — Chess960
 * games keep their time-control category). `result` is from the profiled
 * player's own perspective, so it depends on which colour they played.
 */
class ProfileGamesController extends Controller
{
    /** Page size — also the hard cap on what one request can return. */
    private const PER_PAGE = 10;

    private const CATEGORIES = ['bullet', 'blitz', 'rapid', 'classical', 'duck', 'antichess'];

    /** Bound from path {name}. */
    public string $name = '';

    /** Bound from ?page= (1-based). Clamped to >= 1. */
    public int $page = 1;

    /** Bound from ?category= — a stored category value, or '' for all. */
    public string $category = '';

    /** Bound from ?result= — 'win' | 'loss' | 'draw', or '' for all. */
    public string $result = '';

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
        $query = Game::query();

        // Base predicate: the profiled player is one of the two sides. Grouped so
        // it stays intact when the filters below AND further conditions on.
        $query->whereGroup(function ($g) use ($id): void {
            $g->where('white_user_id', '=', $id)->orWhere('black_user_id', '=', $id);
        });

        // Category / pool filter (Duck is stored as its own category value).
        if (in_array($this->category, self::CATEGORIES, true)) {
            $query->where('category', '=', $this->category);
        }

        // Result filter, from the player's perspective (a 1-0 is a win as White,
        // a loss as Black). Draws are colour-independent.
        if ($this->result === 'win' || $this->result === 'loss') {
            $whiteResult = $this->result === 'win' ? '1-0' : '0-1';
            $blackResult = $this->result === 'win' ? '0-1' : '1-0';
            $query->whereGroup(function ($g) use ($id, $whiteResult, $blackResult): void {
                $g->whereGroup(
                    fn ($x) => $x->where('white_user_id', '=', $id)
                        ->where('result', '=', $whiteResult),
                )->orWhereGroup(
                    fn ($x) => $x->where('black_user_id', '=', $id)
                        ->where('result', '=', $blackResult),
                );
            });
        } elseif ($this->result === 'draw') {
            $query->where('result', '=', '1/2-1/2');
        }

        $paged = $query
            ->orderByDesc('created_at')
            ->paginate(max(1, $this->page), self::PER_PAGE, self::PER_PAGE, withTotal: true);

        $rows = array_map(
            static fn (Game $g): array => $g->summaryRow(),
            $paged->data,
        );

        return JsonResponse::ok([
            'games' => $rows,
            'page' => $paged->page,
            'perPage' => $paged->perPage,
            'total' => $paged->total,
        ]);
    }
}
