<?php

namespace App\Tests\Unit;

use App\Services\Tutor\TutorGrade;
use PHPUnit\Framework\TestCase;

/**
 * Tests the STATED intent of TutorGrade: a [-1,+1] grade relative to a peer
 * baseline, direction-aware for higherIsBetter metrics, seven verdict words,
 * an evidence-scaled importance score, and percentile/ranking helpers.
 */
class TutorGradeTest extends TestCase
{
    private TutorGrade $g;

    protected function setUp(): void
    {
        $this->g = new TutorGrade();
    }

    // --- 1. wordingFor at every threshold boundary --------------------------

    public function test_wording_for_thresholds_both_signs(): void
    {
        // WORDING = [[1.00, 'much %s'], [0.40, '%s'], [0.20, 'slightly %s']].
        $cases = [
            // [grade, expected wording]
            [1.00, 'much better'],
            [-1.00, 'much worse'],
            [1.50, 'much better'], // above the top threshold still reads "much"
            [0.9999, 'better'], // just below 1.00 falls to the next bucket
            [-0.9999, 'worse'],
            [0.40, 'better'],
            [-0.40, 'worse'],
            [0.3999, 'slightly better'], // just below 0.40
            [-0.3999, 'slightly worse'],
            [0.20, 'slightly better'],
            [-0.20, 'slightly worse'],
            [0.1999, 'similar'], // just below 0.20 — no verdict word at all
            [-0.1999, 'similar'],
            [0.0, 'similar'],
        ];

        foreach ($cases as [$grade, $expected]) {
            $this->assertSame($expected, $this->g->wordingFor($grade), "wordingFor($grade) must be \"$expected\"");
        }
    }

    // --- 2. compare() respects higherIsBetter -------------------------------

    public function test_compare_lower_is_better_metric_below_peer_mean_gives_positive_grade(): void
    {
        // acpl is higherIsBetter=false. A player averaging 20cp loss against
        // a peer average of 40cp loss is BETTER — the grade must be
        // POSITIVE, even though 20 < 40 numerically.
        $result = $this->g->compare(
            'acpl',
            '',
            ['value' => 20.0, 'sample' => 10, 'weight' => 10.0],
            ['mean' => 40.0, 'sample' => 10],
        );

        $this->assertGreaterThan(
            0.0,
            $result['grade'],
            'acpl (lower is better): a value BELOW the peer mean must produce a POSITIVE grade — this is the single easiest thing to get backwards',
        );
        // (40-20 flipped) / scale(25) = 20/25 = 0.8, exactly.
        $this->assertEqualsWithDelta(0.8, $result['grade'], 0.0001, 'exact grade check for the lower-is-better flip');
    }

    public function test_compare_lower_is_better_metric_above_peer_mean_gives_negative_grade(): void
    {
        // Now the player is WORSE than peers (60cp loss vs a 40cp average) —
        // the grade must be negative.
        $result = $this->g->compare(
            'acpl',
            '',
            ['value' => 60.0, 'sample' => 10, 'weight' => 10.0],
            ['mean' => 40.0, 'sample' => 10],
        );

        $this->assertLessThan(0.0, $result['grade'], 'acpl: a value ABOVE the peer mean (more loss) must produce a NEGATIVE grade');
        $this->assertEqualsWithDelta(-0.8, $result['grade'], 0.0001);
    }

    public function test_compare_higher_is_better_metric_above_peer_mean_gives_positive_grade(): void
    {
        // Sanity check on the un-flipped direction: win_rate is
        // higherIsBetter=true, so scoring above the peer mean must be positive.
        $result = $this->g->compare(
            'win_rate',
            '',
            ['value' => 60.0, 'sample' => 10, 'weight' => 10.0],
            ['mean' => 50.0, 'sample' => 10],
        );

        $this->assertGreaterThan(0.0, $result['grade'], 'win_rate: scoring above the peer mean must produce a positive grade with no flip needed');
    }

    // --- 3. grade is clamped to [-1, 1] -----------------------------------

    public function test_grade_is_clamped_to_unit_range(): void
    {
        $farBetter = $this->g->compare(
            'acpl',
            '',
            ['value' => -1000.0, 'sample' => 10, 'weight' => 10.0], // absurdly good, way past 1.0 worth of scale
            ['mean' => 40.0, 'sample' => 10],
        );
        $this->assertSame(1.0, $farBetter['grade'], 'grade must clamp at +1.0 no matter how far above scale the delta is');

        $farWorse = $this->g->compare(
            'acpl',
            '',
            ['value' => 5000.0, 'sample' => 10, 'weight' => 10.0], // absurdly bad
            ['mean' => 40.0, 'sample' => 10],
        );
        $this->assertSame(-1.0, $farWorse['grade'], 'grade must clamp at -1.0 no matter how far below scale the delta is');
    }

