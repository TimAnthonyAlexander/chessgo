<?php

namespace App\Controllers;

use BaseApi\Controllers\Controller;
use BaseApi\Http\JsonResponse;
use App\Models\Game;
use App\Models\PremoveGame;
use App\Models\PuzzleAttempt;
use App\Models\User;
use App\Services\Glicko2Service;
use App\Services\HubClient;

/**
 * Public player profile, keyed by display name (the natural key the UI holds —
 * games store names, the nav shows the name). Anonymous-accessible: a finished
 * account's ratings + record are not secret. Email + password are never exposed.
 *
 *   GET /users/{name}
 *
 * Returns the account's per-category ratings (rating/RD/games/provisional), the
 * isolated puzzle rating + solved count, the isolated Duck Chess rating, the
 * isolated Premove Trainer rating, an overall win/loss/draw record across all
 * persisted games, and the most recent games as
 * light rows (no move blobs —
 * the board opens them via the analysis endpoint). Game pagination lives on the
 * sibling {@see ProfileGamesController} ("load more").
 *
 * `live_game` asks the realtime hub ({@see HubClient::livePlayer()}) whether
 * this account is in a game right now — null when not (or the hub is down).
 */
class ProfileController extends Controller
{
    /** How many recent games to embed in the first profile payload (page 1). */
    private const RECENT_GAMES = 10;

    /** How many points to keep per rating-pool sparkline (oldest → newest). */
    private const HISTORY_POINTS = 20;

    /** Rating pools backed by a `Game.category` value (time controls + the
     *  isolated Duck/Crazyhouse/Antichess pools). Puzzle history comes from
     *  PuzzleAttempt instead, since puzzles aren't Game rows. */
    private const HISTORY_CATEGORIES = ['bullet', 'blitz', 'rapid', 'classical', 'chess960', 'duck', 'crazyhouse', 'antichess'];

    /** Bound from path {name}. */
    public string $name = '';

    public function __construct(private readonly HubClient $hub)
    {
    }

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

        $paged = Game::query()
            ->where('white_user_id', '=', $id)
            ->orWhere('black_user_id', '=', $id)
            ->orderByDesc('created_at')
            ->paginate(1, self::RECENT_GAMES, self::RECENT_GAMES, withTotal: true);
        $rows = Game::summaryRowsWithTitles($paged->data);

        $puzzleSolved = PuzzleAttempt::query()
            ->where('user_id', '=', $id)
            ->where('solved', '=', true)
            ->count();

