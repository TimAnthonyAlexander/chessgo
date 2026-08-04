<?php

namespace App\Tests\Unit;

use App\Models\Puzzle;
use App\Models\PuzzleAttempt;
use App\Models\PuzzleTheme;
use App\Models\User;
use App\Services\Tutor\TutorThemeProfile;
use BaseApi\App;
use PHPUnit\Framework\TestCase;
use ReflectionClass;

/**
 * TutorThemeProfile::forUser() runs a hand-written SQL join straight through
 * App::db() — there is no repository seam to mock and, per EvalCacheServiceTest's
 * precedent (see its docblock), phpunit.xml's sqlite env is overridden by
 * .env's DB_DRIVER=mysql, so App::db() in THIS test process is the real local
 * dev MySQL, not an isolated fixture. Unlike EvalCacheServiceTest, this class's
 * SQL hard-codes the real `puzzle` / `puzzle_theme` / `puzzle_attempt` table
 * names (no `static $table` override point), so there is no scratch-table
 * seam to redirect onto either.
 *
 * What this file actually verifies, split by what needs a DB and what doesn't:
 *
 *   - The STRUCTURAL exclusion list and MIN_ATTEMPTS gate are read straight off
 *     the class via reflection — pure, no DB involved, and true regardless of
 *     what's reachable.
 *   - forUser()/weakThemes() against a user with zero rows (a real disposable
 *     user, never given any puzzle_attempt rows) proves the "no data" path
 *     degrades to the documented empty shape without throwing. This exercises
 *     the real DB connection (it must be reachable for the fixture setup
 *     itself to work) but not the try/catch(Throwable) branch specifically —
 *     forcing that branch would mean breaking the real DB connection out from
 *     under a shared test process, which risks every other DB-touching test
 *     in this suite. That branch is genuinely NOT exercised by this file: the
 *     source (forUser()'s try/catch(Throwable) wrapping App::db()->raw(),
 *     returning the same empty shape on failure) is the only verification of
 *     it — said plainly here instead of faking it with a no-op test.
 *   - The STRUCTURAL filter, the MIN_ATTEMPTS gate, and the weakest-first sort
 *     are exercised end-to-end against REAL rows: a disposable user plus
 *     disposable Puzzle/PuzzleTheme/PuzzleAttempt rows, each tagged with a
 *     single synthetic theme so attempt counts per theme are exact (a real
 *     Lichess puzzle usually carries many theme tags at once, which would
 *     make attempt counts non-deterministic per theme). Cleaned up in
 *     tearDown(); Puzzle -> PuzzleTheme/PuzzleAttempt cascade on delete
 *     (see storage/migrations.json's fk_puzzle_theme_puzzle_id /
 *     fk_puzzle_attempt_puzzle_id, both ON DELETE CASCADE), so deleting the
 *     synthetic Puzzle rows removes their theme + attempt rows too, and the
 *     disposable user is deleted last (fk_puzzle_attempt_user_id also
 *     cascades, so any attempt somehow left over would go with it).
 */
class TutorThemeProfileTest extends TestCase
{
    private TutorThemeProfile $profile;

    private User $user;

    /** @var list<Puzzle> */
    private array $puzzles = [];

    protected function setUp(): void
    {
        parent::setUp();

        App::boot(dirname(__DIR__, 2));

        $this->profile = new TutorThemeProfile();

        $this->user = new User();
        $this->user->name = 'Tutor Theme Test';
        $this->user->email = 'tutor-theme-test-' . bin2hex(random_bytes(8)) . '@example.invalid';
        $this->user->password = password_hash('irrelevant', PASSWORD_DEFAULT);
        $this->assertTrue($this->user->save(), 'fixture setup: disposable test user must save');
    }

    protected function tearDown(): void
    {
        foreach ($this->puzzles as $puzzle) {
            $puzzle->delete(); // cascades to its puzzle_theme + puzzle_attempt rows
        }
        $this->puzzles = [];

        $this->user->delete();

        parent::tearDown();
    }

