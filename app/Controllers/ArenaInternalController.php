<?php

namespace App\Controllers;

use Throwable;
use BaseApi\App;
use BaseApi\Controllers\Controller;
use BaseApi\Http\JsonResponse;
use App\Models\Tournament;
use App\Models\TournamentPlayer;
use App\Models\User;
use App\Services\Glicko2Service;

/**
 * Internal endpoint the realtime hub polls (every few seconds) to drive Arena
 * pairing. Secret-gated like POST /internal/games and GET /internal/filler-fens
 * — the caller is the hub process, not a browser.
 *
 *   GET /internal/arenas/active   (header X-Hub-Secret: <WS_TICKET_SECRET>)
 *   → {"arenas":[{"id","pool","variant","rated","endsAtMs",
 *                 "players":[{"sub","score","withdrawn","bot","name","rating","title"}, ...]}, ...]}
 *
 * Only tournaments that are currently running (started, not yet ended) are
 * included. Doesn't bother with {@see Tournament::reconcileStatus()} — this
 * route is polled every few seconds, so even though reconcileStatus() is now
 * a pure in-memory refresh (no write, see that model's docblock), there's no
 * reason to touch every row's PHP object just to throw it away; the
 * candidate filter below (status != 'finished' AND starts_at <= now, where
 * `status` is the best-effort cache kept fresh by
 * {@see Tournament::reconcileAllStatuses()}) plus an in-PHP `isRunning()`
 * check on the smaller candidate set gets the same correctness more cheaply.
 * Every joined player is included with their current score — the hub, not
 * this endpoint, filters withdrawn players out of pairing.
 *
 * Bot enrolment: a running tournament with no bot in its roster yet gets a
 * deterministic subset of the seeded bot pool (scripts/seed_bot_accounts.php)
 * auto-joined, respecting min_rating/max_rating/titled_only. This only ever
 * runs the FIRST time a tournament is seen with an empty bot roster — every
 * later poll finds bots already present and skips straight to building the
 * response, so the 5s poll stays cheap.
 *
 * Field size scales with the event, not a flat number (see targetFieldSize()):
 * an hourly bullet arena and a monthly championship aren't the same event, so
 * they shouldn't draw the same-sized field. The pool (150 accounts as of
 * 2026-07-31, scripts/seed_bot_accounts.php) is sized comfortably above the
 * biggest field so different tournaments' deterministic crc32 orderings
 * actually look different, not like the same ~100 names every time.
 */
class ArenaInternalController extends Controller
{
    /** Field-size floor: even the shortest hourly arena reads as a real event. */
    private const MIN_FIELD_SIZE = 16;

    /** Field-size ceiling: keeps the response bounded regardless of how long
     *  a future rota entry runs, and keeps a big win/loss from being tied to
     *  the exact size of the bot pool. */
    private const MAX_FIELD_SIZE = 100;

    public function __construct(
        private readonly Glicko2Service $glicko,
    ) {
    }

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

        // Bot pool is small (tens of rows) — loaded every poll. It's needed both
        // to decide enrolment eligibility and to render bot rows without a
        // second per-row lookup.
        /** @var list<User> $botPool */
        $botPool = User::query()->where('role', '=', 'bot')->get();
        $botsById = [];
        foreach ($botPool as $b) {
            $botsById[(string) $b->id] = $b;
        }

        $ids = array_map(static fn (Tournament $t): string => (string) $t->id, $running);

        /** @var array<string, list<TournamentPlayer>> $playersByTournament */
        $playersByTournament = [];
        foreach (TournamentPlayer::query()->whereIn('tournament_id', $ids)->get() as $p) {
            $playersByTournament[$p->tournament_id][] = $p;
        }

        // Auto-enrol bots into any running tournament whose roster has none
        // yet. Best-effort per tournament: a failure here must never take down
        // the whole poll response (the hub still needs the other arenas).
        if ($botPool !== []) {
            foreach ($running as $t) {
                $existing = $playersByTournament[$t->id] ?? [];
                $hasBot = false;
                foreach ($existing as $p) {
                    if (isset($botsById[$p->user_id])) {
                        $hasBot = true;
                        break;
                    }
                }

                if ($hasBot) {
                    continue;
                }

                try {
                    $newRows = $this->enrolBots($t, $botPool);
                    if ($newRows !== []) {
                        $playersByTournament[$t->id] = array_merge($existing, $newRows);
                    }
                } catch (Throwable) {
                    // Swallow: enrolment is best-effort, the poll must still respond.
                }
            }
        }

        // Batch-load display data (name/rating/title) for every human player
        // referenced across every running arena — bots are already fully
        // hydrated in $botsById, so this whereIn only ever covers real accounts.
        $humanIds = [];
        foreach ($playersByTournament as $rows) {
            foreach ($rows as $p) {
                if (!isset($botsById[$p->user_id])) {
                    $humanIds[] = $p->user_id;
                }
            }
        }
        $humanIds = array_values(array_unique($humanIds));
        $humansById = [];
        if ($humanIds !== []) {
            foreach (User::query()->whereIn('id', $humanIds)->get() as $u) {
                $humansById[(string) $u->id] = $u;
            }
        }

