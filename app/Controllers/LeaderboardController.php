<?php

namespace App\Controllers;

use BaseApi\App;
use BaseApi\Controllers\Controller;
use BaseApi\Http\JsonResponse;
use App\Services\Glicko2Service;

/**
 * Public leaderboard — the top-rated players for one rating category.
 *
 *   GET /leaderboard?category=blitz&limit=10
 *   → { category, entries: [ { rank, id, name, title, rating, games, provisional }, ... ] }
 *
 * Categories are the Glicko-2 pools on the User model: the four time controls
 * plus the isolated puzzle and variant pools. The category drives interpolated SQL column
 * names (rating_<cat> / rd_<cat> / games_<cat>), so it is STRICTLY whitelisted
 * — any other value is rejected, never interpolated.
 *
 * Default-1500 accounts that have never played the category are filtered out
 * (games_<cat> > 0) so they can't top the board. The response is hand-built to
 * stay public-safe — the User model is never serialized (it would leak email).
 */
class LeaderboardController extends Controller
{
    /** Whitelisted rating pools — the ONLY values allowed into the column names.
     *  'crazyhouse' was a pre-existing gap (it has a rating category on User but
     *  was never listed here) — fixed as a drive-by alongside adding 'premove'. */
    private const CATEGORIES = ['bullet', 'blitz', 'rapid', 'classical', 'puzzle', 'chess960', 'duck', 'crazyhouse', 'antichess', 'secretqueen', 'premove'];

    /** Bound from ?category= ; one of CATEGORIES. */
    public string $category = 'blitz';

    /** Bound from ?limit= ; clamped to 1..50. */
    public int $limit = 10;

    public function get(): JsonResponse
    {
        $category = trim($this->category);
        if (!in_array($category, self::CATEGORIES, true)) {
            return JsonResponse::badRequest('Invalid category');
        }

        $limit = max(1, min(50, $this->limit));

        // $category is whitelisted above, so it's safe to interpolate into the
        // column names; the limit is a clamped int. The filter is parameterized.
        $ratingCol = 'rating_' . $category;
        $rdCol = 'rd_' . $category;
        $gamesCol = 'games_' . $category;

        // title + role are pulled in the same query (no per-row lookup) so the
        // derived display title (a stored title, else "AM" for admins — see
        // User::displayTitle()) can be computed inline below.
        //
        // Bot accounts (role='bot', see scripts/seed_bot_accounts.php) are
        // deliberately excluded here: they're seeded to fill out Arena rosters
        // (ArenaInternalController), not to hold a permanent slot on the
        // site-wide "best players" ranking. Their ratings never move (Elo is
        // never applied to a bot side — see GameResultController), so a bot
        // sitting on this board would be a frozen, non-competing entry forever
        // — unlike an arena's own standings, which are legitimately meant to
        // include whichever bots were seated in that specific tournament.
        $sql = "SELECT id, name, title, role, $ratingCol AS rating, $rdCol AS rd, $gamesCol AS games
                FROM user
                WHERE $gamesCol > 0 AND role != 'bot'
                ORDER BY $ratingCol DESC
                LIMIT $limit";
        $rows = App::db()->raw($sql, []);

        $entries = [];
        $rank = 1;
        foreach ($rows as $row) {
            $title = $row['title'] ?? null;
            $entries[] = [
                'rank' => $rank,
                'id' => (string) ($row['id'] ?? ''),
                'name' => (string) ($row['name'] ?? ''),
                'title' => $title !== null && $title !== '' ? $title : (($row['role'] ?? '') === 'admin' ? 'AM' : null),
                'rating' => (int) ($row['rating'] ?? 0),
                'games' => (int) ($row['games'] ?? 0),
                'provisional' => ((float) ($row['rd'] ?? 0.0)) > Glicko2Service::PROVISIONAL_RD,
            ];
            $rank++;
        }

        return JsonResponse::ok([
            'category' => $category,
            'entries' => $entries,
        ]);
    }
}
