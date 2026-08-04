<?php

namespace App\Tests\Unit;

use App\Models\Game;
use App\Services\Tutor\TutorBuildService;
use PHPUnit\Framework\Attributes\DataProvider;
use PHPUnit\Framework\TestCase;
use ReflectionClass;

/**
 * Tests TutorBuildService::allocateAnalysisBudget() — the thing that decides
 * how long a Tutor report takes to build.
 *
 * The rule it replaces was a cap of 150 games PER CATEGORY, so a player active
 * in bullet, blitz, rapid and classical could ask one report for 600 engine
 * analyses. At the measured 3-6 seconds a game that is 30-60 minutes, which is
 * too long behind a queue and monopolises the engine's search pool against
 * live play. The budget is now for the whole report, split proportionally.
 *
 * Four properties are load-bearing, and each has tests below:
 *
 *   1. the total is never exceeded, whatever the demand
 *   2. a category the player plays rarely still gets a floor
 *   3. the split follows where the player's chess actually happens
 *   4. an already-analyzed game costs nothing and must not draw on the budget
 *
 * (4) is the one that matters most in practice: TutorGameReader reads
 * game.analysis when it exists and never calls the engine, so charging cached
 * games against the budget would spend a report's engine time on games needing
 * none, and shrink the sample for no reason.
 *
 * The allocator is pure — array in, array out, no DB, no clock, no randomness
 * — so it is called directly rather than through reflection.
 */
class TutorBudgetAllocatorTest extends TestCase
{
    /**
     * @param array<string, array{total: int, uncached: int}> $demand
     * @return array<string, int>
     */
    private function allocate(array $demand, ?int $budget = null, ?int $floor = null): array
    {
        return TutorBuildService::allocateAnalysisBudget(
            $demand,
            $budget ?? TutorBuildService::ANALYSIS_BUDGET,
            $floor ?? TutorBuildService::ANALYSIS_FLOOR,
        );
    }

    /** @return array{total: int, uncached: int} */
    private static function demand(int $total, int $uncached): array
    {
        return ['total' => $total, 'uncached' => $uncached];
    }

    // --- 1. the constants themselves ------------------------------------

    public function test_budget_and_floor_are_the_documented_numbers(): void
    {
        // Pinned so a change to either is a deliberate, visible edit here and
        // not a silent drift in how long every report takes.
        $this->assertSame(150, TutorBuildService::ANALYSIS_BUDGET, 'ANALYSIS_BUDGET must be 150 — the docblock derives the report wall clock (150 x 3-6s) from it');
        $this->assertSame(20, TutorBuildService::ANALYSIS_FLOOR, 'ANALYSIS_FLOOR must equal MIN_GAMES: the floor is exactly enough engine time to measure the minimum that makes a category reportable');
        $this->assertSame(
            TutorBuildService::MIN_GAMES,
            TutorBuildService::ANALYSIS_FLOOR,
            'the floor is tied to MIN_GAMES by design — a category that qualifies at all can afford to measure its qualifying minimum from scratch',
        );
        $this->assertGreaterThanOrEqual(
            TutorBuildService::ANALYSIS_FLOOR * count(TutorBuildService::CATEGORIES),
            TutorBuildService::ANALYSIS_BUDGET,
            'the budget must cover a floor for every category at once, or a four-category player has floors scaled down on every build',
        );
    }

    // --- 2. the budget is a hard bound ----------------------------------

    public function test_total_never_exceeds_the_budget(): void
    {
        $alloc = $this->allocate([
            'bullet' => self::demand(900, 900),
            'blitz' => self::demand(700, 700),
            'rapid' => self::demand(300, 300),
            'classical' => self::demand(120, 120),
        ]);

        $this->assertSame(
            TutorBuildService::ANALYSIS_BUDGET,
            array_sum($alloc),
            'four saturated categories must together draw exactly the budget, never 4 x a per-category cap',
        );
    }

    public function test_the_old_per_category_blowup_cannot_happen(): void
    {
        // The exact shape of the regression: an active player in all four
        // categories, nothing cached. Under the old per-category cap this was
        // 600 analyses, 30-60 minutes of engine time for one report.
        $alloc = $this->allocate([
            'bullet' => self::demand(400, 400),
            'blitz' => self::demand(400, 400),
            'rapid' => self::demand(400, 400),
            'classical' => self::demand(400, 400),
        ]);

        $this->assertLessThanOrEqual(150, array_sum($alloc), 'one report must never commission more than the total budget');

        // Equal volume, equal need: an even split, not a first-come one.
        // 150/4 is 37.5, so two categories get 38 and two get 37.
        foreach ($alloc as $category => $granted) {
            $this->assertContains($granted, [37, 38], "{$category} should get an even quarter of a 150 budget, not a first-come share");
        }
    }

