<?php

namespace App\Controllers;

use Throwable;
use BaseApi\App;
use BaseApi\Controllers\Controller;
use BaseApi\Http\JsonResponse;
use App\Models\Game;
use App\Models\User;
use App\Models\Tournament;
use App\Models\TournamentPlayer;
use App\Services\Glicko2Service;
use App\Services\AnticheatService;
use App\Services\StreakService;
use App\Jobs\AnalyzeGameJob;

/**
 * Internal endpoint the realtime hub calls when a game ends (SPEC §8.2). Stores
 * the game and, when rated, updates both players' Elo for the time-control
 * category. Authenticated by a shared-secret header (WS_TICKET_SECRET), not a
 * user session — the caller is the hub process, not a browser.
 *
 *   POST /internal/games   (header  X-Hub-Secret: <WS_TICKET_SECRET>)
 *   body: { id, pool, rated, result, reason,
 *           white:{uid,name,anon,bot}, black:{…}, moves:[…], sans:[…] }
 */
class GameResultController extends Controller
{
    /**
     * A fill-in bot has no account, so it isn't rated — but it still needs an
     * RD to act as an opponent. Treat it as a stable, established anchor.
     */
    private const BOT_RD = 50.0;

    public function __construct(
        private readonly Glicko2Service $glicko,
        private readonly AnticheatService $anticheat,
        private readonly StreakService $streak,
    ) {
    }

