<?php

namespace App\Tests\Unit;

use App\Services\Tutor\TutorBuildService;
use PHPUnit\Framework\TestCase;
use ReflectionClass;

/**
 * Tests the dimension sample gate documented on
 * TutorBuildService::MIN_DIMENSION_GAMES: a comparison for one opening,
 * phase, or piece must not be shown at all below a minimum number of the
 * PLAYER'S OWN games, because a confident-sounding verdict ("much worse at
 * the Caro-Kann") from a single game is noise dressed as a finding — the
 * exact failure docs/tasks/open/tutor.md's "How this goes wrong" section
 * names by name.
 *
 * dimensionSampleGate() is pure (no DB, no engine) and private, so it's
 * exercised directly through reflection, the same pattern TutorMetricsTest
 * uses for TutorMetrics::moverEval() and GameAnalysisService::accuracy().
 * TutorBuildService itself is not constructed — newInstanceWithoutConstructor
 * skips its DB-touching dependencies (TutorGameReader, TutorBaselineReader,
 * NotificationService, ...), none of which the method under test calls.
 */
class TutorBuildServiceTest extends TestCase
{
    private object $service;

    protected function setUp(): void
    {
        $this->service = (new ReflectionClass(TutorBuildService::class))->newInstanceWithoutConstructor();
    }

    private function gate(string $dimension, int $sample): bool
    {
        $method = (new ReflectionClass(TutorBuildService::class))->getMethod('dimensionSampleGate');
        $method->setAccessible(true);

        return $method->invoke($this->service, $dimension, $sample);
    }

    // --- 1. the floor itself -------------------------------------------

    public function test_min_dimension_games_is_documented_as_4(): void
    {
        // Pin the constant so a change to the floor is a deliberate, visible
        // edit to this test, not a silent drift.
        $this->assertSame(4, TutorBuildService::MIN_DIMENSION_GAMES, 'MIN_DIMENSION_GAMES must be 4, matching its docblock justification');
    }

    // --- 2. plain (non-dimension) metrics are never gated here ----------

    public function test_plain_metrics_always_pass_regardless_of_sample(): void
    {
        // Empty dimension = a plain metric (accuracy, conversion, ...).
        // Those are already covered by the 20-game category minimum before
        // buildCategory() runs, so this gate must never additionally block
        // them — even at a sample as low as 1.
        $this->assertTrue($this->gate('', 1), 'a plain metric (empty dimension) must pass this gate at any sample size');
        $this->assertTrue($this->gate('', 0), 'a plain metric must pass even at sample 0 — this gate only concerns dimension slices');
    }

    // --- 3. dimension comparisons are gated on the player's OWN sample --

    public function test_dimension_comparison_below_floor_is_rejected(): void
    {
        $this->assertFalse($this->gate('opening:w:Caro-Kann Defense', 1), 'one game must not be enough to show an opening comparison — this is the exact reported bug ("much worse", n=1)');
        $this->assertFalse($this->gate('opening:w:Indian Defense', 2), 'two games must still be below the floor');
        $this->assertFalse($this->gate('opening:w:English Opening', 3), 'three games must still be below the floor');
        $this->assertFalse($this->gate('phase:endgame', 3), 'the gate applies to phase dimensions too, not only openings');
        $this->assertFalse($this->gate('piece:Q', 3), 'the gate applies to piece dimensions too, not only openings');
    }

    public function test_dimension_comparison_at_or_above_floor_is_allowed(): void
    {
        $this->assertTrue($this->gate('opening:w:Sicilian Defense', 4), 'exactly MIN_DIMENSION_GAMES games must pass');
        $this->assertTrue($this->gate('opening:w:Sicilian Defense', 40), 'well above the floor must pass');
    }

    public function test_gate_reads_the_games_sample_not_the_moves_weight(): void
    {
        // TutorMetrics::aggregate()'s `sample` counts entries (one per game,
        // for every dimension key perGame() emits), while `weight` is a
        // moves/outcome weight. This gate must be called with `sample` — a
        // single 80-move game must NOT be able to satisfy a 4-GAME floor by
        // virtue of a large `weight`. This test only pins the gate's own
        // int-in/bool-out contract (it takes a sample count directly); the
        // "callers must pass sample, not weight" half is enforced by
        // reading TutorBuildService::buildCategory(), which calls
        // dimensionSampleGate($dimension, (int) ($mine['sample'] ?? 0)).
        $this->assertFalse($this->gate('opening:w:Caro-Kann Defense', 1), 'a sample of 1 (one game, however many moves it had) must fail the floor');
    }
}
