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
 * Bot enrolment: every poll, a running tournament with fewer bots than its
 * target field size (see targetFieldSize()) gets topped up with the next
 * deterministic slice of the seeded bot pool (scripts/seed_bot_accounts.php),
 * respecting min_rating/max_rating/titled_only. A bot, once enrolled, is
 * never re-selected or removed (the deterministic ordering is a stable
 * per-tournament prefix, see enrolBots()) — so this is safe to run on every
 * 5s poll: a tournament already at (or past) its target does one cheap
 * in-memory count-and-skip, and an under-filled one only ever does DB work
 * for the bots it's still missing, never re-touching ones it already has.
 * This is what lets a tournament created before a field-size formula change
 * (or one that started small and is growing into a longer field target as
 * the event goes on) top up over time instead of being frozen at whatever
 * it got on its first poll.
 *
 * Field size scales with the event's actual THROUGHPUT, not a flat number or
 * duration alone (see targetFieldSize()): an hourly bullet arena and a
 * monthly rapid championship don't just differ in length, they differ in how
 * many games the hub's 6-concurrent-games-per-arena cap can actually push
 * through in that length, so sizing off duration alone (the old formula)
 * produced fields far too big for slower time controls — a 74-player rapid
 * arena in which everyone gets 1-2 games is exactly the "fake" arena problem
 * this replaced, just relocated from field size to games-per-entrant. The
 * pool (150 accounts as of 2026-07-31, scripts/seed_bot_accounts.php) is
 * sized comfortably above the biggest field so different tournaments'
 * deterministic crc32 orderings actually look different, not like the same
 * ~100 names every time.
 */
class ArenaInternalController extends Controller
{
    /** Field-size floor: even the shortest hourly arena reads as a real event. */
    private const MIN_FIELD_SIZE = 16;

    /** Field-size ceiling: keeps the response bounded regardless of how long
     *  a future rota entry runs, and keeps a big win/loss from being tied to
     *  the exact size of the bot pool. */
    private const MAX_FIELD_SIZE = 100;

    /**
     * Mirrors the hub's `arenaBotVsBotCapMax` (gomachine/internal/hub/arena.go)
     * — the ceiling `arenaBotVsBotCapForField` plateaus at once a field has 12+
     * bots. Every rota field is well above 12 (MIN_FIELD_SIZE=16), so the hub
     * always runs exactly this many bot-vs-bot games concurrently in
     * practice; used below to estimate total tournament throughput. If the
     * hub's constant ever changes, this must change with it — there's no way
     * to read it across the process boundary, so it's a second source of
     * truth by necessity, the same way WS_TICKET_SECRET is mirrored in two
     * env files.
     */
    private const CONCURRENT_BOT_VS_BOT_CAP = 6;

    /**
     * Typical full game length in plies, i.e. ~40 moves/side. Reuses the same
     * "typical game length" figure {@see \App\Services\Glicko2Service::categoryForPool()}
     * assumes with its "40*increment" term — this is the one place both
     * estimators lean on the same assumption rather than each inventing a
     * different number.
     */
    private const ASSUMED_PLIES_PER_GAME = 80;

    /**
     * The hub's own central pacing fraction from `botThinkDelay`
     * (gomachine/internal/hub/bot.go): `ms := perMove * 0.30` is the
     * mid-point think time before any of that function's other adjustments.
     */
    private const CENTRAL_PACE_FRACTION = 0.3;

    /**
     * A single composite multiplier standing in for every OTHER modifier
     * `botThinkDelay` applies on top of its central 0.30 fraction: the
     * opening ramp (first ~10 full moves played at ~10%-100% of pace,
     * quadratically, averaging roughly 0.4x over that stretch — about a
     * quarter of an assumed 40-move game), the material/endgame speedup
     * (1.0x at a full board down to 0.4x bare, averaging roughly 0.7x over
     * a game), the rating-speed factor (≈1.0x for a mid-ladder ~1500-rated
     * bot, the pool's rough center), and the busy-position bonus (a minor
     * +0.15x only above 30 legal moves). Composing those — roughly
     * 0.7 (material) * 0.85 (opening, weighted by how much of the game it
     * covers) — nets out to ~0.6. This is an ANALYTICAL estimate read off
     * the hub's source, not measured from real bot-game logs: confidence on
     * this exact coefficient is medium-low (plausibly off by ±40%), but
     * confidence is high on the shape it produces — a bot game is
     * dominated by base time, only lightly touched by increment, and
     * finishes well short of the raw clock budget because bots settle games
     * (mate/resign) rather than grinding to a flag. If real bot-game
     * durations are ever logged, re-derive this from measurements instead.
     */
    private const PACING_COMPOSITE_DISCOUNT = 0.6;

