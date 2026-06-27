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
 *   → { category, entries: [ { rank, id, name, rating, games, provisional }, ... ] }
 *
 * Categories are the Glicko-2 pools on the User model: the four time controls
 * plus the isolated puzzle pool. The category drives interpolated SQL column
 * names (rating_<cat> / rd_<cat> / games_<cat>), so it is STRICTLY whitelisted
 * — any other value is rejected, never interpolated.
 *
 * Default-1500 accounts that have never played the category are filtered out
 * (games_<cat> > 0) so they can't top the board. The response is hand-built to
 * stay public-safe — the User model is never serialized (it would leak email).
 */
class LeaderboardController extends Controller
{
    /** Whitelisted rating pools — the ONLY values allowed into the column names. */
    private const CATEGORIES = ['bullet', 'blitz', 'rapid', 'classical', 'puzzle'];

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

        $sql = "SELECT id, name, $ratingCol AS rating, $rdCol AS rd, $gamesCol AS games
                FROM user
                WHERE $gamesCol > 0
                ORDER BY $ratingCol DESC
                LIMIT $limit";
        $rows = App::db()->raw($sql, []);

        $entries = [];
        $rank = 1;
        foreach ($rows as $row) {
            $entries[] = [
                'rank' => $rank,
                'id' => (string) ($row['id'] ?? ''),
                'name' => (string) ($row['name'] ?? ''),
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
