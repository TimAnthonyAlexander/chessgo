<?php

namespace App\Tests\Unit;

use App\Services\Glicko2Service;
use PHPUnit\Framework\TestCase;

class Glicko2ServiceTest extends TestCase
{
    private Glicko2Service $g;

    protected function setUp(): void
    {
        $this->g = new Glicko2Service();
    }

    /**
     * The canonical worked example from Glickman's "Example of the Glicko-2
     * system" paper: a player at 1500 / RD 200 / vol 0.06, tau 0.5, plays one
     * rating period of three games (win vs 1400/30, loss vs 1550/100, loss vs
     * 1700/300). Published result: r' ≈ 1464.05, RD' ≈ 151.52, σ' ≈ 0.05999.
     */
    public function test_canonical_glickman_example(): void
    {
        [$rating, $rd, $vol] = $this->g->update(1500.0, 200.0, 0.06, [
            ['rating' => 1400.0, 'rd' => 30.0,  'score' => 1.0],
            ['rating' => 1550.0, 'rd' => 100.0, 'score' => 0.0],
            ['rating' => 1700.0, 'rd' => 300.0, 'score' => 0.0],
        ]);

        $this->assertEqualsWithDelta(1464.05, $rating, 0.05);
        $this->assertEqualsWithDelta(151.52, $rd, 0.05);
        $this->assertEqualsWithDelta(0.05999, $vol, 0.0001);
    }

    public function test_new_player_swings_far_more_than_settled_player(): void
    {
        // Same single loss to an equal opponent: a fresh high-RD player moves
        // far more than a settled low-RD player.
        [$freshRating] = $this->g->update(1500.0, 350.0, 0.06, [
            ['rating' => 1500.0, 'rd' => 50.0, 'score' => 0.0],
        ]);
        [$settledRating] = $this->g->update(1500.0, 45.0, 0.06, [
            ['rating' => 1500.0, 'rd' => 50.0, 'score' => 0.0],
        ]);

        $freshDrop = 1500.0 - $freshRating;
        $settledDrop = 1500.0 - $settledRating;

        $this->assertGreaterThan($settledDrop * 3, $freshDrop);
    }

    public function test_rd_decreases_after_a_game(): void
    {
        [, $rd] = $this->g->update(1500.0, 350.0, 0.06, [
            ['rating' => 1500.0, 'rd' => 50.0, 'score' => 1.0],
        ]);

        $this->assertLessThan(350.0, $rd);
    }

    public function test_win_raises_loss_lowers_rating(): void
    {
        [$afterWin] = $this->g->update(1500.0, 100.0, 0.06, [
            ['rating' => 1500.0, 'rd' => 100.0, 'score' => 1.0],
        ]);
        [$afterLoss] = $this->g->update(1500.0, 100.0, 0.06, [
            ['rating' => 1500.0, 'rd' => 100.0, 'score' => 0.0],
        ]);

        $this->assertGreaterThan(1500.0, $afterWin);
        $this->assertLessThan(1500.0, $afterLoss);
    }

    public function test_provisional_threshold_is_rd_above_110(): void
    {
        $this->assertTrue($this->g->provisional(110.01));
        $this->assertFalse($this->g->provisional(110.0));
        $this->assertFalse($this->g->provisional(60.0));
        $this->assertTrue($this->g->provisional(Glicko2Service::START_RD));
    }

    public function test_inactivity_inflates_rd_and_is_capped(): void
    {
        // A settled player's RD climbs back toward provisional over idle time,
        // and never exceeds the 350 cap.
        $settled = 60.0;

        $this->assertSame($settled, $this->g->inflateRd($settled, 0.0));
        $this->assertGreaterThan($settled, $this->g->inflateRd($settled, 30.0));

        // ~1 year idle pushes a just-established player (RD≈110) back above the
        // provisional threshold.
        $this->assertGreaterThan(
            Glicko2Service::PROVISIONAL_RD,
            $this->g->inflateRd(Glicko2Service::PROVISIONAL_RD, 365.0),
        );

        // Capped at START_RD no matter how long the idle gap.
        $this->assertEqualsWithDelta(
            Glicko2Service::START_RD,
            $this->g->inflateRd(200.0, 100000.0),
            0.0001,
        );
    }

    public function test_category_for_pool(): void
    {
        $this->assertSame('bullet', $this->g->categoryForPool('1+0'));
        $this->assertSame('blitz', $this->g->categoryForPool('5+0'));
        $this->assertSame('rapid', $this->g->categoryForPool('10+0'));
        $this->assertSame('classical', $this->g->categoryForPool('30+0'));
    }
}