    /** @return list<array{int, int}> */
    public static function budgetCases(): array
    {
        return [[0, 4], [1, 4], [7, 4], [19, 3], [20, 4], [150, 4], [150, 1], [151, 2]];
    }

    #[DataProvider('budgetCases')]
    public function test_budget_is_respected_for_any_budget_and_category_count(int $budget, int $categories): void
    {
        $demand = [];
        for ($i = 0; $i < $categories; $i++) {
            $demand['c' . $i] = self::demand(100 * ($i + 1), 500);
        }

        $alloc = $this->allocate($demand, $budget);

        $this->assertSame($budget, array_sum($alloc), "a saturated demand must draw exactly {$budget}, never more (a floor bigger than the budget must be scaled down, not overrun)");
        $this->assertCount($categories, $alloc, 'every category must appear in the allocation, even at 0');
        foreach ($alloc as $granted) {
            $this->assertGreaterThanOrEqual(0, $granted, 'no category may be granted a negative number of analyses');
        }
    }

    // --- 3. cached games do not draw on the budget ----------------------

    public function test_cached_games_do_not_consume_the_budget(): void
    {
        // 380 blitz games, only 12 of them never analyzed. The engine is
        // needed for 12; the other 368 are a JSON decode each. The category
        // must draw 12 and no more — the budget bounds engine work, not the
        // sample.
        $alloc = $this->allocate(['blitz' => self::demand(380, 12)]);

        $this->assertSame(12, $alloc['blitz'], 'a category may only ever draw what it actually needs the engine for');
    }

    public function test_a_fully_cached_report_costs_nothing(): void
    {
        $alloc = $this->allocate([
            'bullet' => self::demand(600, 0),
            'blitz' => self::demand(900, 0),
        ]);

        $this->assertSame(0, array_sum($alloc), '1,500 already-analyzed games must commission zero engine work — every one of them is still measured, for free');
    }

    public function test_budget_freed_by_cached_games_flows_to_the_categories_that_need_it(): void
    {
        // Bullet is the player's main time control by volume but is almost
        // entirely cached, so the fresh work belongs to blitz. The old
        // per-category cap could not express this at all.
        $alloc = $this->allocate([
            'bullet' => self::demand(800, 10),
            'blitz' => self::demand(200, 200),
        ]);

        $this->assertSame(10, $alloc['bullet'], 'bullet needs the engine for 10 games and must draw exactly 10');
        $this->assertSame(140, $alloc['blitz'], 'the 140 the cached bullet games did not use must go to blitz, not be left on the table');
        $this->assertSame(TutorBuildService::ANALYSIS_BUDGET, array_sum($alloc));
    }

    public function test_everything_fits_when_fresh_games_are_within_the_budget(): void
    {
        // Under budget in total: nobody is cut, no proportional split runs,
        // and no category is trimmed to its floor.
        $alloc = $this->allocate([
            'bullet' => self::demand(300, 60),
            'blitz' => self::demand(90, 40),
            'rapid' => self::demand(25, 25),
        ]);

        $this->assertSame(['bullet' => 60, 'blitz' => 40, 'rapid' => 25], $alloc, 'when the fresh games fit, every one of them is analyzed');
        $this->assertSame(125, array_sum($alloc));
    }

    // --- 4. the proportional split --------------------------------------

    public function test_split_is_proportional_to_how_much_each_category_is_played(): void
    {
        // 3:1 in volume, both saturated, both above the floor. After the two
        // floors the remainder goes out by highest-averages, which converges
        // on the same 3:1.
        $alloc = $this->allocate([
            'blitz' => self::demand(300, 300),
            'rapid' => self::demand(100, 100),
        ]);

        $this->assertSame(TutorBuildService::ANALYSIS_BUDGET, array_sum($alloc));
        $this->assertEqualsWithDelta(112.5, $alloc['blitz'], 1.0, 'blitz is 3/4 of this player\'s chess and must get ~3/4 of the budget');
        $this->assertEqualsWithDelta(37.5, $alloc['rapid'], 1.0, 'rapid is 1/4 of this player\'s chess and must get ~1/4 of the budget');
        $this->assertGreaterThan($alloc['rapid'], $alloc['blitz'], 'more games measured where more of the player\'s chess happens');
    }