        return JsonResponse::ok([
            'id' => $id,
            'name' => $user->name,
            'role' => $user->role,
            'title' => $user->displayTitle(),
            'bio' => $user->bio,
            'country' => $user->country,
            'created_at' => $user->created_at,
            'ratings' => $this->ratings($user),
            'puzzle' => [
                'rating' => $user->rating_puzzle,
                'rd' => $user->rd_puzzle,
                'games' => $user->games_puzzle,
                'solved' => $puzzleSolved,
                'provisional' => ((float) $user->rd_puzzle) > Glicko2Service::PROVISIONAL_RD,
            ],
            // Premove Trainer is its own isolated pool (like puzzle) — surfaced
            // separately from the time-control rating tiles.
            'premove' => [
                'rating' => $user->rating_premove,
                'rd' => $user->rd_premove,
                'games' => $user->games_premove,
                'provisional' => ((float) $user->rd_premove) > Glicko2Service::PROVISIONAL_RD,
            ],
            // Chess960 is its own isolated pool (like puzzle) — standard rules, but
            // a different skill, so it never feeds the time-control tiles.
            'chess960' => [
                'rating' => $user->rating_chess960,
                'rd' => $user->rd_chess960,
                'games' => $user->games_chess960,
                'provisional' => ((float) $user->rd_chess960) > Glicko2Service::PROVISIONAL_RD,
                'rated_at' => $user->rated_at_chess960,
            ],
            // Duck Chess is its own isolated pool (like puzzle) — surfaced separately
            // from the time-control rating tiles.
            'duck' => [
                'rating' => $user->rating_duck,
                'rd' => $user->rd_duck,
                'games' => $user->games_duck,
                'provisional' => ((float) $user->rd_duck) > Glicko2Service::PROVISIONAL_RD,
                'rated_at' => $user->rated_at_duck,
            ],
            // Crazyhouse is likewise its own isolated pool, surfaced separately from
            // the time-control rating tiles.
            'crazyhouse' => [
                'rating' => $user->rating_crazyhouse,
                'rd' => $user->rd_crazyhouse,
                'games' => $user->games_crazyhouse,
                'provisional' => ((float) $user->rd_crazyhouse) > Glicko2Service::PROVISIONAL_RD,
                'rated_at' => $user->rated_at_crazyhouse,
            ],
            // Antichess is likewise its own isolated pool, surfaced separately from
            // the time-control rating tiles.
            'antichess' => [
                'rating' => $user->rating_antichess,
                'rd' => $user->rd_antichess,
                'games' => $user->games_antichess,
                'provisional' => ((float) $user->rd_antichess) > Glicko2Service::PROVISIONAL_RD,
                'rated_at' => $user->rated_at_antichess,
            ],
            'record' => $this->record($id),
            'live_game' => $this->liveGame($id),
            'games' => $rows,
            'gamesTotal' => $paged->total,
            'gamesPerPage' => self::RECENT_GAMES,
            // Per-pool rating trend (oldest → newest ratings-after), one series per
            // key in HISTORY_CATEGORIES plus 'puzzle'. Feeds the small sparkline
            // next to every pool in the ratings panel (and the hero call-out).
            'ratingHistory' => $this->ratingHistory($id),
        ]);
    }

    /**
     * Per-time-control rating tiles (display-only — RD drives the provisional "?").
     *
     * @return array<string, array<string, mixed>>
     */
    private function ratings(User $user): array
    {
        $out = [];
        foreach (['bullet', 'blitz', 'rapid', 'classical'] as $cat) {
            $rd = (float) $user->{'rd_' . $cat};
            $out[$cat] = [
                'rating' => $user->{'rating_' . $cat},
                'rd' => $rd,
                'games' => $user->{'games_' . $cat},
                'provisional' => $rd > Glicko2Service::PROVISIONAL_RD,
                'rated_at' => $user->{'rated_at_' . $cat},
            ];
        }

        return $out;
    }

    /**
     * Win/loss/draw across every persisted game the account played, from the
     * account's own perspective (a 1-0 is a win as White, a loss as Black).
     * Computed with count queries so the move/analysis blobs are never loaded.
     *
     * @return array<string, int>
     */
    private function record(string $id): array
    {
        $count = static fn (string $color, string $result): int => Game::query()
            ->where($color . '_user_id', '=', $id)
            ->where('result', '=', $result)
            ->count();

        $wins = $count('white', '1-0') + $count('black', '0-1');
        $losses = $count('white', '0-1') + $count('black', '1-0');
        $draws = $count('white', '1/2-1/2') + $count('black', '1/2-1/2');

        return [
            'wins' => $wins,
            'losses' => $losses,
            'draws' => $draws,
            'total' => $wins + $losses + $draws,
        ];
    }

    /**
     * "Playing now" — asks the realtime hub whether this account is currently
     * in a live game and, if so, what to link to. Fail-soft: any hub error or
     * unreachable hub (already handled inside {@see HubClient::livePlayer()},
     * which keeps a sub-second timeout) yields null here, never an exception —
     * a hub blip must never break or slow down the profile page.
     *
     * @return array{gameId: string, pool: string, opponent: array{name: string, title: ?string, rating: int}}|null
     */
    private function liveGame(string $id): ?array
    {
        try {
            $probe = $this->hub->livePlayer($id);
        } catch (\Throwable) {
            return null;
        }

        if (!($probe['live'] ?? false) || $probe['gameId'] === null || $probe['opponent'] === null) {
            return null;
        }

        return [
            'gameId' => $probe['gameId'],
            'pool' => (string) ($probe['pool'] ?? ''),
            'opponent' => $probe['opponent'],
        ];
    }

    /**
     * Per-pool rating history for the sparklines: one series per time-control /
     * Duck / Crazyhouse / Antichess pool (from Game rows) plus puzzle (from
     * PuzzleAttempt) and premove (from PremoveGame).
     * No schema change — every series is reconstructed from already-stored
     * rating-after values on the last HISTORY_POINTS rated results.
     *
     * @return array<string, list<int>>
     */
    private function ratingHistory(string $id): array
    {
        $out = [];
        foreach (self::HISTORY_CATEGORIES as $cat) {
            $out[$cat] = $this->categoryRatingSeries($id, $cat);
        }
        $out['puzzle'] = $this->puzzleRatingSeries($id);
        $out['premove'] = $this->premoveRatingSeries($id);

        return $out;
    }

    /**
     * The last HISTORY_POINTS rated ratings-after for one Game.category pool,
     * oldest first (chronological, for a left-to-right sparkline).
     *
     * @return list<int>
     */
    private function categoryRatingSeries(string $id, string $category): array
    {
        $games = Game::query()
            ->whereGroup(function ($g) use ($id): void {
                $g->where('white_user_id', '=', $id)->orWhere('black_user_id', '=', $id);
            })
            ->where('category', '=', $category)
            ->where('rated', '=', true)
            ->orderByDesc('created_at')
            ->limit(self::HISTORY_POINTS)
            ->get();

        $series = [];
        foreach ($games as $g) {
            $after = $g->white_user_id === $id ? $g->white_rating_after : $g->black_rating_after;
            if ($after !== null) {
                $series[] = $after;
            }
        }

        return array_reverse($series);
    }

    /**
     * The last HISTORY_POINTS puzzle-rating-after values, oldest first.
     *
     * @return list<int>
     */
    private function puzzleRatingSeries(string $id): array
    {
        $attempts = PuzzleAttempt::query()
            ->where('user_id', '=', $id)
            ->orderByDesc('created_at')
            ->limit(self::HISTORY_POINTS)
            ->get();

        $series = array_map(static fn (PuzzleAttempt $a): int => $a->rating_after, $attempts);

        return array_reverse($series);
    }

    /**
     * The last HISTORY_POINTS premove-trainer rating-after values, oldest first.
     * Only rated rows carry a rating_after (casual attempts and anonymous play
     * never touch the rating), so unrated/null rows are skipped rather than
     * poisoning the sparkline with nulls.
     *
     * @return list<int>
     */
    private function premoveRatingSeries(string $id): array
    {
        $games = PremoveGame::query()
            ->where('user_id', '=', $id)
            ->where('rated', '=', true)
            ->orderByDesc('created_at')
            ->limit(self::HISTORY_POINTS)
            ->get();

        $series = [];
        foreach ($games as $g) {
            if ($g->rating_after !== null) {
                $series[] = $g->rating_after;
            }
        }

        return array_reverse($series);
    }
}
