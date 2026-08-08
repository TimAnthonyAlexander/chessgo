<?php

namespace App\Tests\Unit;

use App\Controllers\PremoveGameController;
use App\Controllers\PremoveReleaseController;
use App\Models\PremoveGame;
use App\Models\PremovePosition;
use App\Models\User;
use App\Services\EngineSelector;
use App\Services\Glicko2Service;
use App\Services\PremoveTrainerService;
use BaseApi\App;
use BaseApi\Http\Request;
use PHPUnit\Framework\TestCase;

/**
 * PremoveTrainerService — docs/tasks/open/premove-trainer.md §12, the frozen
 * contract's required test surface, verbatim:
 *
 *   - clock charge: elapsed is snapshotted once, engine think time never
 *     lands on it
 *   - flag on release after the clock has run out; the chain is discarded
 *   - collapse mid-chain in rated -> still ongoing, correct collapsed_at,
 *     correct remaining clock
 *   - collapse in casual -> lost / chain-broke
 *   - the future-stamp: last_move_at - nowMs() ~= plies * PLY_MS
 *   - mate detection maps to won / checkmate
 *   - rating applied exactly once and only for a logged-in rated game
 *   - the solution never appears in any response payload (assert against the
 *     serialized JSON, SecretQueenRedactionTest pattern)
 *   - ownership: a non-owner must 404 on both GET and release
 *
 * `EngineSelector` makes real HTTP calls to zugzwang, so every test here runs
 * against `FakePremoveEngine` (bottom of file) instead — a scripted stand-in,
 * same shape as AnalyzeControllerTest's FakeAnalyzeEngine. That fake is also
 * what makes the "engine think time is not charged" property provable: its
 * analyze() can be told to actually sleep, and the clock math must not care.
 *
 * `Glicko2Service` is pure computation (see Glicko2ServiceTest) and is used
 * for real throughout, never faked.
 */
class PremoveTrainerTest extends TestCase
{
    private const START_FEN = 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1';

    private const AFTER_E4 = 'rnbqkbnr/pppppppp/8/8/4P3/8/PPPP1PPP/RNBQKBNR b KQkq e3 0 1';

    private const AFTER_E4_E5 = 'rnbqkbnr/pppp1ppp/8/4p3/4P3/8/PPPP1PPP/RNBQKBNR w KQkq e6 0 2';

    /** Fool's mate final position — a real checkmate FEN, used wherever the
     *  test needs a terminal "checkmate" result out of the fake engine. */
    private const FOOLS_MATE_FEN = 'rnb1kbnr/pppp1ppp/8/4p3/6Pq/5P2/PPPPP2P/RNBQKBNR w KQkq - 1 3';

    /** Mirrors the contract's §9 PLY_MS_RATED — private on the service, so
     *  pinned here as a literal for the future-stamp assertions. */
    private const PLY_MS_RATED = 320;

    /** Loose enough to absorb ordinary test/CI jitter, tight enough that the
     *  ~300-400ms artificial "engine think time" injected below would blow it
     *  if that time were ever (incorrectly) charged to the player's clock. */
    private const CLOCK_TOLERANCE_MS = 150;

    /** @var list<PremoveGame> */
    private array $games = [];

    /** @var list<PremovePosition> */
    private array $positions = [];

    /** @var list<User> */
    private array $users = [];

    protected function setUp(): void
    {
        parent::setUp();

        App::boot(dirname(__DIR__, 2));

        $this->games = [];
        $this->positions = [];
        $this->users = [];
    }

    protected function tearDown(): void
    {
        // Children first: PremoveGame FKs both User and PremovePosition.
        foreach ($this->games as $game) {
            $game->delete();
        }
        foreach ($this->positions as $position) {
            $position->delete();
        }
        foreach ($this->users as $user) {
            $user->delete();
        }

        parent::tearDown();
    }

    // --- fixtures ---------------------------------------------------------

    private function nowMs(): int
    {
        return (int) round(microtime(true) * 1000);
    }

    /** @param list<string> $solution */
    /**
     * A pool position. The trainer no longer replays a puzzle line — a generated
     * Syzygy position IS the start position, and by construction many moves win
     * (see docs/tasks/open/premove-trainer.md §3), so there is no solution here
     * to hide.
     */
    private function makePosition(int $rating = 1500, int $conversionPlies = 6, int $breadthPct = 80): PremovePosition
    {
        $position = new PremovePosition();
        $position->fen = self::START_FEN;
        $position->signature = 'KQvK';
        $position->side_to_move = 'w';
        $position->piece_count = 3;
        $position->breadth_pct = $breadthPct;
        $position->winning_moves = 8;
        $position->legal_moves = 10;
        $position->conversion_plies = $conversionPlies;
        $position->rating = $rating;
        $this->assertTrue($position->save(), 'fixture setup: position must save');
        $this->positions[] = $position;

        return $position;
    }

