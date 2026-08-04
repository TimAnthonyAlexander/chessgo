<?php

namespace App\Tests\Unit;

use App\Models\User;
use App\Services\Tutor\TutorDrillBuilder;
use App\Services\Tutor\TutorMetrics;
use App\Services\Tutor\TutorThemeProfile;
use BaseApi\App;
use PHPUnit\Framework\TestCase;
use ReflectionClass;

/**
 * Two defects, both about what a drill card actually shows on screen:
 *
 *   1. moverEval() used a raw ±10000 sentinel for a mate score, unclamped,
 *      which flowed straight into the `swing` field a replay drill displays
 *      — a real report rendered "top swing 10000cp". Fixed by clamping
 *      exactly like TutorMetrics::moverEval() does (see that method's own
 *      mate-score tests in TutorMetricsTest for the precedent).
 *   2. The 'awareness' and 'accuracy' weaknesses shared one hard-coded
 *      title ("Puzzles on the patterns you are missing"), so a report with
 *      both in its ranked weaknesses rendered two visually identical cards.
 *      Fixed by giving each its own, accurate title.
 */
class TutorDrillBuilderTest extends TestCase
{
    // --- 1. mate-score clamp in moverEval() -----------------------------

    private function invokeMoverEval(?array $evalWhite, string $side): ?float
    {
        $builder = (new ReflectionClass(TutorDrillBuilder::class))->newInstanceWithoutConstructor();
        $method = (new ReflectionClass(TutorDrillBuilder::class))->getMethod('moverEval');
        $method->setAccessible(true);

        return $method->invoke($builder, $evalWhite, $side);
    }

    public function test_mate_score_clamps_to_eval_clamp_not_a_raw_sentinel(): void
    {
        $white = $this->invokeMoverEval(['type' => 'mate', 'value' => 3], 'w');
        $black = $this->invokeMoverEval(['type' => 'mate', 'value' => 3], 'b');

        $this->assertSame((float) TutorMetrics::EVAL_CLAMP, $white, 'a favourable mate score must clamp to +EVAL_CLAMP, not the old raw 10000 sentinel');
        $this->assertSame(-(float) TutorMetrics::EVAL_CLAMP, $black, 'the same mate score from the losing side must clamp to -EVAL_CLAMP');
        $this->assertNotEquals(10000.0, $white, 'the old unclamped ±10000 sentinel must no longer appear');
    }

    public function test_swing_between_two_mate_evals_is_bounded_by_double_eval_clamp(): void
    {
        // A replay drill's `swing` is peak-eval minus post-blunder-eval. With
        // both evals clamped to ±EVAL_CLAMP, the largest possible swing is
        // 2 * EVAL_CLAMP (3000), never the old unbounded/raw-sentinel figure
        // that produced "top swing 10000cp" in a real report.
        $peak = $this->invokeMoverEval(['type' => 'mate', 'value' => 2], 'w');
        $afterBlunder = $this->invokeMoverEval(['type' => 'mate', 'value' => -1], 'w');

        $swing = $peak - $afterBlunder;

        $this->assertLessThanOrEqual(2 * TutorMetrics::EVAL_CLAMP, $swing, 'swing between two mate-derived evals must never exceed 2*EVAL_CLAMP (3000cp)');
        $this->assertLessThan(10000.0, $swing, 'swing must never reach anywhere near the old raw mate sentinel');
    }

    public function test_ordinary_cp_eval_is_unaffected_by_the_clamp_within_range(): void
    {
        $this->assertSame(120.0, $this->invokeMoverEval(['type' => 'cp', 'value' => 120], 'w'), 'an ordinary cp eval well inside EVAL_CLAMP must pass through unchanged');
        $this->assertSame(-120.0, $this->invokeMoverEval(['type' => 'cp', 'value' => 120], 'b'), 'POV flip must still apply for ordinary cp evals');
    }

    public function test_large_cp_eval_still_clamps_like_a_mate_score(): void
    {
        // Not just mate scores — an ordinary but huge cp figure (a queen-plus
        // material blunder eval) must clamp too, exactly like
        // TutorMetrics::moverEval() does, for the same "past this it's noise,
        // not a measurement" reason.
        $this->assertSame((float) TutorMetrics::EVAL_CLAMP, $this->invokeMoverEval(['type' => 'cp', 'value' => 5000], 'w'));
    }

    public function test_missing_eval_still_converts_to_null(): void
    {
        $this->assertNull($this->invokeMoverEval(null, 'w'), 'a missing eval must still convert to null, not 0 or a clamp artefact');
    }

    // --- 2. distinct titles for awareness vs accuracy --------------------

    private TutorDrillBuilder $builder;

    private User $user;

    protected function setUp(): void
    {
        parent::setUp();

        App::boot(dirname(__DIR__, 2));

        $this->builder = new TutorDrillBuilder(new TutorThemeProfile(), new TutorMetrics());

        $this->user = new User();
        $this->user->name = 'Tutor Drill Test';
        $this->user->email = 'tutor-drill-test-' . bin2hex(random_bytes(8)) . '@example.invalid';
        $this->user->password = password_hash('irrelevant', PASSWORD_DEFAULT);
        $this->assertTrue($this->user->save(), 'fixture setup: disposable test user must save');
    }

    protected function tearDown(): void
    {
        $this->user->delete();

        parent::tearDown();
    }

    public function test_awareness_and_accuracy_drills_get_different_titles(): void
    {
        $awareness = $this->builder->forWeakness(['metric' => 'awareness', 'dimension' => ''], [], $this->user);
        $accuracy = $this->builder->forWeakness(['metric' => 'accuracy', 'dimension' => ''], [], $this->user);

        $this->assertIsArray($awareness);
        $this->assertIsArray($accuracy);
        $this->assertNotSame(
            $awareness['title'],
            $accuracy['title'],
            'a report with both an awareness and an accuracy weakness must not render two drill cards with the same title — this is the exact reported bug (two cards both titled "Puzzles on the patterns you are missing")',
        );
    }

    public function test_awareness_and_accuracy_titles_still_describe_a_puzzle_drill(): void
    {
        $awareness = $this->builder->forWeakness(['metric' => 'awareness', 'dimension' => ''], [], $this->user);
        $accuracy = $this->builder->forWeakness(['metric' => 'accuracy', 'dimension' => ''], [], $this->user);

        $this->assertSame('puzzles', $awareness['kind']);
        $this->assertSame('puzzles', $accuracy['kind']);
        $this->assertSame('Drill these', $awareness['label']);
        $this->assertSame('Drill these', $accuracy['label']);
    }
}
