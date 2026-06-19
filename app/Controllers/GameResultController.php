<?php

namespace App\Controllers;

use BaseApi\App;
use BaseApi\Controllers\Controller;
use BaseApi\Http\JsonResponse;
use App\Models\Game;
use App\Models\User;
use App\Services\Glicko2Service;

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

    public function __construct(private readonly Glicko2Service $glicko)
    {
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

        $category = $this->glicko->categoryForPool($pool);
        $rated = (bool)($b['rated'] ?? false);

        $game = new Game();
        $game->hub_game_id = $hubId;
        $game->pool = $pool;
        $game->category = $category;
        $game->rated = $rated;
        $game->result = $result;
        $game->reason = (string)($b['reason'] ?? '');
        $game->white_uid = (string)($white['uid'] ?? '');
        $game->black_uid = (string)($black['uid'] ?? '');
        $game->white_name = (string)($white['name'] ?? '');
        $game->black_name = (string)($black['name'] ?? '');
        $game->white_is_bot = (bool)($white['bot'] ?? false);
        $game->black_is_bot = (bool)($black['bot'] ?? false);
        $game->setMoves(array_map('strval', (array)($b['moves'] ?? [])));
        $game->setSans(array_map('strval', (array)($b['sans'] ?? [])));
        $game->ply = count($game->getMoves());

        // Resolve real accounts (anon ids and bot-… ids won't match a user).
        $whiteUser = $this->resolveAccount($white);
        $blackUser = $this->resolveAccount($black);
        if ($whiteUser instanceof User) {
            $game->white_user_id = $whiteUser->id;
        }

        if ($blackUser instanceof User) {
            $game->black_user_id = $blackUser->id;
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
        }

        if (!$game->save()) {
            return JsonResponse::error('failed to persist game', 500);
        }

        return JsonResponse::created(['id' => $game->id]);
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