    public function test_a_dominant_category_gets_more_than_a_marginal_one(): void
    {
        $alloc = $this->allocate([
            'bullet' => self::demand(1000, 1000),
            'blitz' => self::demand(200, 200),
            'rapid' => self::demand(60, 60),
            'classical' => self::demand(30, 30),
        ]);

        $this->assertSame(TutorBuildService::ANALYSIS_BUDGET, array_sum($alloc));
        $this->assertGreaterThan($alloc['blitz'], $alloc['bullet']);
        $this->assertGreaterThanOrEqual($alloc['rapid'], $alloc['blitz']);
        $this->assertGreaterThanOrEqual($alloc['classical'], $alloc['rapid']);
    }

    // --- 5. the floor ---------------------------------------------------

    public function test_every_category_keeps_a_floor_against_a_dominant_one(): void
    {
        // The starvation case: one category with 40x the volume of the others.
        // A pure proportional split would give classical 150 * 30/2280 = 1.9
        // analyses, i.e. a printed verdict on two games.
        $alloc = $this->allocate([
            'bullet' => self::demand(2000, 2000),
            'blitz' => self::demand(150, 150),
            'rapid' => self::demand(100, 100),
            'classical' => self::demand(30, 30),
        ]);

        foreach (['blitz', 'rapid', 'classical'] as $category) {
            $this->assertGreaterThanOrEqual(
                TutorBuildService::ANALYSIS_FLOOR,
                $alloc[$category],
                "{$category} must keep its floor rather than being starved to a handful of games by a dominant bullet volume",
            );
        }

        $this->assertSame(TutorBuildService::ANALYSIS_BUDGET, array_sum($alloc));
        $this->assertSame(90, $alloc['bullet'], 'bullet takes everything the three floors leave: 150 - 3 x 20');
    }

    public function test_floor_is_capped_by_what_a_category_actually_needs(): void
    {
        // classical qualifies (>= MIN_GAMES games) but only 3 of them are
        // uncached. It must draw 3, not a full floor of 20 — the rest is
        // engine time nobody needs.
        $alloc = $this->allocate([
            'bullet' => self::demand(2000, 2000),
            'classical' => self::demand(40, 3),
        ]);

        $this->assertSame(3, $alloc['classical'], 'the floor is a minimum grant, not a minimum spend');
        $this->assertSame(147, $alloc['bullet'], 'what classical could not use must not be left unspent');
    }

    public function test_floor_is_scaled_down_rather_than_overrunning_a_small_budget(): void
    {
        // Defensive: floors that cannot all be paid must be shared, never
        // allowed to sum past the budget.
        $alloc = $this->allocate([
            'bullet' => self::demand(100, 100),
            'blitz' => self::demand(100, 100),
            'rapid' => self::demand(100, 100),
            'classical' => self::demand(100, 100),
        ], 30);

        $this->assertSame(30, array_sum($alloc), 'four 20-game floors cannot be paid from a 30 budget — they must scale, not overrun');
        foreach ($alloc as $granted) {
            $this->assertGreaterThan(0, $granted, 'even a scaled floor must leave every category something');
        }
    }

    // --- 6. the ordinary player -----------------------------------------

    public function test_single_category_player_gets_a_sensible_sample(): void
    {
        // The most common shape by far: someone who only plays blitz. They
        // must get the whole budget, not a quarter of it reserved for
        // categories they do not play.
        $alloc = $this->allocate(['blitz' => self::demand(700, 700)]);

        $this->assertSame(['blitz' => 150], $alloc, 'a one-category player must get the entire budget');
    }

    public function test_two_category_player_below_budget_is_untouched(): void
    {
        $alloc = $this->allocate([
            'blitz' => self::demand(60, 55),
            'rapid' => self::demand(40, 30),
        ]);

        $this->assertSame(['blitz' => 55, 'rapid' => 30], $alloc, 'a normal account is nowhere near the budget and must be analyzed in full');
    }

    public function test_no_categories_allocates_nothing(): void
    {
        $this->assertSame([], $this->allocate([]), 'a player with no qualifying category commissions no engine work');
    }

    public function test_missing_keys_are_treated_as_zero_demand(): void
    {
        // Defensive: a malformed demand entry must not produce a negative or
        // an unbounded grant.
        $alloc = $this->allocate(['blitz' => []]);

        $this->assertSame(['blitz' => 0], $alloc);
    }

    // --- 7. the other half: what the allocation actually selects ---------
    //
    // sample() is where the budget meets the games. It is private and takes
    // Game rows, so it goes through reflection — the same pattern
    // TutorBuildServiceTest uses for dimensionSampleGate(). No DB is touched:
    // Game rows are constructed in memory and only `analysis` is read.