    /**
     * Create $n disposable puzzles, each tagged with exactly ONE PuzzleTheme
     * row ($theme), and give the fixture user one PuzzleAttempt per puzzle,
     * $solvedCount of them solved (the first $solvedCount, the rest failed).
     * One theme tag per puzzle keeps each theme's attempt count exact — a
     * real Lichess puzzle usually carries several simultaneous theme tags,
     * which would make per-theme attempt counts depend on unrelated puzzles.
     */
    private function seedTheme(string $theme, int $n, int $solvedCount): void
    {
        for ($i = 0; $i < $n; $i++) {
            $puzzle = new Puzzle();
            // ext_id is varchar(36) in the real schema — a plain random hex
            // id (no embedded theme name) stays well under that.
            $puzzle->ext_id = 'tt' . bin2hex(random_bytes(16));
            $puzzle->fen = 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1';
            $puzzle->rating = 1500;
            $this->assertTrue($puzzle->save(), "fixture setup: puzzle $i for theme $theme must save");
            $this->puzzles[] = $puzzle;

            $puzzleTheme = new PuzzleTheme();
            $puzzleTheme->puzzle_id = $puzzle->id;
            $puzzleTheme->theme = $theme;
            $puzzleTheme->rating = 1500;
            $this->assertTrue($puzzleTheme->save(), "fixture setup: theme tag $i for $theme must save");

            $attempt = new PuzzleAttempt();
            $attempt->user_id = $this->user->id;
            $attempt->puzzle_id = $puzzle->id;
            $attempt->solved = $i < $solvedCount;
            $this->assertTrue($attempt->save(), "fixture setup: attempt $i for $theme must save");
        }
    }

    // --- pure: constants, no DB -------------------------------------------

    public function test_structural_exclusion_list_contains_the_documented_shape_themes(): void
    {
        $const = (new ReflectionClass(TutorThemeProfile::class))->getReflectionConstant('STRUCTURAL');
        $this->assertNotFalse($const, 'STRUCTURAL constant must exist');
        $structural = $const->getValue();

        foreach (['short', 'long', 'veryLong', 'oneMove', 'master', 'masterVsMaster', 'crushing', 'advantage', 'equality', 'mate', 'middlegame', 'opening', 'endgame'] as $theme) {
            $this->assertContains($theme, $structural, "STRUCTURAL must exclude the shape-descriptor theme \"$theme\"");
        }

        // A genuine tactical pattern must NOT be in the structural list —
        // otherwise it would silently vanish from every player's profile.
        foreach (['fork', 'pin', 'skewer', 'discoveredAttack', 'sacrifice'] as $theme) {
            $this->assertNotContains($theme, $structural, "STRUCTURAL must not exclude the genuine tactical theme \"$theme\"");
        }
    }

    public function test_min_attempts_gate_is_6(): void
    {
        $const = (new ReflectionClass(TutorThemeProfile::class))->getReflectionConstant('MIN_ATTEMPTS');
        $this->assertNotFalse($const, 'MIN_ATTEMPTS constant must exist');

        $this->assertSame(6, $const->getValue(), 'MIN_ATTEMPTS must be 6 as documented ("below this many attempts a theme rate is noise")');
    }

    // --- DB-backed: no data -------------------------------------------------

    public function test_for_user_degrades_to_empty_shape_when_the_user_has_no_attempts(): void
    {
        $result = $this->profile->forUser($this->user);

        $this->assertSame([], $result['themes'], 'a user with zero puzzle_attempt rows must get an empty themes list, not an exception or a fabricated one');
        $this->assertSame(0, $result['attempts'], 'attempts must be 0 with no rows');
        $this->assertFalse($result['comparable'], 'comparable must always be false — there is no peer number for puzzle themes');
        $this->assertNotSame('', $result['note'], 'the empty case must carry a guidance note (solve N puzzles), not a blank string');
    }

    public function test_weak_themes_is_empty_when_the_user_has_no_attempts(): void
    {
        $this->assertSame([], $this->profile->weakThemes($this->user), 'weakThemes must return an empty list, not throw, for a user with no data');
    }

    // --- DB-backed: STRUCTURAL filter, MIN_ATTEMPTS gate, sort order --------

    public function test_for_user_excludes_structural_themes_even_when_attempts_meet_the_gate(): void
    {
        // 8 attempts on a real STRUCTURAL theme ("endgame") — comfortably
        // above MIN_ATTEMPTS(6), so it WOULD be included if the structural
        // filter didn't run.
        $this->seedTheme('endgame', 8, 3);

        $result = $this->profile->forUser($this->user);

        $themeNames = array_column($result['themes'], 'theme');
        $this->assertNotContains('endgame', $themeNames, '"endgame" is in STRUCTURAL and must never appear in the themes list, regardless of attempt count');
    }

