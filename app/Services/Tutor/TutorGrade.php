<?php

namespace App\Services\Tutor;

/**
 * Turns "your accuracy is 78.4%" into "well below other 1500s, and the biggest
 * single gap you have".
 *
 * A raw number is not advice. The grade is always relative to a peer band, and
 * the ranking decides which of a dozen true statements is the one worth
 * putting at the top of the page.
 *
 * The scale follows Lichess Tutor's, because it is well designed and there is
 * no reason to invent a second one: a grade in [-1, +1], seven verdict words,
 * and an importance score that multiplies the grade by the square root of the
 * evidence behind it. What we add is honesty about the evidence — every
 * comparison carries its own sample size and the percentile it sits at, so the
 * page can say how sure it is instead of implying certainty it doesn't have.
 */
class TutorGrade
{
    /**
     * Verdict thresholds on |grade|, strongest first. Anything below the
     * smallest threshold is "similar" — most comparisons land there, and
     * saying so plainly is better than manufacturing a difference.
     */
    public const array WORDING = [
        [1.00, 'much %s'],
        [0.40, '%s'],
        [0.20, 'slightly %s'],
    ];

    /**
     * Grade one measured value against a baseline cell.
     *
     * @param array{value: float, sample: int, weight: float} $mine
     * @param array{mean: float, sample: int, p10?: float, p25?: float, p50?: float, p75?: float, p90?: float} $peer
     * @return array{metric: string, dimension: string, label: string, mine: float, peer: float, sample: int, peerSample: int, grade: float, spread: float, wording: string, importance: float, percentile: int|null, higherIsBetter: bool, unit: string}
     */
    public function compare(string $metric, string $dimension, array $mine, array $peer): array
    {
        $def = TutorMetrics::METRICS[$metric] ?? [
            'label' => $metric,
            'higherIsBetter' => true,
            'level' => 'move',
            'scale' => 10.0,
            'unit' => 'percent',
        ];

        $delta = $mine['value'] - $peer['mean'];
        if (!$def['higherIsBetter']) {
            $delta = -$delta;
        }

        // The same direction-corrected ratio the grade is built from, but
        // BEFORE clamping. `grade` still drives wording/importance/ranking
        // exactly as before and is still clamped to [-1, 1] — `spread` is a
        // pure addition so the frontend meter has something that keeps moving
        // once `grade` has already hit the rail (still ~30% of rows even
        // after widening the scales in Task 1).
        $spread = $delta / max(0.001, $def['scale']);
        $grade = max(-1.0, min(1.0, $spread));

        // Evidence is the smaller of the two sides — a huge peer sample can't
        // rescue a comparison built on four of your games.
        $evidence = min($mine['sample'], $peer['sample']);
        $weight = TutorMetrics::LEVEL_WEIGHT[$def['level']] ?? 1;
        $importance = $grade * sqrt(max(0, $evidence) * $weight);

        return [
            'metric' => $metric,
            'dimension' => $dimension,
            'label' => $def['label'],
            'mine' => round($mine['value'], 2),
            'peer' => round($peer['mean'], 2),
            'sample' => $mine['sample'],
            'peerSample' => $peer['sample'],
            'grade' => round($grade, 4),
            'spread' => round($spread, 4),
            'wording' => $this->wordingFor($grade),
            'importance' => round($importance, 4),
            'percentile' => $this->percentileOf($mine['value'], $peer, (bool) $def['higherIsBetter']),
            'higherIsBetter' => (bool) $def['higherIsBetter'],
            'unit' => (string) $def['unit'],
        ];
    }

    /**
     * A single knot-to-knot jump taking this much of the total p10..p90 range
     * marks the cell as dominated by a point mass rather than a real spread.
     *
     * Measured over every plain `tutor_baseline` cell (dimension=''), the
     * share of the p10-p90 range taken by the single largest adjacent jump
     * splits cleanly in two:
     *
     *   accuracy 0.283, acpl 0.294, awareness 0.297, global_clock 0.336,
     *   clock_when_losing 0.414, performance 0.478   <- real spread
     *   win_rate 0.763, time_pressure 0.783, flagging_loss 0.998,
     *   resourcefulness 1.000, conversion 1.000       <- point mass
     *
     * The gap between 0.478 and 0.763 is wide and metric-agnostic, so 0.6
     * (computed from the knots themselves, not the metric name) keeps
     * classifying correctly if the baselines are re-imported from a new dump
     * with different numbers. Below this line the interpolation is real;
     * above it, at least one pair of adjacent quantiles is identical (a
     * degenerate 0/0/100/100/100-style cell), so any point "between" them is
     * an arbitrary rescaling between two identical endpoints, not a rank.
     */
    private const float POINT_MASS_SHARE = 0.6;