    /** @param list<Game> $games */
    private function sample(array $games, int $analysisBudget): array
    {
        $service = (new ReflectionClass(TutorBuildService::class))->newInstanceWithoutConstructor();
        $method = (new ReflectionClass(TutorBuildService::class))->getMethod('sample');
        $method->setAccessible(true);

        return $method->invoke($service, $games, $analysisBudget);
    }

    /** @return list<Game> */
    private static function games(int $cached, int $uncached): array
    {
        $out = [];

        for ($i = 0; $i < $cached; $i++) {
            $game = new Game();
            $game->id = 'cached-' . $i;
            $game->analysis = '{"plies":[]}';
            $out[] = $game;
        }

        for ($i = 0; $i < $uncached; $i++) {
            $game = new Game();
            $game->id = 'fresh-' . $i;
            $game->analysis = null;
            $out[] = $game;
        }

        // Interleave, so "kept the cached ones" can't be confused with "kept a
        // contiguous prefix".
        shuffle($out);

        return $out;
    }

    /** @param list<Game> $games */
    private static function countCached(array $games): int
    {
        return count(array_filter($games, fn(Game $g): bool => ($g->analysis ?? '') !== ''));
    }

    public function test_sample_measures_every_cached_game_regardless_of_budget(): void
    {
        // 200 cached games and a budget of 0: all 200 are still measured,
        // because measuring them is a JSON decode, not an engine call.
        $sampled = $this->sample(self::games(200, 0), 0);

        $this->assertCount(200, $sampled, 'a cached game must never be dropped for want of budget — it needs none');
    }

    public function test_sample_draws_only_its_allocation_of_fresh_games(): void
    {
        $sampled = $this->sample(self::games(120, 300), 40);

        $this->assertCount(160, $sampled, '120 free cached games plus exactly the 40 fresh ones the allocation paid for');
        $this->assertSame(120, self::countCached($sampled), 'every cached game is in');
        $this->assertSame(40, count($sampled) - self::countCached($sampled), 'the fresh games drawn must equal the allocation, never more');
    }

    public function test_sample_takes_everything_when_the_allocation_covers_it(): void
    {
        $sampled = $this->sample(self::games(30, 25), 40);

        $this->assertCount(55, $sampled, 'under budget, the whole category is measured and capHit stays false');
    }

    public function test_sample_draws_fresh_games_uniformly_not_by_recency(): void
    {
        // gamesFor() returns newest-first. Taking the head of that list would
        // make a 12-month report a snapshot of last week — the anti-bias
        // property documented in docs/tasks/open/tutor.md. Over many draws
        // every position must be reachable.
        $games = [];
        for ($i = 0; $i < 40; $i++) {
            $game = new Game();
            $game->id = 'g' . $i;
            $game->analysis = null;
            $games[] = $game;
        }

        $seenLate = false;
        $seenEarly = false;

        for ($trial = 0; $trial < 40; $trial++) {
            $ids = array_map(fn(Game $g): string => $g->id, $this->sample($games, 5));
            $this->assertCount(5, $ids, 'the draw must be exactly the allocation');
            $this->assertSame(array_unique($ids), $ids, 'the draw must be without replacement — no game measured twice');

            foreach ($ids as $id) {
                $index = (int) substr($id, 1);
                if ($index < 5) {
                    $seenEarly = true;
                }

                if ($index >= 30) {
                    $seenLate = true;
                }
            }
        }

        $this->assertTrue($seenEarly, 'the newest games must be reachable');
        $this->assertTrue($seenLate, 'the oldest games must be reachable too — this is not "the most recent N"');
    }

    public function test_sample_preserves_the_original_newest_first_order(): void
    {
        // The rows come out of gamesFor() newest-first and gameRows() renders
        // them in the order it gets them, so the selection must be a
        // subsequence of the input, not cached-then-fresh.
        $games = [];
        for ($i = 0; $i < 40; $i++) {
            $game = new Game();
            $game->id = 'g' . $i;
            $game->analysis = $i % 2 === 0 ? '{"plies":[]}' : null;
            $games[] = $game;
        }

        $indexes = array_map(
            fn(Game $g): int => (int) substr($g->id, 1),
            $this->sample($games, 5),
        );

        $sorted = $indexes;
        sort($sorted);

        $this->assertSame($sorted, $indexes, 'the sample must keep the input order (20 cached + 5 fresh, interleaved)');
        $this->assertCount(25, $indexes);
    }
}