    private function makeUser(): User
    {
        $user = new User();
        $user->name = 'Premove Trainer Test';
        $user->email = 'premove-test-' . bin2hex(random_bytes(8)) . '@example.invalid';
        $user->password = password_hash('irrelevant', PASSWORD_DEFAULT);
        $this->assertTrue($user->save(), 'fixture setup: user must save');
        $this->users[] = $user;

        return $user;
    }

    /** @param array<string, mixed> $attrs */
    private function makeGame(array $attrs = []): PremoveGame
    {
        $position = $attrs['position'] ?? $this->makePosition();

        $game = new PremoveGame();
        $game->user_id = $attrs['user_id'] ?? null;
        $game->position_id = $position->id;
        $game->rated = $attrs['rated'] ?? false;
        $game->time_control = $attrs['time_control'] ?? null;
        $game->player_color = $attrs['player_color'] ?? 'w';
        $game->start_fen = $attrs['start_fen'] ?? self::START_FEN;
        $game->fen = $attrs['fen'] ?? $game->start_fen;
        $game->side_to_move = $attrs['side_to_move'] ?? 'w';
        $game->clock_ms = $attrs['clock_ms'] ?? null;
        $game->last_move_at = $attrs['last_move_at'] ?? null;
        $game->status = $attrs['status'] ?? 'ongoing';
        $game->end_reason = $attrs['end_reason'] ?? null;
        $game->chain_target = $attrs['chain_target'] ?? 2;
        $game->opponent_rating = $attrs['opponent_rating'] ?? $position->rating;
        $game->setMoves($attrs['moves'] ?? []);
        $game->setChains($attrs['chains'] ?? []);
        $this->assertTrue($game->save(), 'fixture setup: game must save');
        $this->games[] = $game;

        return $game;
    }

    private function trainer(FakePremoveEngine $engine): PremoveTrainerService
    {
        return new PremoveTrainerService($engine, new Glicko2Service());
    }

    private function requestAs(string $userId, array $body = []): Request
    {
        $request = new Request('POST', '/', [], [], $body, null, [], [], [], 'test-req-' . bin2hex(random_bytes(4)));
        $request->user = ['id' => $userId];

        return $request;
    }

    /** @return array<string, mixed> */
    private function legal(string $newFen, string $san, string $status = 'ongoing'): array
    {
        return ['legal' => true, 'newFen' => $newFen, 'san' => $san, 'status' => $status];
    }

    /** @return array<string, mixed> */
    private function illegal(): array
    {
        return ['legal' => false];
    }

    // --- clock charge: elapsed snapshotted once, engine time never charged ---

    public function test_engine_think_time_never_lands_on_the_clock(): void
    {
        $startClock = 10_000;
        $elapsedBeforeCall = 2_000;
        $lastMoveAt = $this->nowMs() - $elapsedBeforeCall;

        $game = $this->makeGame([
            'rated' => false, // anonymous rated-format attempt: still timed, never settled
            'time_control' => PremoveTrainerService::RATED_TIME_CONTROL,
            'clock_ms' => $startClock,
            'last_move_at' => (string) $lastMoveAt,
        ]);

        $engine = new FakePremoveEngine();
        $engine->moveQueue = [
            $this->legal(self::AFTER_E4, 'e4'),
            $this->legal(self::AFTER_E4_E5, 'e5'),
        ];
        $engine->analyzeQueue = [['bestmove' => 'e7e5']];
        // The "think time" the contract says must be off-clock. If the
        // implementation ever recomputes elapsed after this call, the leak
        // shows up directly in clock_ms below.
        $engine->analyzeSleepMs = 400;

        $callStart = $this->nowMs();
        $trainer = $this->trainer($engine);
        $trainer->release($game, ['e2e4']);
        $callEnd = $this->nowMs();

        $this->assertSame(1, count($engine->analyzeCalls), 'the defender reply must actually have been requested (proves the sleep really happened)');

        $elapsedAtCallTime = $callStart - $lastMoveAt;
        $expectedRemaining = $startClock - $elapsedAtCallTime;

        $this->assertNotNull($game->clock_ms);
        $this->assertEqualsWithDelta(
            $expectedRemaining,
            $game->clock_ms,
            self::CLOCK_TOLERANCE_MS,
            'clock_ms must reflect only the pre-call elapsed time, not the 400ms spent inside analyze()',
        );
        // Sanity: the request really did take >= 400ms of wall time (the sleep
        // ran), yet the charge above stayed within CLOCK_TOLERANCE_MS of the
        // PRE-call elapsed — proof the two are decoupled.
        $this->assertGreaterThanOrEqual(400, $callEnd - $callStart);
    }