    public function post(): JsonResponse
    {
        if (!$this->authorized()) {
            return JsonResponse::unauthorized('bad hub secret');
        }

        $b = $this->request->body ?? [];
        $hubId = (string)($b['id'] ?? '');
        $pool = (string)($b['pool'] ?? '');
        $result = (string)($b['result'] ?? '');
        $white = is_array($b['white'] ?? null) ? $b['white'] : [];
        $black = is_array($b['black'] ?? null) ? $b['black'] : [];

        if ($hubId === '' || $pool === '' || $white === [] || $black === []
            || !in_array($result, ['1-0', '0-1', '1/2-1/2'], true)) {
            return JsonResponse::badRequest('missing or invalid game fields');
        }

        // Idempotent: a retried persist for the same hub game is a no-op.
        $existing = Game::firstWhere('hub_game_id', '=', $hubId);
        if ($existing instanceof Game) {
            return JsonResponse::ok(['id' => $existing->id, 'duplicate' => true]);
        }

        // Duck Chess, Crazyhouse, Antichess, and Secret Queen are each their own
        // isolated rating pool (no time-control split): every game of that variant
        // maps to its own category regardless of its clock. Standard / Chess960
        // fall back to the duration-derived time-control category. This mirrors
        // the hub's categoryFor(). (Secret Queen live play isn't wired up on the
        // hub side yet — see docs/tasks/open/secret-queen.md — but the category
        // is ready for when it is, same as the User rating columns.)
        $variant = $this->normalizeVariant($b['variant'] ?? null);
        $category = match ($variant) {
            'duck' => 'duck',
            'crazyhouse' => 'crazyhouse',
            'antichess' => 'antichess',
            'secretqueen' => 'secretqueen',
            default => $this->glicko->categoryForPool($pool),
        };
        $rated = (bool)($b['rated'] ?? false);

        $game = new Game();
        $game->hub_game_id = $hubId;
        $game->pool = $pool;
        $game->category = $category;
        $game->rated = $rated;
        $game->variant = $variant;
        $game->result = $result;
        $game->reason = (string)($b['reason'] ?? '');
        $game->white_uid = (string)($white['uid'] ?? '');
        $game->black_uid = (string)($black['uid'] ?? '');
        $game->white_name = (string)($white['name'] ?? '');
        $game->black_name = (string)($black['name'] ?? '');
        $game->white_is_bot = (bool)($white['bot'] ?? false);
        $game->black_is_bot = (bool)($black['bot'] ?? false);
        $tournamentId = trim((string)($b['tournamentId'] ?? ''));
        $game->tournament_id = $tournamentId !== '' ? $tournamentId : null;
        $startFen = trim((string)($b['startFen'] ?? ''));
        $game->start_fen = $startFen !== '' ? $startFen : null;
        $game->setMoves(array_map('strval', (array)($b['moves'] ?? [])));
        $game->setSans(array_map('strval', (array)($b['sans'] ?? [])));
        $game->setMoveTimes(array_map('intval', (array)($b['moveTimes'] ?? [])));
        $game->ply = count($game->getMoves());

        // Resolve real accounts (anon ids and bot-… ids won't match a user).
        // This is the ELO path only — resolveAccount() deliberately returns null
        // for any bot side, so Elo/streak/anticheat below are untouched.
        $whiteUser = $this->resolveAccount($white);
        $blackUser = $this->resolveAccount($black);

        // white_user_id/black_user_id, however, attach whenever the side's uid
        // resolves to a REAL user row, bot account or not — a seeded bot account
        // (role='bot', a real `user` row) needs its arena games to show up on its
        // own profile. Reuses resolveAccountForScoring() (the arena-scoring
        // resolver, which already doesn't exclude bots — only anon sides) rather
        // than adding a third resolver. The hub's ordinary backfill bots
        // (bot-<random> uids) still resolve to nothing here, same as before.
        $whiteAccount = $this->resolveAccountForScoring($white);
        $blackAccount = $this->resolveAccountForScoring($black);
        if ($whiteAccount instanceof User) {
            $game->white_user_id = $whiteAccount->id;
        }

        if ($blackAccount instanceof User) {
            $game->black_user_id = $blackAccount->id;
        }

        // Elo updates for rated games: symmetric between two accounts, or
        // one-sided when a logged-in account plays a matchmaking fill-in bot
        // (the bot has no account, so only the human's rating moves).
        if ($rated) {
            $whiteBot = (bool)($white['bot'] ?? false);
            $blackBot = (bool)($black['bot'] ?? false);
            if ($whiteUser instanceof User && $blackUser instanceof User) {
                $this->applyElo($game, $whiteUser, $blackUser, $category, $result);
            } elseif ($whiteUser instanceof User && $blackBot) {
                $this->applyEloVsBot($game, $whiteUser, true, (int)($black['rating'] ?? 1500), $category, $result);
            } elseif ($blackUser instanceof User && $whiteBot) {
                $this->applyEloVsBot($game, $blackUser, false, (int)($white['rating'] ?? 1500), $category, $result);
            }

            // Bot sides never run through applyElo()/applyEloVsBot() above (both are
            // gated on resolveAccount(), which deliberately returns null for any
            // bot side so Elo never moves for one). But a seeded bot account
            // ($whiteAccount/$blackAccount — resolved via resolveAccountForScoring(),
            // which does NOT exclude bots) still has a real `user` row with its own
            // profile, and that profile's per-category "N games" tile reads
            // games_<category> — so it must be bumped here, or it drifts behind the
            // account's actual game rows forever. Rating/RD/vol/rated_at are left
            // untouched: this only mirrors writeRating()'s counter line, not its Elo
            // side effects. A human side is already covered above (writeRating()),
            // so only the bot-flagged side is bumped here to avoid double-counting.
            if ($whiteAccount instanceof User && $whiteBot) {
                $this->bumpGamesCounter($whiteAccount, $category);
            }

            if ($blackAccount instanceof User && $blackBot) {
                $this->bumpGamesCounter($blackAccount, $category);
            }
        }

        if (!$game->save()) {
            return JsonResponse::error('failed to persist game', 500);
        }

        // Arena scoring resolves accounts SEPARATELY from Elo: a tournament bot
        // side carries its real seeded account id (bot: true), so its arena
        // points must still land — but Elo above is untouched (resolveAccount()
        // returns null for any bot side, exactly as before). Best-effort + never
        // allowed to break the persist path above (an unknown tournament id, an
        // unresolvable id, or a side that never joined, just means that side
        // isn't scored — the game record itself is unaffected). Reuses the same
        // $whiteAccount/$blackAccount resolved above for white_user_id/black_user_id.
        $this->applyTournamentScoring($game, $whiteAccount, $blackAccount, $result);

        // Post-game anti-cheat review: the CHEAP signals only (rating velocity +
        // move-time anomaly). Self-contained + best-effort — a flag never blocks
        // the persist. The expensive engine-correlation pass runs out-of-band in
        // scripts/anticheat_scan.php (full-game analysis is too slow for here).
        $this->anticheat->reviewFinishedGame($game, $whiteUser, $blackUser);

        // The Flame: a rated game is a qualifying daily action. Roll the streak for
        // each real account that played it (a fill-in bot has no account, so only
        // the human's streak moves). Best-effort + post-save — never blocks persist.
        if ($rated) {
            if ($whiteUser instanceof User) {
                $this->streak->recordActivity($whiteUser);
            }

            if ($blackUser instanceof User) {
                $this->streak->recordActivity($blackUser);
            }
        }

        // Eagerly precompute the full-game analysis OFF-REQUEST (queue worker), so
        // opening the review board is an instant cache hit instead of a multi-second
        // engine burst. Rated games only — the ones worth the background engine cost;
        // a user who opens the review before the job lands just triggers the lazy
        // compute (the GET path is unchanged) and the client's 404-retry covers the
        // brief not-yet-persisted window. Requires QUEUE_DRIVER=database + a running
        // `mason queue:work` worker; under the sync driver this would run inline.
        //
        // …and NOT when either side is a bot ({@see shouldEagerlyAnalyze()}). The
        // eager job buys exactly one thing — latency for a human who opens the
        // review board — and effectively nobody opens the review board for a game
        // they played against a bot, so for those it's pure engine time and stored
        // bytes spent on a cache nothing reads. Nothing is lost: the lazy path is
        // untouched, so a bot game a user DOES open (or that the Tutor report pulls
        // in) is analyzed then, on demand, exactly as before.
        if ($this->shouldEagerlyAnalyze($game)) {
            dispatch(new AnalyzeGameJob($game->hub_game_id));
        }

        return JsonResponse::created(['id' => $game->id]);
    }