    // --- 4. importance uses min sample and scales with level weight --------

    public function test_importance_uses_the_smaller_sample_size(): void
    {
        // mine has far more games than peer — evidence must be capped by the
        // SMALLER (peer) sample, not the average or the larger one.
        $result = $this->g->compare(
            'win_rate',
            '',
            ['value' => 60.0, 'sample' => 10_000, 'weight' => 10_000.0],
            ['mean' => 50.0, 'sample' => 5],
        );

        // importance = grade * sqrt(evidence * levelWeight); evidence=min(10000,5)=5, level='game' weight=35.
        $expectedGrade = min(1.0, (60.0 - 50.0) / 10.0); // scale for win_rate is 10.0
        $expectedImportance = round($expectedGrade * sqrt(5 * 35), 4);

        $this->assertEqualsWithDelta($expectedImportance, $result['importance'], 0.0001, 'importance must be driven by the SMALLER of the two sample sizes (5, not 10000)');
    }

    public function test_importance_scales_with_sqrt_of_evidence_times_level_weight(): void
    {
        // Two metrics engineered to have the SAME grade (0.5) and the SAME
        // evidence (min sample = 15), but different levels: win_rate is
        // game-level (weight 35), accuracy is move-level (weight 1). At
        // equal grade and evidence, the game-level metric must outrank the
        // move-level one.
        $winRate = $this->g->compare(
            'win_rate', // scale 10, level 'game'
            '',
            ['value' => 55.0, 'sample' => 20, 'weight' => 20.0],
            ['mean' => 50.0, 'sample' => 15],
        );
        $accuracy = $this->g->compare(
            'accuracy', // scale 8, level 'move'
            '',
            ['value' => 84.0, 'sample' => 20, 'weight' => 20.0],
            ['mean' => 80.0, 'sample' => 15],
        );

        $this->assertEqualsWithDelta(0.5, $winRate['grade'], 0.0001, 'sanity: win_rate grade engineered to 0.5 ((55-50)/10)');
        $this->assertEqualsWithDelta(0.5, $accuracy['grade'], 0.0001, 'sanity: accuracy grade engineered to 0.5 ((84-80)/8)');

        $expectedWinRateImportance = round(0.5 * sqrt(15 * 35), 4);
        $expectedAccuracyImportance = round(0.5 * sqrt(15 * 1), 4);

        $this->assertEqualsWithDelta($expectedWinRateImportance, $winRate['importance'], 0.0001);
        $this->assertEqualsWithDelta($expectedAccuracyImportance, $accuracy['importance'], 0.0001);
        $this->assertGreaterThan(
            $accuracy['importance'],
            $winRate['importance'],
            'at equal grade and equal evidence, a game-level metric (weight 35) must outrank a move-level one (weight 1) via sqrt(evidence * levelWeight)',
        );
    }

    // --- 5. percentileOf -----------------------------------------------

    private const PEER_DECILES = ['p10' => 10.0, 'p25' => 20.0, 'p50' => 30.0, 'p75' => 40.0, 'p90' => 50.0];

    public function test_percentile_of_interpolates_between_stored_deciles(): void
    {
        // value=25 sits between p25 (20) and p50 (30): frac = (25-20)/(30-20) = 0.5
        // rank = 25 + (50-25)*0.5 = 37.5 -> rounds to 38.
        $rank = $this->g->percentileOf(25.0, self::PEER_DECILES, true);
        $this->assertSame(38, $rank, 'percentileOf must linearly interpolate between the two bracketing stored deciles');
    }

    public function test_percentile_of_flips_when_lower_is_better(): void
    {
        $higherIsBetterRank = $this->g->percentileOf(25.0, self::PEER_DECILES, true);
        $lowerIsBetterRank = $this->g->percentileOf(25.0, self::PEER_DECILES, false);

        $this->assertSame(38, $higherIsBetterRank);
        // The flip (100 - rawRank) happens BEFORE rounding, so this is not
        // simply 100 minus the already-rounded higherIsBetter result: raw
        // rank is 37.5 -> flipped to 62.5 -> rounds to 63, not 100-38=62.
        $this->assertSame(63, $lowerIsBetterRank, 'for a lower-is-better metric the raw rank must flip to 100 - rank before rounding');
    }