    // --- flag on release after time is already up ---

    /**
     * The exploit that shipped in the first build and was caught only by an
     * adversarial pass, not by the spec: `last_move_at` is stamped INTO THE
     * FUTURE by the animation length, so a release arriving before it used to
     * clamp elapsed to zero via max(0, ...) — making every such release free. A
     * client that simply never waited kept its clock at the starting value
     * forever and could grind unlimited attempts, spending real time only on the
     * one release that actually mated.
     */
    public function test_release_arriving_before_the_playout_has_finished_is_rejected(): void
    {
        $game = $this->makeGame([
            'rated' => false,
            'time_control' => PremoveTrainerService::RATED_TIME_CONTROL,
            'clock_ms' => 15_000,
            // Mid-animation: stamped 2s out, and a prior playout already exists.
            'last_move_at' => (string) ($this->nowMs() + 2_000),
            'moves' => [
                ['ply' => 1, 'uci' => 'e2e4', 'san' => 'e4', 'fen' => self::AFTER_E4, 'by' => 'player'],
                ['ply' => 2, 'uci' => 'e7e5', 'san' => 'e5', 'fen' => self::AFTER_E4_E5, 'by' => 'engine'],
            ],
        ]);

        $engine = new FakePremoveEngine();
        $trainer = $this->trainer($engine);

        try {
            $trainer->release($game, ['d2d4']);
            $this->fail('a release during the playout animation must be refused');
        } catch (\InvalidArgumentException $e) {
            $this->assertStringContainsString('playing out', $e->getMessage());
        }

        $this->assertSame([], $engine->moveCalls, 'refused before any engine work');
        $this->assertSame(15_000, $game->clock_ms, 'a refused release must not touch the clock');
        $this->assertSame('ongoing', $game->status);
    }

    /**
     * The other half of the guard: it must key on the ANIMATION stamp only. The
     * clock is also stamped slightly ahead at creation (START_GRACE_MS, covering
     * transit and first paint), and gating on that too would reject the player's
     * very first release — which is exactly what the first version of the fix
     * did.
     */
    public function test_first_release_is_allowed_while_the_start_grace_is_still_ahead(): void
    {
        $game = $this->makeGame([
            'rated' => false,
            'time_control' => PremoveTrainerService::RATED_TIME_CONTROL,
            'clock_ms' => 15_000,
            'last_move_at' => (string) ($this->nowMs() + 250), // start grace, no moves yet
            'moves' => [],
        ]);

        $engine = new FakePremoveEngine();
        $engine->moveQueue = [$this->legal(self::AFTER_E4, 'e4'), $this->legal(self::AFTER_E4_E5, 'e5')];
        $engine->analyzeQueue = [['bestmove' => 'e7e5']];

        $this->trainer($engine)->release($game, ['e2e4']);

        $this->assertSame('ongoing', $game->status);
        $this->assertCount(2, $game->getMoves(), 'the first release must actually play');
        $this->assertSame(15_000, $game->clock_ms, 'the grace means nothing is charged yet');
    }

    public function test_flag_on_release_after_the_clock_ran_out_discards_the_chain(): void
    {
        $game = $this->makeGame([
            'rated' => false,
            'time_control' => PremoveTrainerService::RATED_TIME_CONTROL,
            'clock_ms' => 100,
            'last_move_at' => (string) ($this->nowMs() - 5_000), // 5s overdue on a 100ms clock
        ]);

        $engine = new FakePremoveEngine(); // must never be touched — the flag short-circuits before any engine call
        $trainer = $this->trainer($engine);

        $result = $trainer->release($game, ['e2e4', 'd1h5']);

        $this->assertSame([], $result['playout']);
        $this->assertNull($result['collapsedAt']);
        $this->assertSame('lost', $game->status);
        $this->assertSame('flagged', $game->end_reason);
        $this->assertSame(0, $game->clock_ms);
        $this->assertSame([], $game->getMoves(), 'no moves may be recorded on a flag');
        $this->assertSame([], $game->getChains(), 'the submitted chain must be discarded, not stored');
        $this->assertSame([], $engine->moveCalls, 'a flagged release must never reach the engine');
        $this->assertSame([], $engine->analyzeCalls);
    }