    public function test_for_user_excludes_themes_below_min_attempts(): void
    {
        // 5 attempts is one short of MIN_ATTEMPTS(6).
        $this->seedTheme('tutortestBelowGate', 5, 2);

        $result = $this->profile->forUser($this->user);

        $themeNames = array_column($result['themes'], 'theme');
        $this->assertNotContains('tutortestBelowGate', $themeNames, 'a theme with fewer than MIN_ATTEMPTS attempts must not appear at all');
    }

    public function test_for_user_includes_a_theme_that_exactly_meets_min_attempts(): void
    {
        // Exactly 6 attempts is the gate's own boundary.
        $this->seedTheme('tutortestExactGate', 6, 3);

        $result = $this->profile->forUser($this->user);

        $found = null;
        foreach ($result['themes'] as $t) {
            if ($t['theme'] === 'tutortestExactGate') {
                $found = $t;
                break;
            }
        }

        $this->assertNotNull($found, 'a theme with exactly MIN_ATTEMPTS(6) attempts must be included — the gate is >=, not >');
        $this->assertSame(6, $found['attempts'], 'attempts must reflect the 6 seeded attempts exactly');
        $this->assertSame(3, $found['solved'], 'solved must reflect the 3 seeded solves exactly');
        $this->assertEqualsWithDelta(50.0, $found['rate'], 0.01, '3 of 6 solved = 50%');
    }

    public function test_for_user_sorts_weakest_rate_first(): void
    {
        // Three non-structural themes, each with 8 attempts (well above the
        // gate) so only the SOLVE RATE differs between them:
        //   tutortestWeak:   3/8 solved = 37.5%
        //   tutortestMid:    5/8 solved = 62.5%
        //   tutortestStrong: 7/8 solved = 87.5%
        // Seeded out of rate order deliberately, so a passing sort proves
        // the code sorts, rather than happening to echo insertion order.
        $this->seedTheme('tutortestStrong', 8, 7);
        $this->seedTheme('tutortestWeak', 8, 3);
        $this->seedTheme('tutortestMid', 8, 5);

        $result = $this->profile->forUser($this->user);

        $ours = array_values(array_filter(
            $result['themes'],
            static fn(array $t): bool => str_starts_with((string) $t['theme'], 'tutortest'),
        ));

        $this->assertCount(3, $ours, 'all three seeded non-structural themes must be present (each is above MIN_ATTEMPTS)');
        $this->assertSame(
            ['tutortestWeak', 'tutortestMid', 'tutortestStrong'],
            array_column($ours, 'theme'),
            'themes must be sorted weakest solve rate first, regardless of seeding/insertion order',
        );

        $rates = array_column($ours, 'rate');
        $this->assertEqualsWithDelta(37.5, $rates[0], 0.01, 'weakest theme rate must be 37.5% (3/8)');
        $this->assertEqualsWithDelta(62.5, $rates[1], 0.01, 'middle theme rate must be 62.5% (5/8)');
        $this->assertEqualsWithDelta(87.5, $rates[2], 0.01, 'strongest theme rate must be 87.5% (7/8)');
    }

    public function test_weak_themes_only_returns_themes_under_60_percent_weakest_first(): void
    {
        $this->seedTheme('tutortestStrong', 8, 7);  // 87.5% — not weak
        $this->seedTheme('tutortestWeak', 8, 3);    // 37.5% — weak
        $this->seedTheme('tutortestMid', 8, 5);     // 62.5% — not weak (>= 60)
        $this->seedTheme('tutortestVeryWeak', 8, 1); // 12.5% — weak

        $weak = $this->profile->weakThemes($this->user, limit: 10);
        $ours = array_values(array_filter($weak, static fn(string $t): bool => str_starts_with($t, 'tutortest')));

        $this->assertSame(
            ['tutortestVeryWeak', 'tutortestWeak'],
            $ours,
            'weakThemes must return only themes under 60% solve rate, weakest first, excluding the 62.5% and 87.5% themes',
        );
    }

    public function test_weak_themes_respects_the_limit(): void
    {
        $this->seedTheme('tutortestWeakA', 8, 0); // 0%
        $this->seedTheme('tutortestWeakB', 8, 1); // 12.5%
        $this->seedTheme('tutortestWeakC', 8, 2); // 25%

        $weak = $this->profile->weakThemes($this->user, limit: 2);
        $ours = array_values(array_filter($weak, static fn(string $t): bool => str_starts_with($t, 'tutortest')));

        $this->assertCount(2, $ours, 'weakThemes must be truncated to the given limit');
        $this->assertSame(['tutortestWeakA', 'tutortestWeakB'], $ours, 'the truncated list must keep the weakest entries, in weakest-first order');
    }
}