        $arenas = array_map(function (Tournament $t) use ($playersByTournament, $botsById, $humansById): array {
            $category = $t->ratingCategory($this->glicko);
            $ratingCol = 'rating_' . $category;

            $players = array_map(function (TournamentPlayer $p) use ($botsById, $humansById, $ratingCol): array {
                $isBot = isset($botsById[$p->user_id]);
                $u = $isBot ? $botsById[$p->user_id] : ($humansById[$p->user_id] ?? null);

                return [
                    'sub' => $p->user_id,
                    'score' => $p->score,
                    'withdrawn' => $p->withdrawn,
                    'bot' => $isBot,
                    'name' => $u instanceof User ? $u->name : null,
                    'rating' => $u instanceof User ? (int) $u->{$ratingCol} : null,
                    'title' => $u instanceof User ? $u->displayTitle() : null,
                ];
            }, $playersByTournament[$t->id] ?? []);

            return [
                'id' => $t->id,
                'pool' => $t->pool,
                'variant' => $t->variant,
                'rated' => $t->rated,
                'endsAtMs' => $t->endsAtMs(),
                'players' => $players,
            ];
        }, $running);

        return JsonResponse::ok(['arenas' => $arenas]);
    }

    /**
     * Deterministically pick and join a subset of the bot pool into one
     * tournament, respecting its entry restrictions (titled_only / min_rating /
     * max_rating, judged on the tournament's own rating category — mirrors
     * TournamentJoinController's human-facing rule). The subset is a stable
     * function of the tournament id, so it never churns between polls or
     * between an enrolment attempt and a retried one.
     *
     * @param list<User> $botPool
     * @return list<TournamentPlayer> newly-created rows (existing ones are
     *         never re-created — see the unique (tournament_id,user_id) index).
     */
    private function enrolBots(Tournament $t, array $botPool): array
    {
        $category = $t->ratingCategory($this->glicko);
        $ratingCol = 'rating_' . $category;

        $eligible = array_values(array_filter($botPool, function (User $b) use ($t, $ratingCol): bool {
            if ($t->titled_only && $b->displayTitle() === null) {
                return false;
            }

            $rating = (int) $b->{$ratingCol};
            if ($t->min_rating !== null && $rating < $t->min_rating) {
                return false;
            }

            if ($t->max_rating !== null && $rating > $t->max_rating) {
                return false;
            }

            return true;
        }));

        if ($eligible === []) {
            return [];
        }

        // Stable per-tournament ordering: deterministic (same tournament id ⇒
        // same subset every time) without being the same across tournaments.
        $tournamentId = (string) $t->id;
        usort($eligible, static fn (User $a, User $b): int => crc32($tournamentId . ':' . $a->id) <=> crc32($tournamentId . ':' . $b->id));

        $selected = array_slice($eligible, 0, $this->targetFieldSize($t));

        $created = [];
        foreach ($selected as $bot) {
            // Defensive re-check: never insert a second row for the same pair
            // (a concurrent poll, or the bot having joined some other way).
            // Chained where()->first(), NOT firstWhereConditions(['col'=>val])
            // — that helper needs a list of {column,operator,value} arrays, a
            // flat map throws (see GameResultController::updateTournamentPlayer).
            $player = TournamentPlayer::query()
                ->where('tournament_id', '=', $tournamentId)
                ->where('user_id', '=', $bot->id)
                ->first();

            if (!$player instanceof TournamentPlayer) {
                $player = new TournamentPlayer();
                $player->tournament_id = $tournamentId;
                $player->user_id = $bot->id;
                $player->score = 0;
                $player->games = 0;
                $player->streak = 0;
                $player->withdrawn = false;

                if (!$player->save()) {
                    continue;
                }
            }

            $created[] = $player;
        }

        return $created;
    }

    /**
     * How many bots a tournament should try to field, scaled off what the
     * event actually is rather than one flat number for every arena. Duration
     * is the proxy: a 27-minute hourly bullet arena and a 240-minute monthly
     * championship are not the same event, and `duration_minutes` already
     * captures that distinction for every rota entry (see
     * TournamentSchedule) without needing a `series`/`titled_only`-keyed
     * lookup table that would silently miss a future rota addition.
     * Restrictions (titled_only/min_rating/max_rating) aren't sized here —
     * they can only shrink the field, and enrolBots()'s eligibility filter +
     * array_slice already clamp the target down to however many bots
     * actually qualify (e.g. Titled Tuesday's target is ~76 but the titled
     * pool is 36, so it fields 36).
     *
     * Pure function of `duration_minutes`, clamped to
     * [MIN_FIELD_SIZE, MAX_FIELD_SIZE]. Rota durations run 27..240 minutes,
     * which this maps to a ~29..100 field.
     */
    private function targetFieldSize(Tournament $t): int
    {
        $scaled = self::MIN_FIELD_SIZE + intdiv($t->duration_minutes, 2);

        return max(self::MIN_FIELD_SIZE, min(self::MAX_FIELD_SIZE, $scaled));
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