    // --- collapse mid-chain in rated: stays ongoing ---

    public function test_collapse_mid_chain_in_rated_stays_ongoing_with_correct_index_and_clock(): void
    {
        $startClock = 10_000;
        $elapsedBeforeCall = 1_000;
        $lastMoveAt = $this->nowMs() - $elapsedBeforeCall;

        $game = $this->makeGame([
            'rated' => false,
            'time_control' => PremoveTrainerService::RATED_TIME_CONTROL,
            'clock_ms' => $startClock,
            'last_move_at' => (string) $lastMoveAt,
        ]);

        $engine = new FakePremoveEngine();
        $engine->moveQueue = [
            $this->legal(self::AFTER_E4, 'e4'),      // player's 1st move — legal
            $this->legal(self::AFTER_E4_E5, 'e5'),   // defender's reply — legal
            $this->illegal(),                        // player's 2nd move — the defender didn't cooperate
        ];
        $engine->analyzeQueue = [['bestmove' => 'e7e5']];

        $callStart = $this->nowMs();
        $trainer = $this->trainer($engine);
        $result = $trainer->release($game, ['e2e4', 'g8f6']);
        $callEnd = $this->nowMs();

        $this->assertSame(1, $result['collapsedAt'], 'collapse must be reported at the index of the move that failed');
        $this->assertCount(2, $result['playout'], 'only the first (successful) pair should have been played before the collapse');
        $this->assertSame('ongoing', $game->status, 'a rated collapse must not end the attempt');
        $this->assertNull($game->end_reason);
        $this->assertCount(2, $game->getMoves());
        $this->assertSame([['e2e4', 'g8f6']], $game->getChains(), 'the submitted chain is still recorded even though it collapsed');

        $elapsedAtCallTime = $callStart - $lastMoveAt;
        $expectedRemaining = $startClock - $elapsedAtCallTime;
        $this->assertEqualsWithDelta($expectedRemaining, $game->clock_ms, self::CLOCK_TOLERANCE_MS);

        $expectedFutureStamp = $callEnd + 2 * self::PLY_MS_RATED;
        $this->assertEqualsWithDelta($expectedFutureStamp, (int) $game->last_move_at, self::CLOCK_TOLERANCE_MS);
    }

    // --- collapse in casual: one shot, lost ---

    public function test_collapse_in_casual_ends_the_attempt_lost_chain_broke(): void
    {
        $game = $this->makeGame([
            'rated' => false,
            'time_control' => null, // casual: untimed
            'clock_ms' => null,
            'last_move_at' => null,
        ]);

        $engine = new FakePremoveEngine();
        $engine->moveQueue = [$this->illegal()];
        $trainer = $this->trainer($engine);

        $result = $trainer->release($game, ['e2e4']);

        $this->assertSame(0, $result['collapsedAt']);
        $this->assertSame([], $result['playout']);
        $this->assertSame('lost', $game->status);
        $this->assertSame('chain-broke', $game->end_reason);
    }

    /** Bonus coverage of the same terminal-mapping row (contract §5): a
     *  casual chain that runs all the way out WITHOUT a collapse and without a
     *  mate is still a loss, but tagged 'unresolved' rather than
     *  'chain-broke' — the two are deliberately distinct end_reasons for the
     *  same "you didn't finish it" verdict. */
    public function test_casual_chain_that_runs_dry_without_collapsing_is_unresolved(): void
    {
        $game = $this->makeGame([
            'rated' => false,
            'time_control' => null,
            'clock_ms' => null,
            'last_move_at' => null,
        ]);

        $engine = new FakePremoveEngine();
        $engine->moveQueue = [
            $this->legal(self::AFTER_E4, 'e4'),
            $this->legal(self::AFTER_E4_E5, 'e5'),
        ];
        $engine->analyzeQueue = [['bestmove' => 'e7e5']];
        $trainer = $this->trainer($engine);

        $result = $trainer->release($game, ['e2e4']);

        $this->assertNull($result['collapsedAt']);
        $this->assertSame('lost', $game->status);
        $this->assertSame('unresolved', $game->end_reason);
    }

    // --- the future-stamp itself ---