    /**
     * Is this finished game worth precomputing an analysis for, ahead of anyone
     * asking? Rated, and human on both sides.
     *
     * `white_is_bot`/`black_is_bot` mirror the hub's per-side `bot` flag, which
     * covers BOTH kinds of bot: the hub's own anonymous matchmaking/backfill
     * fillers (`bot-<random>` uids, no account) and the seeded bot ACCOUNTS
     * (`user.role = 'bot'`) an arena fills itself with — both are seated through
     * the hub's newBotPlayer(), so both arrive here flagged. That matters because
     * a seeded bot account is a registered user, so an arena game against one is
     * `rated` (even though no Elo moves for the bot side) and used to qualify for
     * the eager job on the rated check alone.
     */
    private function shouldEagerlyAnalyze(Game $game): bool
    {
        return $game->rated && !$game->white_is_bot && !$game->black_is_bot;
    }

    /**
     * Coerce the hub's optional `variant` field into a known value. Older hubs
     * (and all standard games) omit it, so absent/unknown falls back to
     * 'standard'. A 'duck'/'crazyhouse'/'antichess' game is routed to its own
     * isolated rating category.
     */
    private function normalizeVariant(mixed $variant): string
    {
        $v = is_string($variant) ? $variant : '';

        return in_array($v, ['standard', 'chess960', 'duck', 'crazyhouse', 'antichess', 'secretqueen'], true) ? $v : 'standard';
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

    /**
     * Resolve a hub side to a registered User, or null for anonymous / bot /
     * unknown identities.
     *
     * @param array<string, mixed> $side
     */
    private function resolveAccount(array $side): ?User
    {
        if (($side['bot'] ?? false) || ($side['anon'] ?? false)) {
            return null;
        }

        $uid = (string)($side['uid'] ?? '');
        if ($uid === '') {
            return null;
        }

        $user = User::find($uid);

        return $user instanceof User ? $user : null;
    }

    /**
     * Resolve a hub side to a registered User FOR ARENA SCORING ONLY —
     * unlike {@see resolveAccount()} this does NOT exclude bot sides. The hub
     * sends a tournament bot's real seeded account id (from
     * scripts/seed_bot_accounts.php) alongside `bot: true`, so its tournament
     * points must be attributed to that account even though the very same
     * flag keeps it out of Elo. Anonymous sides and unknown/unresolvable ids
     * still resolve to null (nothing to score against).
     *
     * @param array<string, mixed> $side
     */
    private function resolveAccountForScoring(array $side): ?User
    {
        if ($side['anon'] ?? false) {
            return null;
        }

        $uid = (string)($side['uid'] ?? '');
        if ($uid === '') {
            return null;
        }

        $user = User::find($uid);

        return $user instanceof User ? $user : null;
    }

    private function applyElo(Game $game, User $white, User $black, string $category, string $result): void
    {
        // Each player's current uncertainty, grown for any idle time since their
        // last rated game in this category. Both updates use these pre-game RDs.
        $wRd = $this->currentRd($white, $category);
        $bRd = $this->currentRd($black, $category);

        $wr = (int)$white->{'rating_' . $category};
        $br = (int)$black->{'rating_' . $category};

        [$ws, $bs] = match ($result) {
            '1-0' => [1.0, 0.0],
            '0-1' => [0.0, 1.0],
            default => [0.5, 0.5],
        };

        $newW = $this->glicko->update((float)$wr, $wRd, (float)$white->{'vol_' . $category}, [
            ['rating' => (float)$br, 'rd' => $bRd, 'score' => $ws],
        ]);
        $newB = $this->glicko->update((float)$br, $bRd, (float)$black->{'vol_' . $category}, [
            ['rating' => (float)$wr, 'rd' => $wRd, 'score' => $bs],
        ]);

        $this->writeRating($white, $category, $newW);
        $this->writeRating($black, $category, $newB);
        $white->save();
        $black->save();

        $game->white_rating_before = $wr;
        $game->white_rating_after = (int) round($newW[0]);
        $game->black_rating_before = $br;
        $game->black_rating_after = (int) round($newB[0]);
    }

    /**
     * One-sided update: a single account vs a fill-in bot (no account). Only the
     * account's rating moves, against the bot's displayed rating (a stable anchor).
     */
    private function applyEloVsBot(Game $game, User $user, bool $userIsWhite, int $botRating, string $category, string $result): void
    {
        $ur = (int)$user->{'rating_' . $category};
        $rd = $this->currentRd($user, $category);

        $score = match ($result) {
            '1-0' => $userIsWhite ? 1.0 : 0.0,
            '0-1' => $userIsWhite ? 0.0 : 1.0,
            default => 0.5,
        };

        $newU = $this->glicko->update((float)$ur, $rd, (float)$user->{'vol_' . $category}, [
            ['rating' => (float)$botRating, 'rd' => self::BOT_RD, 'score' => $score],
        ]);

        $this->writeRating($user, $category, $newU);
        $user->save();

        $after = (int) round($newU[0]);
        if ($userIsWhite) {
            $game->white_rating_before = $ur;
            $game->white_rating_after = $after;
            $game->black_rating_before = $botRating;
            $game->black_rating_after = $botRating;
        } else {
            $game->black_rating_before = $ur;
            $game->black_rating_after = $after;
            $game->white_rating_before = $botRating;
            $game->white_rating_after = $botRating;
        }
    }

    /**
     * Update Arena standings for a finished tournament game. Fully defensive:
     * this endpoint is how every live game reaches the database, so a scoring
     * bug (bad tournament id, a player who withdrew/never joined, a DB hiccup)
     * must degrade to "no score change" rather than a 500 — wrapped in a
     * catch-all on top of the individual null-checks below.
     */
    private function applyTournamentScoring(Game $game, ?User $whiteUser, ?User $blackUser, string $result): void
    {
        $tournamentId = $game->tournament_id;
        if ($tournamentId === null || $tournamentId === '') {
            return;
        }

        try {
            $tournament = Tournament::find($tournamentId);
            if (!$tournament instanceof Tournament) {
                return;
            }

            [$whiteOutcome, $blackOutcome] = match ($result) {
                '1-0' => ['win', 'loss'],
                '0-1' => ['loss', 'win'],
                default => ['draw', 'draw'],
            };

            if ($whiteUser instanceof User) {
                $this->updateTournamentPlayer($tournamentId, $whiteUser->id, $whiteOutcome);
            }

            if ($blackUser instanceof User) {
                $this->updateTournamentPlayer($tournamentId, $blackUser->id, $blackOutcome);
            }
        } catch (Throwable) {
            // Swallow: scoring is best-effort, the game row is already saved.
        }
    }

    /**
     * Apply one outcome to one player's standing row. win = 2 (4 once already on
     * a 2+ win streak), draw = 1, loss = 0; a draw/loss resets the streak. A user
     * with no row for this tournament (never joined, or joined after this game
     * started) is silently skipped rather than creating a phantom standing.
     */
    private function updateTournamentPlayer(string $tournamentId, string $userId, string $outcome): void
    {
        // NOT firstWhereConditions(['tournament_id' => ..., 'user_id' => ...]) —
        // that helper expects a LIST of {column,operator,value} arrays, not a
        // flat column=>value map; passed a flat map it throws (caught by the
        // caller's catch-all, so this was silently never matching). Chained
        // where()->first() is the form the rest of this codebase uses safely.
        $player = TournamentPlayer::query()
            ->where('tournament_id', '=', $tournamentId)
            ->where('user_id', '=', $userId)
            ->first();
        if (!$player instanceof TournamentPlayer) {
            return;
        }

        $player->games++;
        if ($outcome === 'win') {
            $player->score += $player->streak >= 2 ? 4 : 2;
            $player->streak++;
        } elseif ($outcome === 'draw') {
            $player->score += 1;
            $player->streak = 0;
        } else {
            $player->streak = 0;
        }

        $player->save();
    }

    /**
     * Bump a bot account's own games_<category> counter, with no Elo/RD/volatility
     * side effect. {@see writeRating()} is what bumps this same counter for a real
     * (non-bot) account, as part of applying its Elo update; a bot side never goes
     * through that path (Elo intentionally never moves for a bot), so its profile
     * counter needs this narrower bump instead.
     */
    private function bumpGamesCounter(User $account, string $category): void
    {
        $account->{'games_' . $category} = (int)$account->{'games_' . $category} + 1;
        $account->save();
    }

    /** RD for this category right now, grown for idle time since the last game. */
    private function currentRd(User $user, string $category): float
    {
        $rd = (float)$user->{'rd_' . $category};
        $last = $user->{'rated_at_' . $category};
        $idleDays = 0.0;
        if (is_string($last) && $last !== '') {
            $idleDays = max(0.0, (time() - strtotime($last)) / 86400.0);
        }

        return $this->glicko->inflateRd($rd, $idleDays);
    }

    /**
     * Persist a Glicko-2 result triple back onto the user: rounded rating,
     * new RD + volatility, a bumped game count, and the rated-at timestamp.
     *
     * @param array{0:float,1:float,2:float} $next [rating, rd, vol]
     */
    private function writeRating(User $user, string $category, array $next): void
    {
        $user->{'rating_' . $category} = (int) round($next[0]);
        $user->{'rd_' . $category} = $next[1];
        $user->{'vol_' . $category} = $next[2];
        $user->{'games_' . $category} = (int)$user->{'games_' . $category} + 1;
        $user->{'rated_at_' . $category} = date('Y-m-d H:i:s');
    }
}
