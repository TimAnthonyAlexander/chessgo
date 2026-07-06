<?php

namespace App\Controllers;

use BaseApi\Controllers\Controller;
use BaseApi\Http\JsonResponse;
use App\Controllers\Concerns\AdminGuard;
use App\Models\Game;

/**
 * Admin persisted-game log. Admin-gated via {@see AdminGuard}.
 *
 *   GET /admin/games?page=<n>&filter=<all|bot|human>&category=<pool>
 *
 * A newest-first, paginated view of every persisted {@see Game}. Its purpose is
 * to surface fill-in-bot games: a human vs a backfill bot is persisted (with
 * `rated=false`, one-sided) and carries `white_is_bot`/`black_is_bot`, so the
 * `bot` filter selects any game where either side is a bot. (The Watch spectator
 * engine-vs-engine fillers are `filler=true` and never persisted, so they can't
 * appear here — that is correct.) Rows are the same light {@see Game::summaryRow()}
 * the profile/anti-cheat surfaces use; the board fetches moves/analysis on open.
 */
class AdminGamesController extends Controller
{
    use AdminGuard;

    /** Page size — also the hard cap on what one request can return. */
    private const PER_PAGE = 30;

    /** Recognised bot/human filter values (anything else falls back to 'all'). */
    private const FILTERS = ['all', 'bot', 'human'];

    /** Stored category values a caller may filter by. */
    private const CATEGORIES = ['bullet', 'blitz', 'rapid', 'classical', 'duck'];

    /** ?page= (1-based). Clamped to >= 1. */
    public int $page = 1;

    /** ?filter= — 'all' | 'bot' | 'human'. */
    public string $filter = 'all';

    /** ?category= — a stored category value, or '' for all. */
    public string $category = '';

    public function get(): JsonResponse
    {
        if ($denied = $this->requireAdmin($this->request)) {
            return $denied;
        }

        $filter = in_array($this->filter, self::FILTERS, true) ? $this->filter : 'all';

        $query = Game::query();

        // Bot/human filter. A "bot" game is one where EITHER side is a fill-in bot
        // (grouped-OR so it stays intact if further conditions AND on). "human" is
        // the strict complement: both sides are real players.
        if ($filter === 'bot') {
            $query->whereGroup(function ($g): void {
                $g->where('white_is_bot', '=', true)->orWhere('black_is_bot', '=', true);
            });
        } elseif ($filter === 'human') {
            $query->where('white_is_bot', '=', false)->where('black_is_bot', '=', false);
        }

        // Optional category/pool filter (Duck is stored as its own category value).
        if (in_array($this->category, self::CATEGORIES, true)) {
            $query->where('category', '=', $this->category);
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
