<?php

namespace App\Controllers;

use BaseApi\App;
use BaseApi\Controllers\Controller;
use BaseApi\Http\JsonResponse;
use App\Models\Tournament;
use App\Models\TournamentPlayer;

/**
 * Internal endpoint the realtime hub polls (every few seconds) to drive Arena
 * pairing. Secret-gated like POST /internal/games and GET /internal/filler-fens
 * — the caller is the hub process, not a browser.
 *
 *   GET /internal/arenas/active   (header X-Hub-Secret: <WS_TICKET_SECRET>)
 *   → {"arenas":[{"id","pool","variant","rated","endsAtMs",
 *                 "players":[{"sub","score","withdrawn"}, ...]}, ...]}
 *
 * Only tournaments that are currently running (started, not yet ended) are
 * included. Deliberately does NOT call {@see Tournament::reconcileStatus()} —
 * that writes on every read, and this route is polled constantly; the
 * candidate filter below (status != 'finished' AND starts_at <= now) plus an
 * in-PHP `isRunning()` check gets the same correctness without a write per
 * poll. Every joined player is included with their current score — the hub,
 * not this endpoint, filters withdrawn players out of pairing.
 */
class ArenaInternalController extends Controller
{
    public function get(): JsonResponse
    {
        if (!$this->authorized()) {
            return JsonResponse::unauthorized('bad hub secret');
        }

        $candidates = Tournament::query()
            ->where('status', '!=', 'finished')
            ->where('starts_at', '<=', date('Y-m-d H:i:s'))
            ->get();

        /** @var list<Tournament> $running */
        $running = array_values(array_filter(
            $candidates,
            static fn (Tournament $t): bool => $t->isRunning(),
        ));

        if ($running === []) {
            return JsonResponse::ok(['arenas' => []]);
        }

        $ids = array_map(static fn (Tournament $t): string => (string) $t->id, $running);
        $playersByTournament = [];
        foreach (TournamentPlayer::query()->whereIn('tournament_id', $ids)->get() as $p) {
            $playersByTournament[$p->tournament_id][] = [
                'sub' => $p->user_id,
                'score' => $p->score,
                'withdrawn' => $p->withdrawn,
            ];
        }

        $arenas = array_map(static fn (Tournament $t): array => [
            'id' => $t->id,
            'pool' => $t->pool,
            'variant' => $t->variant,
            'rated' => $t->rated,
            'endsAtMs' => $t->endsAtMs(),
            'players' => $playersByTournament[$t->id] ?? [],
        ], $running);

        return JsonResponse::ok(['arenas' => $arenas]);
    }

    private function authorized(): bool
    {
        $secret = (string) (App::config('gomachine.ws_ticket_secret') ?? '');
        if ($secret === '') {
            return false;
        }

        $provided = '';
        foreach ($this->request->headers ?? [] as $k => $v) {
            if (strcasecmp((string)$k, 'X-Hub-Secret') === 0) {
                $provided = is_array($v) ? (string)reset($v) : (string)$v;
                break;
            }
        }

        return $provided !== '' && hash_equals($secret, $provided);
    }
}
