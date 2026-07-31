<?php

namespace App\Controllers;

use BaseApi\App;
use BaseApi\Controllers\Controller;
use BaseApi\Http\JsonResponse;
use App\Controllers\Concerns\AdminGuard;
use App\Models\Tournament;
use App\Models\TournamentPlayer;
use App\Models\User;

/**
 * Arena tournaments (Lichess-style).
 *
 *   GET  /tournaments        (public) upcoming + running + recently-finished list
 *   POST /tournaments        (admin only) create one
 *   GET  /tournaments/{id}   (public) info + standings
 *
 * Join/withdraw live on {@see TournamentJoinController} /
 * {@see TournamentWithdrawController}. The hub's pairing feed is
 * {@see ArenaInternalController} (secret-gated, not this class).
 *
 * `status` is never cron-flipped — every read here calls
 * {@see Tournament::reconcileStatus()} first, deriving scheduled/running/
 * finished from `starts_at` + `duration_minutes` (see that model's docblock).
 */
class TournamentController extends Controller
{
    use AdminGuard;

    private const VARIANTS = ['standard', 'chess960', 'duck', 'crazyhouse', 'antichess'];

    /** How long after ending a finished arena still shows in the public list. */
    private const RECENTLY_FINISHED_SECONDS = 86400;

    /** Bound from path {id} on the detail route (empty on the list route). */
    public string $id = '';

    // POST /tournaments body fields.
    public string $name = '';

    public string $variant = 'standard';

    public string $pool = '3+0';

    public string $starts_at = '';

    public int $duration_minutes = 30;

    public bool $rated = true;

    public function get(): JsonResponse
    {
        return $this->id !== '' ? $this->show($this->id) : $this->list();
    }

    public function post(): JsonResponse
    {
        if ($denied = $this->requireAdmin($this->request)) {
            return $denied;
        }

        $this->validate([
            'name' => 'required|string|max:100',
            'variant' => 'in:' . implode(',', self::VARIANTS),
            'pool' => 'required|string',
            'starts_at' => 'required|string',
            'duration_minutes' => 'int',
            'rated' => 'boolean',
        ]);

        if (!self::validPool($this->pool)) {
            return JsonResponse::badRequest('invalid pool');
        }

        $startsTs = strtotime($this->starts_at);
        if ($startsTs === false) {
            return JsonResponse::badRequest('invalid starts_at');
        }

        $duration = max(1, min(1440, $this->duration_minutes));

        $me = $this->authedUserId();
        if ($me === null) {
            return JsonResponse::unauthorized();
        }

        $tournament = new Tournament();
        $tournament->name = trim($this->name);
        $tournament->variant = in_array($this->variant, self::VARIANTS, true) ? $this->variant : 'standard';
        $tournament->pool = $this->pool;
        $tournament->starts_at = date('Y-m-d H:i:s', $startsTs);
        $tournament->duration_minutes = $duration;
        $tournament->rated = $this->rated;
        $tournament->status = 'scheduled';
        $tournament->created_by = $me;

        if (!$tournament->save()) {
            return JsonResponse::error('failed to create tournament', 500);
        }

        return JsonResponse::created($this->summaryRow($tournament, 0));
    }

    private function list(): JsonResponse
    {
        /** @var list<Tournament> $tournaments */
        $tournaments = Tournament::query()->orderByDesc('starts_at')->limit(200)->get();

        $visible = [];
        foreach ($tournaments as $t) {
            $t->reconcileStatus();
            if ($t->status !== 'finished' || $t->endsAtTimestamp() >= time() - self::RECENTLY_FINISHED_SECONDS) {
                $visible[] = $t;
            }
        }

        // Running first, then scheduled (soonest first), then recently-finished
        // (most-recent first) — each group already sorted by the outer orderByDesc.
        usort($visible, static function (Tournament $a, Tournament $b): int {
            $rank = static fn (Tournament $t): int => match ($t->status) {
                'running' => 0,
                'scheduled' => 1,
                default => 2,
            };
            $ra = $rank($a);
            $rb = $rank($b);
            if ($ra !== $rb) {
                return $ra <=> $rb;
            }

            return $ra === 1
                ? $a->startsAtTimestamp() <=> $b->startsAtTimestamp()
                : $b->startsAtTimestamp() <=> $a->startsAtTimestamp();
        });

        $counts = $this->playerCounts(array_map(static fn (Tournament $t): string => (string) $t->id, $visible));

        $rows = array_map(fn (Tournament $t): array => $this->summaryRow($t, $counts[(string) $t->id] ?? 0), $visible);

        return JsonResponse::ok(['tournaments' => $rows]);
    }

