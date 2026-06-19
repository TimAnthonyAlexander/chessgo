<?php

namespace App\Services;

/**
 * Glicko-2 ratings, per time-control category (Lichess-style). Each category
 * tracks three numbers per player:
 *
 *   - rating  the skill estimate (display scale, anchored at 1500)
 *   - RD      rating deviation — the system's *uncertainty* about that estimate
 *   - vol     volatility — how erratic the player's results have been
 *
 * A new account starts at 1500 / RD 350 / vol 0.06: the system is very unsure,
 * so the first results swing the rating hundreds of points. Each game shrinks
 * RD (more confidence ⇒ smaller future moves); idle time grows it back. Once
 * RD ≤ 110 the rating is "established" (no longer provisional).
 *
 * Unlike batched Glicko-2, chessgo rates **one game at a time** (no rating
 * periods), matching Lichess: `update()` takes the opponents faced "this period"
 * and the controllers pass a single game. Inactivity is handled separately by
 * `inflateRd()` (time-based RD growth) rather than period counting.
 *
 * Ratings are stored on the User as rating_<cat> / rd_<cat> / vol_<cat> /
 * rated_at_<cat>, with games_<cat> kept for display.
 *
 * Reference: Glickman, "Example of the Glicko-2 system" (the constants and
 * formulae below follow that paper; `test_canonical_glickman_example` pins the
 * implementation to its published worked example).
 */
class Glicko2Service
{
    public const START = 1500;

    public const START_RD = 350.0;

    public const START_VOL = 0.06;

    /** RD at or below this is "established"; above it the rating is provisional. */
    public const PROVISIONAL_RD = 110.0;

    /** RD never exceeds this (a fully-uncertain rating). */
    public const MAX_RD = 350.0;

    /** System constant τ: constrains how much volatility can change per game. */
    private const TAU = 0.5;

    /** Glicko-2 internal scale factor (display ↔ μ/φ). */
    private const SCALE = 173.7178;

    /** Convergence tolerance for the volatility iteration. */
    private const EPSILON = 0.000001;

    /** All time-control categories, matching the User rating_/rd_/vol_ suffixes. */
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

    public function startRating(): int
    {
        return self::START;
    }

    /** A rating is provisional (shown with "?") while its RD exceeds 110. */
    public function provisional(float $rd): bool
    {
        return $rd > self::PROVISIONAL_RD;
    }

    /**
     * Grow RD for time spent idle since the last rated game. The rating *number*
     * is untouched — only the uncertainty rises, so the next games after a long
     * break move in bigger steps until RD settles again.
     *
     * The growth constant c is chosen so a just-established player (RD = 110)
     * climbs back to the full 350 over roughly a year of inactivity, then is
     * capped there.
     */
    public function inflateRd(float $rd, float $idleDays): float
    {
        if ($idleDays <= 0.0) {
            return $rd;
        }

        $c2 = (self::MAX_RD ** 2 - self::PROVISIONAL_RD ** 2) / 365.0;
        $grown = sqrt($rd * $rd + $c2 * $idleDays);

        return min($grown, self::MAX_RD);
    }

    /**
     * Apply one rating period for a player against the opponents faced in it.
     * chessgo passes a single game; the multi-opponent form is the general
     * Glicko-2 update (and is what the canonical test exercises).
     *
     * @param list<array{rating:float,rd:float,score:float}> $results
     *        opponents faced; score is 1 (win), 0.5 (draw), 0 (loss).
     * @return array{0:float,1:float,2:float} [rating, rd, vol] on the display scale.
     */
    public function update(float $rating, float $rd, float $vol, array $results): array
    {
        $mu = ($rating - self::START) / self::SCALE;
        $phi = $rd / self::SCALE;

        // No games this period: only the uncertainty grows (decay step).
        if ($results === []) {
            $phiStar = sqrt($phi * $phi + $vol * $vol);

            return [$rating, min(self::SCALE * $phiStar, self::MAX_RD), $vol];
        }

        // Estimated variance (v) and rating-change direction (Δ-sum).
        $vInv = 0.0;
        $deltaSum = 0.0;
        foreach ($results as $r) {
            $muJ = ($r['rating'] - self::START) / self::SCALE;
            $phiJ = $r['rd'] / self::SCALE;
            $g = $this->g($phiJ);
            $e = $this->e($mu, $muJ, $phiJ);

            $vInv += $g * $g * $e * (1.0 - $e);
            $deltaSum += $g * ($r['score'] - $e);
        }

        $v = 1.0 / $vInv;
        $delta = $v * $deltaSum;

        $newVol = $this->newVolatility($phi, $vol, $v, $delta);

        $phiStar = sqrt($phi * $phi + $newVol * $newVol);
        $newPhi = 1.0 / sqrt(1.0 / ($phiStar * $phiStar) + 1.0 / $v);
        $newMu = $mu + $newPhi * $newPhi * $deltaSum;

        $newRating = self::SCALE * $newMu + self::START;
        $newRd = min(self::SCALE * $newPhi, self::MAX_RD);

        return [$newRating, $newRd, $newVol];
    }

    /** g(φ): weights an opponent's result by how certain their rating is. */
    private function g(float $phi): float
    {
        return 1.0 / sqrt(1.0 + 3.0 * $phi * $phi / (M_PI * M_PI));
    }

    /** E(μ, μ_j, φ_j): expected score against opponent j. */
    private function e(float $mu, float $muJ, float $phiJ): float
    {
        return 1.0 / (1.0 + exp(-$this->g($phiJ) * ($mu - $muJ)));
    }

    /**
     * New volatility σ', solved via Glickman's Illinois-variant bisection on f(x).
     */
    private function newVolatility(float $phi, float $sigma, float $v, float $delta): float
    {
        $a = log($sigma * $sigma);
        $tau2 = self::TAU * self::TAU;
        $delta2 = $delta * $delta;
        $phi2 = $phi * $phi;

        $f = static function (float $x) use ($phi2, $v, $delta2, $a, $tau2): float {
            $ex = exp($x);
            $num = $ex * ($delta2 - $phi2 - $v - $ex);
            $den = 2.0 * ($phi2 + $v + $ex) ** 2;

            return ($num / $den) - (($x - $a) / $tau2);
        };

        // Bracket the root [A, B].
        $A = $a;
        if ($delta2 > $phi2 + $v) {
            $B = log($delta2 - $phi2 - $v);
        } else {
            $k = 1;
            while ($f($a - $k * self::TAU) < 0.0) {
                $k++;
            }

            $B = $a - $k * self::TAU;
        }

        $fA = $f($A);
        $fB = $f($B);

        // Illinois algorithm.
        while (abs($B - $A) > self::EPSILON) {
            $C = $A + ($A - $B) * $fA / ($fB - $fA);
            $fC = $f($C);

            if ($fC * $fB <= 0.0) {
                $A = $B;
                $fA = $fB;
            } else {
                $fA /= 2.0;
            }

            $B = $C;
            $fB = $fC;
        }

        return exp($A / 2.0);
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