    public function test_future_stamp_on_a_non_terminal_rated_release_is_plies_times_ply_ms(): void
    {
        $game = $this->makeGame([
            'rated' => false,
            'time_control' => PremoveTrainerService::RATED_TIME_CONTROL,
            'clock_ms' => 10_000,
            'last_move_at' => (string) ($this->nowMs() - 100),
        ]);

        $engine = new FakePremoveEngine();
        // Two full move pairs, neither terminal, chain simply exhausts —
        // 4 plies of playout in total.
        $engine->moveQueue = [
            $this->legal(self::AFTER_E4, 'e4'),
            $this->legal(self::AFTER_E4_E5, 'e5'),
            $this->legal(self::AFTER_E4, 'Nf3'),
            $this->legal(self::AFTER_E4_E5, 'Nc6'),
        ];
        $engine->analyzeQueue = [['bestmove' => 'e7e5'], ['bestmove' => 'b8c6']];
        $trainer = $this->trainer($engine);

        $callEnd0 = $this->nowMs();
        $result = $trainer->release($game, ['e2e4', 'g1f3']);
        $callEnd1 = $this->nowMs();

        $this->assertNull($result['collapsedAt']);
        $this->assertCount(4, $result['playout']);
        $this->assertSame('ongoing', $game->status);

        $expectedDelta = 4 * self::PLY_MS_RATED;
        $actualDelta = (int) $game->last_move_at - $callEnd1;
        // Bound both from below (against $callEnd0, before the call) and from
        // above (against $callEnd1, after it) so the assertion holds
        // regardless of exactly when inside the call nowMs() was sampled.
        $this->assertGreaterThanOrEqual(($callEnd0 + $expectedDelta) - self::CLOCK_TOLERANCE_MS, (int) $game->last_move_at);
        $this->assertLessThanOrEqual(($callEnd1 + $expectedDelta) + self::CLOCK_TOLERANCE_MS, (int) $game->last_move_at);
    }

    // --- mate detection ---

    public function test_player_delivered_checkmate_is_won_checkmate(): void
    {
        $game = $this->makeGame(); // casual is fine; mate mapping doesn't depend on format

        $engine = new FakePremoveEngine();
        $engine->moveQueue = [$this->legal(self::FOOLS_MATE_FEN, 'Qh4#', 'checkmate')];
        $trainer = $this->trainer($engine);

        $result = $trainer->release($game, ['d8h4']);

        $this->assertSame('won', $game->status);
        $this->assertSame('checkmate', $game->end_reason);
        $this->assertNull($result['collapsedAt']);
        $this->assertCount(1, $result['playout']);
        $this->assertSame([], $engine->analyzeCalls, 'a terminal player move must not provoke a defender reply');
    }

    public function test_engine_delivered_checkmate_is_lost_mated_not_won(): void
    {
        $game = $this->makeGame();

        $engine = new FakePremoveEngine();
        $engine->moveQueue = [
            $this->legal(self::AFTER_E4, 'e4'),
            $this->legal(self::FOOLS_MATE_FEN, 'Qh4#', 'checkmate'),
        ];
        $engine->analyzeQueue = [['bestmove' => 'd8h4']];
        $trainer = $this->trainer($engine);

        $trainer->release($game, ['e2e4']);

        $this->assertSame('lost', $game->status);
        $this->assertSame('mated', $game->end_reason);
    }

    // --- rating: applied exactly once, only for a logged-in rated attempt ---

    public function test_rating_is_applied_for_a_logged_in_rated_win_and_matches_glicko2(): void
    {
        $user = $this->makeUser();
        $position = $this->makePosition(rating: 1620);
        $game = $this->makeGame([
            'position' => $position,
            'user_id' => $user->id,
            'rated' => true,
            'time_control' => PremoveTrainerService::RATED_TIME_CONTROL,
            'clock_ms' => 10_000,
            'last_move_at' => (string) ($this->nowMs() - 100),
            'opponent_rating' => 1620,
        ]);

        $engine = new FakePremoveEngine();
        $engine->moveQueue = [$this->legal(self::FOOLS_MATE_FEN, 'Qh4#', 'checkmate')];
        $trainer = $this->trainer($engine);
        $trainer->release($game, ['d8h4']);

        $this->assertSame('won', $game->status);
        $this->assertSame(1500, $game->rating_before);
        $this->assertNotNull($game->rating_after);
        $this->assertSame($game->rating_after - 1500, $game->rating_delta);

        // Cross-check against Glicko2Service directly — same call shape as
        // PremoveTrainerService::settleRating() (contract §6): a fresh
        // 1500/350/0.06 player, one win against a fixed 1620/PREMOVE_RD
        // opponent, no idle-time RD inflation.
        $glicko = new Glicko2Service();
        [$expectedRating] = $glicko->update(1500.0, 350.0, 0.06, [
            ['rating' => 1620.0, 'rd' => 60.0, 'score' => 1.0],
        ]);
        $this->assertSame((int) round($expectedRating), $game->rating_after);

        $reloaded = User::find($user->id);
        $this->assertInstanceOf(User::class, $reloaded);
        $this->assertSame($game->rating_after, $reloaded->rating_premove);
        $this->assertSame(1, $reloaded->games_premove, 'rating must be applied exactly once');
    }