    private function show(string $id): JsonResponse
    {
        $tournament = Tournament::find($id);
        if (!$tournament instanceof Tournament) {
            return JsonResponse::notFound('tournament not found');
        }

        $tournament->reconcileStatus();

        /** @var list<TournamentPlayer> $players */
        $players = TournamentPlayer::query()
            ->where('tournament_id', '=', $tournament->id)
            ->orderByDesc('score')
            ->orderBy('games', 'asc')
            ->get();

        $userIds = array_map(static fn (TournamentPlayer $p): string => $p->user_id, $players);
        $users = [];
        if ($userIds !== []) {
            foreach (User::query()->whereIn('id', $userIds)->get() as $u) {
                $users[(string) $u->id] = $u;
            }
        }

        $standings = [];
        foreach ($players as $p) {
            $u = $users[$p->user_id] ?? null;
            $standings[] = [
                'user_id' => $p->user_id,
                'name' => $u instanceof User ? $u->name : null,
                'title' => $u instanceof User ? $u->displayTitle() : null,
                'score' => $p->score,
                'games' => $p->games,
                'withdrawn' => $p->withdrawn,
            ];
        }

        return JsonResponse::ok([
            'tournament' => $this->summaryRow($tournament, count(array_filter($players, static fn (TournamentPlayer $p): bool => !$p->withdrawn))),
            'standings' => $standings,
        ]);
    }

    /**
     * @param list<string> $tournamentIds
     * @return array<string, int> tournament id => count of non-withdrawn players
     */
    private function playerCounts(array $tournamentIds): array
    {
        if ($tournamentIds === []) {
            return [];
        }

        $placeholders = implode(',', array_fill(0, count($tournamentIds), '?'));
        $sql = "SELECT tournament_id, COUNT(*) AS cnt FROM tournament_player
                WHERE withdrawn = 0 AND tournament_id IN ($placeholders)
                GROUP BY tournament_id";
        $rows = App::db()->raw($sql, $tournamentIds);

        $counts = [];
        foreach ($rows as $row) {
            $counts[(string) ($row['tournament_id'] ?? '')] = (int) ($row['cnt'] ?? 0);
        }

        return $counts;
    }

    /** @return array<string, mixed> */
    private function summaryRow(Tournament $t, int $playerCount): array
    {
        return [
            'id' => $t->id,
            'name' => $t->name,
            'variant' => $t->variant,
            'pool' => $t->pool,
            'starts_at' => $t->starts_at,
            'duration_minutes' => $t->duration_minutes,
            'rated' => $t->rated,
            'status' => $t->status,
            'ends_at_ms' => $t->endsAtMs(),
            'player_count' => $playerCount,
        ];
    }

    private function authedUserId(): ?string
    {
        $user = $this->request->user;
        $id = $user['id'] ?? null;

        return is_string($id) && $id !== '' ? $id : null;
    }

    /** Same "N+0" clock-format check ChallengeController::validPool uses. */
    private static function validPool(string $pool): bool
    {
        if (!preg_match('/^(\d+)\+(\d+)$/', $pool, $m)) {
            return false;
        }
        $base = (int) $m[1];
        $inc = (int) $m[2];

        return $base >= 0 && $base <= 180 && $inc >= 0 && $inc <= 180 && ($base > 0 || $inc > 0);
    }
}