    /**
     * Where this value sits in the peer distribution, as a rough percentile.
     * Interpolated from the stored deciles/quartiles — precise enough to say
     * "bottom quarter of players at your level", which is the only claim the
     * UI makes with it. Returns null when the cell has no percentile data.
     *
     * @param array{p10?: float, p25?: float, p50?: float, p75?: float, p90?: float} $peer
     */
    public function percentileOf(float $value, array $peer, bool $higherIsBetter): ?int
    {
        $points = [];
        foreach ([10, 25, 50, 75, 90] as $p) {
            $key = 'p' . $p;
            if (isset($peer[$key]) && is_numeric($peer[$key])) {
                $points[$p] = (float) $peer[$key];
            }
        }

        if (count($points) < 2) {
            return null;
        }

        $pcts = array_keys($points);
        $vals = array_values($points);

        // A flat distribution means the cell was stored without percentiles
        // (dimension cells keep no reservoir — see the importer). Interpolating
        // it would manufacture a rank out of nothing.
        $totalRange = max($vals) - min($vals);
        if ($totalRange <= 0.0) {
            return null;
        }

        // Widen the same guard to a near-flat distribution: one point mass
        // dominating the range is just as meaningless to interpolate inside
        // as a fully flat one. See POINT_MASS_SHARE for the measured split.
        $maxGap = 0.0;
        for ($i = 0; $i < count($vals) - 1; $i++) {
            $maxGap = max($maxGap, $vals[$i + 1] - $vals[$i]);
        }
        if ($maxGap / $totalRange >= self::POINT_MASS_SHARE) {
            return null;
        }

        // The stored percentiles are always ascending in raw value. Find where
        // this value lands, then flip if lower is better.
        $rank = null;
        if ($value <= $vals[0]) {
            $rank = (float) $pcts[0];
        } elseif ($value >= $vals[count($vals) - 1]) {
            $rank = (float) $pcts[count($pcts) - 1];
        } else {
            for ($i = 0; $i < count($vals) - 1; $i++) {
                if ($value >= $vals[$i] && $value <= $vals[$i + 1]) {
                    $span = $vals[$i + 1] - $vals[$i];
                    $frac = $span <= 0.0 ? 0.0 : ($value - $vals[$i]) / $span;
                    $rank = $pcts[$i] + ($pcts[$i + 1] - $pcts[$i]) * $frac;
                    break;
                }
            }
        }

        if ($rank === null) {
            return null;
        }

        if (!$higherIsBetter) {
            $rank = 100.0 - $rank;
        }

        return (int) round(max(1.0, min(99.0, $rank)));
    }

    /**
     * Rank comparisons and pick the headline strengths and weaknesses.
     *
     * Only the ranked weaknesses get flagged red in the UI — every
     * below-average cell turning red is how a report becomes a wall of noise
     * that stops meaning anything.
     *
     * @param list<array{importance: float, grade: float}> $comparisons
     * @return array{strengths: list<array<string, mixed>>, weaknesses: list<array<string, mixed>>}
     */
    public function rank(array $comparisons, int $limit = 3): array
    {
        $strong = array_values(array_filter($comparisons, fn(array $c): bool => $c['importance'] > 0));
        $weak = array_values(array_filter($comparisons, fn(array $c): bool => $c['importance'] < 0));

        usort($strong, fn(array $a, array $b): int => $b['importance'] <=> $a['importance']);
        usort($weak, fn(array $a, array $b): int => $a['importance'] <=> $b['importance']);

        return [
            'strengths' => array_slice($strong, 0, $limit),
            'weaknesses' => array_slice($weak, 0, $limit),
        ];
    }

    public function wordingFor(float $grade): string
    {
        $magnitude = abs($grade);
        $direction = $grade > 0 ? 'better' : 'worse';

        foreach (self::WORDING as [$threshold, $template]) {
            if ($magnitude >= $threshold) {
                return sprintf($template, $direction);
            }
        }

        return 'similar';
    }
}
