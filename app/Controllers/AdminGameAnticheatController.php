<?php

namespace App\Controllers;

use BaseApi\Controllers\Controller;
use BaseApi\Http\JsonResponse;
use App\Controllers\Concerns\AdminGuard;
use App\Models\Game;
use App\Models\UserFlag;

/**
 * Admin-only per-game anti-cheat telemetry (Wave 1). Surfaces exactly the fields
 * the public Game::jsonSerialize() strips — the per-move think times and the
 * cached engine analysis summary — plus any flag events tied to this game. This
 * is intentionally admin-gated ({@see AdminGuard}); none of it is client-facing.
 *
 *   GET /admin/games/{id}/anticheat        ({id} = hub_game_id)
 *
 * Reads only what the game already has: move_times as captured by the hub, and
 * the analysis summary from the game's cached blob (getAnalysis()) — it never
 * triggers a fresh engine pass. Missing telemetry degrades to [] / null rather
 * than erroring. Flag events are matched by decoded UserFlag.meta.game_id ==
 * hub_game_id, scoped to the two sides' accounts so it never scans the table.
 */
class AdminGameAnticheatController extends Controller
{
    use AdminGuard;

    /** Bound from path {id} — the hub game id. */
    public string $id = '';

    public function get(): JsonResponse
    {
        if ($denied = $this->requireAdmin($this->request)) {
            return $denied;
        }
        if ($this->id === '') {
            return JsonResponse::badRequest('game id is required');
        }

        $game = Game::firstWhere('hub_game_id', '=', $this->id);
        if (!$game instanceof Game) {
            return JsonResponse::notFound('game not found');
        }

        $cached = $game->getAnalysis();
        $summary = is_array($cached) && isset($cached['summary']) && is_array($cached['summary'])
            ? $cached['summary']
            : null;

        return JsonResponse::ok([
            'game' => Game::summaryRowsWithTitles([$game])[0],
            'move_times' => $game->getMoveTimes(),
            'ac_scanned' => $game->ac_scanned,
            'analysis_summary' => $summary,
            'flags_for_game' => $this->flagsForGame($game),
        ]);
    }

    /**
     * Flag events whose meta.game_id matches this game, restricted to the two
     * sides' registered accounts (a UserFlag always belongs to a user, and a
     * game's flags can only come from its two players).
     *
     * @return list<array<string, mixed>>
     */
    private function flagsForGame(Game $game): array
    {
        $userIds = array_values(array_filter(
            [$game->white_user_id, $game->black_user_id],
            static fn (?string $v): bool => $v !== null && $v !== '',
        ));
        if ($userIds === []) {
            return [];
        }

        $events = UserFlag::query()
            ->whereIn('user_id', $userIds)
            ->orderByDesc('created_at')
            ->get();

        $out = [];
        foreach ($events as $event) {
            $meta = $event->getMeta();
            if (($meta['game_id'] ?? null) !== $game->hub_game_id) {
                continue;
            }
            $out[] = [
                'id' => $event->id,
                'user_id' => $event->user_id,
                'category' => $event->category,
                'severity' => $event->severity,
                'detail' => $event->detail,
                'meta' => $meta,
                'reviewed' => $event->reviewed,
                'created_at' => $event->created_at,
            ];
        }

        return $out;
    }
}
