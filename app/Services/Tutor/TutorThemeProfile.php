<?php

namespace App\Services\Tutor;

use App\Models\User;
use BaseApi\App;
use Throwable;

/**
 * How a player performs per tactical theme, measured from their puzzle history.
 *
 * This is the second, independent source of tactical evidence. The game-derived
 * `awareness` metric says whether a player punishes mistakes; this says WHICH
 * patterns they miss, by name, from a corpus where every position is already
 * tagged. Nobody else measures tactical weakness twice from two unrelated
 * sources, and it is what turns "your tactical awareness is weak" into a drill
 * on the exact themes involved.
 *
 * IMPORTANT — there is no peer comparison here, and the payload says so. The
 * imported Lichess puzzle set carries puzzle ratings but not other players'
 * per-theme solve rates, so "compared to other 1500s" is not a claim this data
 * can support. A player's own solve rate against the puzzle's own rating is
 * honest; inventing a peer number would not be.
 */
class TutorThemeProfile
{
    /** Below this many attempts a theme rate is noise, not a finding. */
    private const int MIN_ATTEMPTS = 6;

    /** Themes that describe puzzle SHAPE rather than a tactical pattern —
     *  drilling "short" or "oneMove" teaches nothing. */
    private const array STRUCTURAL = [
        'short', 'long', 'veryLong', 'oneMove', 'master', 'masterVsMaster',
        'crushing', 'advantage', 'equality', 'mate', 'middlegame', 'opening', 'endgame',
    ];

    /**
     * @return array{themes: list<array<string, mixed>>, attempts: int, comparable: bool, note: string}
     */
    public function forUser(User $user): array
    {
        try {
            $rows = App::db()->raw(
                'SELECT pt.theme,
                        COUNT(*) AS attempts,
                        SUM(CASE WHEN pa.solved = 1 THEN 1 ELSE 0 END) AS solved,
                        AVG(p.rating) AS avg_rating
                 FROM puzzle_attempt pa
                 JOIN puzzle_theme pt ON pt.puzzle_id = pa.puzzle_id
                 JOIN puzzle p ON p.id = pa.puzzle_id
                 WHERE pa.user_id = ?
                 GROUP BY pt.theme
                 HAVING attempts >= ?
                 ORDER BY attempts DESC',
                [$user->id, self::MIN_ATTEMPTS],
            );
        } catch (Throwable $e) {
            error_log('[tutor] theme profile failed: ' . $e->getMessage());

            return ['themes' => [], 'attempts' => 0, 'comparable' => false, 'note' => ''];
        }

        $themes = [];
        $total = 0;

        foreach ($rows as $row) {
            $theme = (string) $row['theme'];
            $attempts = (int) $row['attempts'];
            $solved = (int) $row['solved'];
            $total += $attempts;

            if (in_array($theme, self::STRUCTURAL, true)) {
                continue;
            }

            $themes[] = [
                'theme' => $theme,
                'attempts' => $attempts,
                'solved' => $solved,
                'rate' => round(100.0 * $solved / max(1, $attempts), 1),
                'avgPuzzleRating' => (int) round((float) $row['avg_rating']),
            ];
        }

        // Weakest first — this list exists to be acted on, and the point of it
        // is what to drill.
        usort($themes, fn(array $a, array $b): int => $a['rate'] <=> $b['rate']);

        return [
            'themes' => $themes,
            'attempts' => $total,
            'comparable' => false,
            'note' => $themes === []
                ? sprintf('Solve at least %d puzzles in a theme and it will show up here.', self::MIN_ATTEMPTS)
                : 'Your own solve rate per theme. There is no peer number here — the puzzle set carries puzzle ratings, not other players’ per-theme results, so a comparison would be invented rather than measured.',
        ];
    }

    /**
     * The weakest themes worth drilling, for the drill builder.
     *
     * @return list<string>
     */
    public function weakThemes(User $user, int $limit = 6): array
    {
        $profile = $this->forUser($user);

        $weak = array_filter(
            $profile['themes'],
            fn(array $t): bool => $t['rate'] < 60.0,
        );

        return array_slice(array_column($weak, 'theme'), 0, $limit);
    }
}