    public function test_percentile_of_clamps_and_handles_edges(): void
    {
        // Below the smallest stored decile: rank pins to the smallest
        // decile's own percentile (10), which is within [1,99].
        $below = $this->g->percentileOf(-1000.0, self::PEER_DECILES, true);
        $this->assertSame(10, $below);
        $this->assertGreaterThanOrEqual(1, $below);
        $this->assertLessThanOrEqual(99, $below);

        // Above the largest stored decile: pins to that decile's percentile (90).
        $above = $this->g->percentileOf(1_000_000.0, self::PEER_DECILES, true);
        $this->assertSame(90, $above);
        $this->assertGreaterThanOrEqual(1, $above);
        $this->assertLessThanOrEqual(99, $above);

        // Every possible result must stay within the documented [1,99] band,
        // including after the lower-is-better flip at the extremes.
        $belowFlipped = $this->g->percentileOf(-1000.0, self::PEER_DECILES, false);
        $aboveFlipped = $this->g->percentileOf(1_000_000.0, self::PEER_DECILES, false);
        foreach ([$below, $above, $belowFlipped, $aboveFlipped] as $r) {
            $this->assertGreaterThanOrEqual(1, $r, 'percentileOf must never return below 1');
            $this->assertLessThanOrEqual(99, $r, 'percentileOf must never return above 99');
        }
    }

    public function test_percentile_of_returns_null_with_insufficient_data(): void
    {
        $this->assertNull($this->g->percentileOf(25.0, [], true), 'no stored deciles at all must return null');
        $this->assertNull($this->g->percentileOf(25.0, ['p50' => 30.0], true), 'a single stored decile is not enough to interpolate — must return null');
    }

    // --- 6. rank() -------------------------------------------------------

    public function test_rank_sorts_strengths_descending_and_weaknesses_ascending(): void
    {
        $comparisons = [
            ['metric' => 'a', 'importance' => 2.0, 'grade' => 0.2],
            ['metric' => 'b', 'importance' => 9.0, 'grade' => 0.9],
            ['metric' => 'c', 'importance' => 5.0, 'grade' => 0.5],
            ['metric' => 'd', 'importance' => -3.0, 'grade' => -0.3],
            ['metric' => 'e', 'importance' => -8.0, 'grade' => -0.8],
            ['metric' => 'f', 'importance' => -1.0, 'grade' => -0.1],
            ['metric' => 'g', 'importance' => 0.0, 'grade' => 0.0], // neither strength nor weakness
        ];

        $ranked = $this->g->rank($comparisons, 10);

        $this->assertSame(['b', 'c', 'a'], array_column($ranked['strengths'], 'metric'), 'strengths must be sorted most-positive-importance first');
        $this->assertSame(['e', 'd', 'f'], array_column($ranked['weaknesses'], 'metric'), 'weaknesses must be sorted most-negative-importance first');

        foreach (array_merge($ranked['strengths'], $ranked['weaknesses']) as $c) {
            $this->assertNotSame('g', $c['metric'], 'a zero-importance comparison must appear in neither list');
        }
    }

    public function test_rank_respects_the_limit(): void
    {
        $comparisons = [];
        for ($i = 1; $i <= 10; $i++) {
            $comparisons[] = ['metric' => "s$i", 'importance' => (float) $i, 'grade' => 0.1 * $i];
            $comparisons[] = ['metric' => "w$i", 'importance' => -(float) $i, 'grade' => -0.1 * $i];
        }

        $ranked = $this->g->rank($comparisons, 3);

        $this->assertCount(3, $ranked['strengths'], 'strengths must be truncated to the given limit');
        $this->assertCount(3, $ranked['weaknesses'], 'weaknesses must be truncated to the given limit');
        $this->assertSame(['s10', 's9', 's8'], array_column($ranked['strengths'], 'metric'), 'the top-3 by importance must be kept, most-positive first');
        $this->assertSame(['w10', 'w9', 'w8'], array_column($ranked['weaknesses'], 'metric'), 'the bottom-3 by importance must be kept, most-negative first');
    }

    public function test_rank_never_puts_a_positive_importance_item_in_weaknesses(): void
    {
        $comparisons = [
            ['metric' => 'strong', 'importance' => 4.0, 'grade' => 0.4],
            ['metric' => 'weak', 'importance' => -4.0, 'grade' => -0.4],
        ];

        $ranked = $this->g->rank($comparisons, 10);

        foreach ($ranked['weaknesses'] as $c) {
            $this->assertLessThan(0.0, $c['importance'], 'no positive-importance comparison may ever land in the weaknesses list');
        }
        foreach ($ranked['strengths'] as $c) {
            $this->assertGreaterThan(0.0, $c['importance'], 'no negative-importance comparison may ever land in the strengths list');
        }
    }
}
