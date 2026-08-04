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
     * @return array{metric: string, dimension: string, label: string, mine: float, peer: float, sample: int, peerSample: int, grade: float, wording: string, importance: float, percentile: int|null, higherIsBetter: bool, unit: string}
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

        $grade = max(-1.0, min(1.0, $delta / max(0.001, $def['scale'])));

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
            'wording' => $this->wordingFor($grade),
            'importance' => round($importance, 4),
            'percentile' => $this->percentileOf($mine['value'], $peer, (bool) $def['higherIsBetter']),
            'higherIsBetter' => (bool) $def['higherIsBetter'],
            'unit' => (string) $def['unit'],
        ];
    }

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
