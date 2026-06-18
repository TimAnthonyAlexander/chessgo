<?php

namespace App\Services;

/**
 * Elo ratings, per time-control category (Lichess-style). Categories are derived
 * from the pool's estimated duration (base seconds + 40·increment), and the
 * K-factor is provisional (high) for a player's first games, then settles.
 *
 * Ratings are stored on the User as rating_<category> / games_<category>.
 */
class EloService
{
    private const START = 1500;

    private const PROVISIONAL_GAMES = 20;

    private const K_PROVISIONAL = 40;

    private const K_STABLE = 20;

    /** All categories, matching the User rating_/games_ column suffixes. */
    public const CATEGORIES = ['bullet', 'blitz', 'rapid', 'classical'];

    /**
     * Map a pool ("3+0", "10+5", …) to a rating category by estimated game
     * duration, mirroring Lichess (UltraBullet is folded into bullet here).
     */
    public function categoryForPool(string $pool): string
    {
        [$baseMin, $incSec] = $this->parsePool($pool);
        $estSeconds = $baseMin * 60 + 40 * $incSec;

        return match (true) {
            $estSeconds < 180 => 'bullet',
            $estSeconds < 480 => 'blitz',
            $estSeconds < 1500 => 'rapid',
            default => 'classical',
        };
    }

    /** Expected score for A against B (0..1). */
    public function expected(int $ratingA, int $ratingB): float
    {
        return 1.0 / (1.0 + 10 ** (($ratingB - $ratingA) / 400.0));
    }

    /**
     * New rating after a game. $score is 1 (win), 0.5 (draw), or 0 (loss);
     * $gamesPlayed is the count BEFORE this game (selects the K-factor).
     */
    public function newRating(int $rating, int $opponentRating, float $score, int $gamesPlayed): int
    {
        $k = $gamesPlayed < self::PROVISIONAL_GAMES ? self::K_PROVISIONAL : self::K_STABLE;
        $expected = $this->expected($rating, $opponentRating);

        return (int) round($rating + $k * ($score - $expected));
    }

    public function startRating(): int
    {
        return self::START;
    }

    /**
     * @return array{0:int,1:int} [baseMinutes, incrementSeconds]
     */
    private function parsePool(string $pool): array
    {
        $plus = strpos($pool, '+');
        if ($plus === false) {
            return [0, 0];
        }

        return [
            (int) substr($pool, 0, $plus),
            (int) substr($pool, $plus + 1),
        ];
    }
}