    /**
     * How many games a typical entrant should finish an arena with, by
     * time-control category (bullet/blitz/rapid/classical, the same buckets
     * {@see \App\Services\Glicko2Service::categoryForPool()} uses). Chosen to
     * land in the same range a real Lichess arena entrant sees for that
     * speed of clock — a handful for a slow control, up to a couple of dozen
     * for bullet — not measured, a deliberate target the field size is
     * solved backwards from in {@see self::targetFieldSize()}.
     */
    private const TARGET_GAMES_PER_ENTRANT = [
        'bullet' => 24,
        'blitz' => 16,
        'rapid' => 10,
        'classical' => 6,
    ];

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

        // Auto-enrol (and top up) bots into every running tournament that has
        // fewer bots than its target field size. Best-effort per tournament:
        // a failure here must never take down the whole poll response (the
        // hub still needs the other arenas).
        if ($botPool !== []) {
            foreach ($running as $t) {
                $existing = $playersByTournament[$t->id] ?? [];
                $existingBotUserIds = [];
                foreach ($existing as $p) {
                    if (isset($botsById[$p->user_id])) {
                        $existingBotUserIds[$p->user_id] = true;
                    }
                }

                $target = $this->targetFieldSize($t);
                if (count($existingBotUserIds) >= $target) {
                    // Already at (or, after a formula change lowers the
                    // target, past) the field size — nothing to add. Cheap:
                    // no DB work below this line for a fully-topped-up arena.
                    continue;
                }

                try {
                    $newRows = $this->enrolBots($t, $botPool, $target, $existingBotUserIds);
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
     * Deterministically pick and join the still-missing subset of the bot
     * pool into one tournament, respecting its entry restrictions
     * (titled_only / min_rating / max_rating, judged on the tournament's own
     * rating category — mirrors TournamentJoinController's human-facing
     * rule). The subset is a stable function of the tournament id alone, not
     * of the target or of who's already joined, so it never churns between
     * polls: growing the target only ever APPENDS to the same deterministic
     * prefix, it never reorders or drops anyone already in it, which is what
     * makes topping up a running tournament safe — an existing entrant's row
     * (and its score/games) is never touched, only new rows are added.
     *
     * @param list<User> $botPool
     * @param array<string, true> $alreadyEnrolledUserIds bot user ids already
     *        known to be joined (from this poll's already-loaded roster) —
     *        skipped without a DB round-trip, so a poll's cost is
     *        proportional to how many bots are still missing, not to the
     *        target field size.
     * @return list<TournamentPlayer> newly-created rows (existing ones are
     *         never re-created — see the unique (tournament_id,user_id) index).
     */
    private function enrolBots(Tournament $t, array $botPool, int $target, array $alreadyEnrolledUserIds): array
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

        $selected = array_slice($eligible, 0, $target);

        $created = [];
        foreach ($selected as $bot) {
            if (isset($alreadyEnrolledUserIds[$bot->id])) {
                continue; // known joined from this poll's roster — no DB hit needed
            }

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
     * How many bots a tournament should try to field, sized off THROUGHPUT
     * rather than duration alone. Duration-only sizing (the previous formula)
     * put a 74-player field on a 117-minute 10+0 rapid arena that the hub's
     * 6-concurrent-games cap can only push ~59 games through — 1.6 games per
     * entrant, standings that read as a wall of "1 game", exactly the
     * fake-arena complaint this whole feature exists to fix.
     *
     * The fix: work out how many GAMES the arena can actually produce, then
     * solve backwards for the field size that gives a typical entrant a
     * plausible number of them (see TARGET_GAMES_PER_ENTRANT).
     *
     *   totalGames  = CONCURRENT_BOT_VS_BOT_CAP * durationSeconds / gameLength
     *   fieldSize   = totalGames * 2 / targetGamesPerEntrant
     *
     * (the *2 because every game credits a "played" game to two entrants).
     * `gameLength` comes from {@see self::estimatedGameLengthSeconds()} — see
     * that method for the pacing derivation and its confidence.
     *
     * Restrictions (titled_only/min_rating/max_rating) aren't sized here —
     * they can only shrink the field, and enrolBots()'s eligibility filter +
     * array_slice already clamp the target down to however many bots
     * actually qualify (e.g. Titled Tuesday's target is ~38 but the titled
     * pool is 36, so it fields 36).
     *
     * Result is clamped to [MIN_FIELD_SIZE, MAX_FIELD_SIZE] — the ceiling in
     * particular still matters here: an unusually long bullet event (e.g. a
     * 180-minute weekly bullet arena) can want a field north of 100 to hold
     * games-per-entrant down near the bullet target, but 100 keeps the
     * response bounded and the bot pool from being spread paper-thin; in
     * that case entrants simply end up with MORE games than the target,
     * which is the safe direction to overshoot in.
     */
    private function targetFieldSize(Tournament $t): int
    {
        $gameLength = $this->estimatedGameLengthSeconds($t->pool);
        if ($gameLength <= 0.0) {
            return self::MIN_FIELD_SIZE;
        }

        $category = $this->glicko->categoryForPool($t->pool);
        $targetGamesPerEntrant = self::TARGET_GAMES_PER_ENTRANT[$category] ?? self::TARGET_GAMES_PER_ENTRANT['classical'];

        $durationSeconds = $t->duration_minutes * 60;
        $totalGames = self::CONCURRENT_BOT_VS_BOT_CAP * $durationSeconds / $gameLength;
        $totalGameCredits = $totalGames * 2;

        $scaled = (int) round($totalGameCredits / $targetGamesPerEntrant);

        return max(self::MIN_FIELD_SIZE, min(self::MAX_FIELD_SIZE, $scaled));
    }

    /**
     * Estimated wall-clock length, in seconds, of one bot-vs-bot arena game
     * at this pool. Bot games are ENGINE-PACED (the hub's `botThinkDelay`,
     * gomachine/internal/hub/bot.go) rather than clock-run-down, so this is
     * NOT `duration_minutes`/the pool's clock budget — a bot typically
     * settles a game (mate/resign) well short of flagging.
     *
     * Derivation, worked from botThinkDelay's own source:
     *   - `perMove = base/30 + increment` is that function's own "rough
     *     per-move time budget" comment, in seconds here.
     *   - Its central pacing fraction is 0.30 of perMove (CENTRAL_PACE_FRACTION).
     *   - Its other modifiers (opening ramp-up, endgame material speedup,
     *     rating-speed, busy-position bonus) net out to a further ~0.6x for a
     *     mid-ladder bot over a full game (PACING_COMPOSITE_DISCOUNT — see
     *     that constant's docblock for the breakdown).
     *   - Both sides play ASSUMED_PLIES_PER_GAME plies total (an assumed
     *     40-move/side game — the same "typical game length" figure
     *     {@see \App\Services\Glicko2Service::categoryForPool()} already
     *     assumes with its own "40*increment" term, reused rather than
     *     inventing a second one).
     *
     *   gameLength = ASSUMED_PLIES_PER_GAME * CENTRAL_PACE_FRACTION
     *              * PACING_COMPOSITE_DISCOUNT * (baseSeconds/30 + incSeconds)
     *
     * This is an ANALYTICAL estimate read off the hub's pacing source, not
     * measured from real bot-game logs. Confidence is medium-low on the
     * exact coefficients (plausibly off by ±40%) but high on the shape: game
     * length scales mostly with base time, only lightly with increment, and
     * comes in well under the raw clock budget. If real bot-game durations
     * are ever logged (e.g. from `game.duration` on finished tournament
     * games), re-derive this from measurements instead of this analytical
     * read of the pacing function.
     */
    private function estimatedGameLengthSeconds(string $pool): float
    {
        [$baseSeconds, $incSeconds] = $this->parsePoolSeconds($pool);
        $perMoveSeconds = $baseSeconds / 30 + $incSeconds;

        return self::ASSUMED_PLIES_PER_GAME * self::CENTRAL_PACE_FRACTION * self::PACING_COMPOSITE_DISCOUNT * $perMoveSeconds;
    }

    /**
     * Parses a "base+increment" pool string (e.g. "10+0") into
     * [baseSeconds, incrementSeconds]. Same convention as
     * {@see \App\Services\Glicko2Service}'s private parsePool() — duplicated
     * rather than shared because this controller only needs the seconds form
     * and that method is private to a class this controller doesn't own.
     *
     * @return array{0:int,1:int}
     */
    private function parsePoolSeconds(string $pool): array
    {
        $plus = strpos($pool, '+');
        if ($plus === false) {
            return [0, 0];
        }

        $baseMinutes = (int) substr($pool, 0, $plus);
        $incSeconds = (int) substr($pool, $plus + 1);

        return [$baseMinutes * 60, $incSeconds];
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