    public function test_rating_cannot_be_applied_twice_because_a_finished_attempt_refuses_another_release(): void
    {
        $user = $this->makeUser();
        $game = $this->makeGame([
            'user_id' => $user->id,
            'rated' => true,
            'time_control' => PremoveTrainerService::RATED_TIME_CONTROL,
            'clock_ms' => 10_000,
            'last_move_at' => (string) ($this->nowMs() - 100),
        ]);

        $engine = new FakePremoveEngine();
        $engine->moveQueue = [$this->legal(self::FOOLS_MATE_FEN, 'Qh4#', 'checkmate')];
        $trainer = $this->trainer($engine);
        $trainer->release($game, ['d8h4']);

        $ratingAfterFirstSettle = $game->rating_after;

        $this->expectException(\InvalidArgumentException::class);
        try {
            $trainer->release($game, ['a2a3']);
        } finally {
            // Whatever happens, the first (and only legitimate) settlement
            // must be left untouched.
            $this->assertSame($ratingAfterFirstSettle, $game->rating_after);
        }
    }

    public function test_anonymous_rated_format_attempt_is_never_rated(): void
    {
        $game = $this->makeGame([
            'user_id' => null,
            'rated' => false, // anonymous: create() forces this false regardless of format
            'time_control' => PremoveTrainerService::RATED_TIME_CONTROL,
            'clock_ms' => 10_000,
            'last_move_at' => (string) ($this->nowMs() - 100),
        ]);

        $engine = new FakePremoveEngine();
        $engine->moveQueue = [$this->legal(self::FOOLS_MATE_FEN, 'Qh4#', 'checkmate')];
        $trainer = $this->trainer($engine);
        $trainer->release($game, ['d8h4']);

        $this->assertSame('won', $game->status);
        $this->assertNull($game->rating_before);
        $this->assertNull($game->rating_after);
        $this->assertNull($game->rating_delta);
    }

    public function test_logged_in_casual_attempt_is_never_rated(): void
    {
        $user = $this->makeUser();
        $game = $this->makeGame([
            'user_id' => $user->id,
            'rated' => false, // casual format: create() never sets this true
            'time_control' => null,
            'clock_ms' => null,
            'last_move_at' => null,
        ]);

        $engine = new FakePremoveEngine();
        $engine->moveQueue = [$this->legal(self::FOOLS_MATE_FEN, 'Qh4#', 'checkmate')];
        $trainer = $this->trainer($engine);
        $trainer->release($game, ['d8h4']);

        $this->assertSame('won', $game->status);
        $this->assertNull($game->rating_after);

        $reloaded = User::find($user->id);
        $this->assertInstanceOf(User::class, $reloaded);
        $this->assertSame(1500, $reloaded->rating_premove);
        $this->assertSame(0, $reloaded->games_premove);
    }

    /**
     * The client must never hold its own copy of the chain cap. It did, it
     * drifted below the server's value, and players were silently blocked at 12
     * premoves while release() would happily accept 20 — with no error, just a
     * board that stopped responding. Pin that the cap is published, and that the
     * published number is the one release() actually enforces.
     */
    public function test_present_publishes_the_chain_cap_that_release_enforces(): void
    {
        $game = $this->makeGame();
        $engine = new FakePremoveEngine();
        $engine->legalMovesResult = ['moves' => ['e2e4']];

        $payload = $this->trainer($engine)->present($game);
        $this->assertArrayHasKey('max_chain', $payload, 'the client has no other way to learn the cap');
        $cap = $payload['max_chain'];
        $this->assertIsInt($cap);

        // A chain of exactly the published length must be accepted...
        $ok = $this->makeGame();
        $accepting = new FakePremoveEngine();
        $accepting->moveQueue = array_fill(0, $cap * 2, $this->legal(self::AFTER_E4, 'e4'));
        $accepting->analyzeQueue = array_fill(0, $cap, ['bestmove' => 'e7e5']);
        $result = $this->trainer($accepting)->release($ok, array_fill(0, $cap, 'e2e4'));
        $played = count(array_filter($result['playout'], static fn (array $p): bool => $p['by'] === 'player'));
        $this->assertSame($cap, $played, 'every move of a max_chain-length chain must actually be played');
        $this->assertNull($result['collapsedAt'], 'the cap itself must not read as a collapse');

        // ...and one move past it must be refused.
        $over = $this->makeGame();
        try {
            $this->trainer(new FakePremoveEngine())->release($over, array_fill(0, $cap + 1, 'e2e4'));
            $this->fail('a chain longer than max_chain must be refused');
        } catch (\InvalidArgumentException $e) {
            $this->assertStringContainsString((string) $cap, $e->getMessage());
        }
    }

    // --- pool metadata never appears in any response payload -------------
    //
    // The old pool was mined from Lichess puzzles, so the thing to hide was the
    // solution line. The generated pool has no single solution — many moves win,
    // that is the whole point — but it carries something just as spoiling:
    // `conversion_plies` says exactly how long the win is, `chain_target` is
    // derived from it, and `breadth_pct` says how forgiving the position is.
    // Telling the player any of those hands them a third of the work.
    //
    // Asserted against the serialized JSON rather than field-by-field, so a leak
    // through a newly-added field fails this too.

    private const SPOILER_KEYS = [
        'position_id', 'conversion_plies', 'chain_target', 'breadth_pct',
        'winning_moves', 'signature', 'opponent_rating', 'start_fen',
    ];

    public function test_pool_metadata_never_appears_in_a_fresh_present_payload(): void
    {
        $position = $this->makePosition(rating: 1500, conversionPlies: 17, breadthPct: 63);
        $game = $this->makeGame(['position' => $position]);

        $engine = new FakePremoveEngine();
        $engine->legalMovesResult = ['moves' => ['e2e4', 'g1f3']];

        $json = json_encode($this->trainer($engine)->present($game), JSON_THROW_ON_ERROR);

        foreach (self::SPOILER_KEYS as $key) {
            $this->assertStringNotContainsString($key, $json, "{$key} must never reach the client");
        }
        $this->assertStringNotContainsString($position->id, $json, "the position's own id leaked");
        // 17 is the conversion length; seeing it anywhere in the payload means
        // the chain length escaped by some other name.
        $this->assertStringNotContainsString('17', $json, 'the conversion length leaked');
    }

    public function test_pool_metadata_never_appears_after_a_collapsed_release(): void
    {
        $position = $this->makePosition(rating: 1500, conversionPlies: 19, breadthPct: 55);
        $game = $this->makeGame(['position' => $position]);

        $engine = new FakePremoveEngine();
        $engine->moveQueue = [$this->illegal()];
        $engine->legalMovesResult = ['moves' => []];
        $trainer = $this->trainer($engine);

        $result = $trainer->release($game, ['e2e4']);
        $json = json_encode(
            $trainer->present($game, $result['playout'], $result['collapsedAt']),
            JSON_THROW_ON_ERROR,
        );

        foreach (self::SPOILER_KEYS as $key) {
            $this->assertStringNotContainsString($key, $json, "{$key} leaked after release()");
        }
        $this->assertStringNotContainsString($position->id, $json);
    }

    // --- ownership: a non-owner must 404 on both GET and release ----------
    //
    // Real bug, since fixed: pin it so it cannot regress. Paired with a
    // same-shape "owner succeeds" case so a future "just always 404" fix
    // can't pass this file either.

    public function test_get_404s_for_a_non_owner(): void
    {
        $owner = $this->makeUser();
        $intruder = $this->makeUser();
        $game = $this->makeGame([
            'user_id' => $owner->id,
            'rated' => true,
            'time_control' => PremoveTrainerService::RATED_TIME_CONTROL,
            'clock_ms' => 10_000,
            'last_move_at' => (string) $this->nowMs(),
        ]);

        $controller = new PremoveGameController($this->trainer(new FakePremoveEngine()));
        $controller->id = $game->id;
        $controller->request = $this->requestAs($intruder->id);

        $response = $controller->get();

        $this->assertSame(404, $response->status);
    }

    public function test_get_200s_for_the_owner(): void
    {
        $owner = $this->makeUser();
        $game = $this->makeGame([
            'user_id' => $owner->id,
            'rated' => true,
            'time_control' => PremoveTrainerService::RATED_TIME_CONTROL,
            'clock_ms' => 10_000,
            'last_move_at' => (string) $this->nowMs(),
        ]);

        $engine = new FakePremoveEngine();
        $engine->legalMovesResult = ['moves' => ['e2e4']];
        $controller = new PremoveGameController($this->trainer($engine));
        $controller->id = $game->id;
        $controller->request = $this->requestAs($owner->id);

        $response = $controller->get();

        $this->assertSame(200, $response->status);
    }

    public function test_release_404s_for_a_non_owner(): void
    {
        $owner = $this->makeUser();
        $intruder = $this->makeUser();
        $game = $this->makeGame([
            'user_id' => $owner->id,
            'rated' => true,
            'time_control' => PremoveTrainerService::RATED_TIME_CONTROL,
            'clock_ms' => 10_000,
            'last_move_at' => (string) $this->nowMs(),
        ]);

        $engine = new FakePremoveEngine(); // must never be reached by a non-owner
        $controller = new PremoveReleaseController($this->trainer($engine));
        $controller->id = $game->id;
        $controller->request = $this->requestAs($intruder->id, ['chain' => ['e2e4']]);

        $response = $controller->post();

        $this->assertSame(404, $response->status);
        $this->assertSame([], $engine->moveCalls, 'a non-owner release must never reach the engine');
    }

    public function test_release_200s_for_the_owner(): void
    {
        $owner = $this->makeUser();
        $game = $this->makeGame([
            'user_id' => $owner->id,
            'rated' => true,
            'time_control' => PremoveTrainerService::RATED_TIME_CONTROL,
            'clock_ms' => 10_000,
            'last_move_at' => (string) $this->nowMs(),
        ]);

        $engine = new FakePremoveEngine();
        $engine->moveQueue = [$this->illegal()];
        $engine->legalMovesResult = ['moves' => []];
        $controller = new PremoveReleaseController($this->trainer($engine));
        $controller->id = $game->id;
        $controller->request = $this->requestAs($owner->id, ['chain' => ['e2e4']]);

        $response = $controller->post();

        $this->assertSame(200, $response->status);
    }

    public function test_anonymous_game_stays_open_to_anyone(): void
    {
        $game = $this->makeGame([
            'user_id' => null,
            'rated' => false,
            'time_control' => null,
            'clock_ms' => null,
            'last_move_at' => null,
        ]);
        $someone = $this->makeUser();

        $controller = new PremoveGameController($this->trainer(new FakePremoveEngine()));
        $controller->id = $game->id;
        $controller->request = $this->requestAs($someone->id);

        $response = $controller->get();

        $this->assertSame(200, $response->status);
    }
}

/**
 * Scripted stand-in for EngineSelector — same shape as
 * AnalyzeControllerTest's FakeAnalyzeEngine. move()/analyze() are consumed
 * FIFO from a queue the test pre-loads, so a test controls the entire
 * playout deterministically without a real zugzwang process.
 *
 * `analyzeSleepMs` exists for exactly one purpose: proving that engine think
 * time never reaches the player's clock (contract §2.1). Real chess legality
 * is NOT modelled here — PremoveTrainerService trusts whatever `legal` the
 * engine reports, so the fake doesn't need to be a chess engine, only a
 * script.
 */
final class FakePremoveEngine extends EngineSelector
{
    /** @var list<array<string, mixed>> */
    public array $moveQueue = [];

    /** @var list<array<string, mixed>> */
    public array $analyzeQueue = [];

    /** @var array<string, mixed> */
    public array $legalMovesResult = ['moves' => []];

    public int $analyzeSleepMs = 0;

    /** @var list<array{fen: string, move: string, history: list<string>}> */
    public array $moveCalls = [];

    /** @var list<array{fen: string, movetimeMs: int, history: list<string>}> */
    public array $analyzeCalls = [];

    public function __construct()
    {
        // Deliberately skip EngineSelector's real constructor (App::config()
        // plus two live HTTP clients) — every method the service calls is
        // overridden below, so nothing from the parent is ever touched.
    }

    public function move(string $fen, string $move, array $history = []): array
    {
        $this->moveCalls[] = ['fen' => $fen, 'move' => $move, 'history' => $history];
        if ($this->moveQueue === []) {
            throw new \LogicException("FakePremoveEngine::move() queue exhausted for '{$move}'");
        }

        return array_shift($this->moveQueue);
    }

    public function analyze(
        string $fen,
        int $movetimeMs = 1500,
        int $depth = 0,
        int $multipv = 0,
        array $history = [],
    ): array {
        $this->analyzeCalls[] = ['fen' => $fen, 'movetimeMs' => $movetimeMs, 'history' => $history];
        if ($this->analyzeSleepMs > 0) {
            usleep($this->analyzeSleepMs * 1000);
        }
        if ($this->analyzeQueue === []) {
            throw new \LogicException('FakePremoveEngine::analyze() queue exhausted');
        }

        return array_shift($this->analyzeQueue);
    }

    public function legalMoves(string $fen, ?string $square = null): array
    {
        return $this->legalMovesResult;
    }
}
