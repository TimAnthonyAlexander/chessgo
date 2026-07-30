<?php

namespace App\Tests\Unit;

use App\Controllers\AnalyzeController;
use App\Services\AnticheatService;
use App\Services\EngineSelector;
use App\Models\EvalCache;
use App\Services\EvalCacheService;
use BaseApi\App;
use PHPUnit\Framework\TestCase;

/**
 * AnalyzeController::resolveAnalysis() — the cache-vs-search decision that
 * previously only ran when `history === []` (see EvalCacheServiceTest's doc
 * comment for the DB-bootstrap rationale this file shares). This suite covers
 * the rework that makes the cache usable for non-empty `history` too, by
 * resolving `opening` through a search-free engine lookup separate from the
 * cached eval.
 *
 * `resolveAnalysis()` is exercised directly (not `post()`) so these tests
 * need no HTTP harness, no session, and no `$this->request` — it depends only
 * on the injected `EngineSelector` (faked below, so nothing hits a real
 * engine) and `EvalCacheService` (real, against the same `eval_cache_test` table
 * EvalCacheServiceTest uses).
 */
class AnalyzeControllerTest extends TestCase
{
    private EvalCacheService $cache;

    protected function setUp(): void
    {
        parent::setUp();

        // Redirect the model at a scratch table. PHPUnit runs against the real
        // dev MySQL (.env's DB_DRIVER beats phpunit.xml's sqlite), and this
        // suite clears its table in setUp — against the live `eval_cache`, one
        // test run would wipe the seeded book and any imported evals.
        EvalCache::$table = 'eval_cache_test';

        App::boot(dirname(__DIR__, 2));

        $pdo = App::db()->getConnection()->pdo();
        // Mirrors the CREATE TABLE `eval_cache_test` migration exactly — see
        // EvalCacheServiceTest for why this defensive fallback exists.
        $pdo->exec(
            "CREATE TABLE IF NOT EXISTS `eval_cache_test` (\n"
            . "  `fen_key` VARCHAR(255) NOT NULL DEFAULT '',\n"
            . "  `depth` INT NOT NULL DEFAULT 0,\n"
            . "  `multipv` INT NOT NULL DEFAULT 1,\n"
            . "  `eval_type` VARCHAR(255) NOT NULL DEFAULT 'cp',\n"
            . "  `eval_value` INT NOT NULL DEFAULT 0,\n"
            . "  `bestmove` VARCHAR(255),\n"
            . "  `pv` TEXT,\n"
            . "  `lines` TEXT,\n"
            . "  `source` VARCHAR(255) NOT NULL DEFAULT 'zugzwang',\n"
            . "  `nodes` INT NOT NULL DEFAULT 0,\n"
            . "  `used_at` TEXT,\n"
            . "  `id` VARCHAR(36) NOT NULL DEFAULT '',\n"
            . "  `created_at` DATETIME DEFAULT CURRENT_TIMESTAMP,\n"
            . "  `updated_at` DATETIME DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,\n"
            . "  PRIMARY KEY (`id`),\n"
            // The real table gets this via a separate ALTER in the migration;
            // without it the importers' ON DUPLICATE KEY UPDATE has nothing to
            // collide on and re-importing a row silently duplicates it.
            . "  UNIQUE KEY `uniq_eval_cache_test_fen_key` (`fen_key`)\n"
            . ") ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci",
        );
        $pdo->exec('DELETE FROM eval_cache_test');

        $this->cache = new EvalCacheService();
    }

    protected function tearDown(): void
    {
        EvalCache::$table = null;
        parent::tearDown();
    }

    private const START_FEN = 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1';

    private const AFTER_E4_FEN = 'rnbqkbnr/pppppppp/8/8/4P3/8/PPPP1PPP/RNBQKBNR b KQkq e3 0 1';

    // --- cache HIT, non-empty history, opening resolution succeeds ---

    public function test_cache_hit_with_history_resolves_opening_via_client(): void
    {
        $this->putResult(self::AFTER_E4_FEN, depth: 20);

        $engine = new FakeAnalyzeEngine();
        $engine->openingResult = ['ok' => true, 'opening' => ['eco' => 'B00', 'name' => "King's Pawn Game"]];
        $controller = $this->makeController($engine);

        $result = $controller->resolveAnalysis(self::AFTER_E4_FEN, 1500, 20, 0, [self::START_FEN]);

        $this->assertSame(['eco' => 'B00', 'name' => "King's Pawn Game"], $result['opening']);
        $this->assertSame(['type' => 'cp', 'value' => 25], $result['eval']);
        $this->assertSame('e2e4', $result['bestmove']);
        $this->assertSame([], $engine->analyzeCalls, 'a cache hit must not trigger a search');
        $this->assertCount(1, $engine->openingCalls);
        $this->assertSame(self::AFTER_E4_FEN, $engine->openingCalls[0]['fen']);
        $this->assertSame([self::START_FEN], $engine->openingCalls[0]['history']);
    }

    // --- cache HIT, engine legitimately reports no named opening ---

    public function test_cache_hit_with_no_named_opening_returns_null_without_search(): void
    {
        $this->putResult(self::AFTER_E4_FEN, depth: 20);

        $engine = new FakeAnalyzeEngine();
        $engine->openingResult = ['ok' => true, 'opening' => null];
        $controller = $this->makeController($engine);

        $result = $controller->resolveAnalysis(self::AFTER_E4_FEN, 1500, 20, 0, [self::START_FEN]);

        $this->assertNull($result['opening']);
        $this->assertSame(['type' => 'cp', 'value' => 25], $result['eval']);
        $this->assertSame([], $engine->analyzeCalls, 'a legitimate "no opening" answer must not trigger a search');
    }

    // --- cache HIT, opening resolution FAILS (endpoint missing/unreachable/malformed) ---

    public function test_cache_hit_opening_resolution_failure_falls_through_to_search(): void
    {
        $this->putResult(self::AFTER_E4_FEN, depth: 20);

        $engine = new FakeAnalyzeEngine();
        $engine->openingResult = ['ok' => false, 'opening' => null];
        $engine->analyzeResult = [
            'eval' => ['type' => 'cp', 'value' => 999],
            'bestmove' => 'g1f3',
            'pv' => ['g1f3', 'g8f6'],
            'depth' => 22,
            'opening' => ['eco' => 'B00', 'name' => "King's Pawn Game"],
            'lines' => null,
        ];
        $controller = $this->makeController($engine);

        $result = $controller->resolveAnalysis(self::AFTER_E4_FEN, 1500, 20, 0, [self::START_FEN]);

        $this->assertCount(1, $engine->analyzeCalls, 'opening-resolution failure must fall through to a full search');
        $this->assertSame(self::AFTER_E4_FEN, $engine->analyzeCalls[0]['fen']);
        $this->assertSame([self::START_FEN], $engine->analyzeCalls[0]['history']);
        $this->assertSame($engine->analyzeResult['eval'], $result['eval']);
        $this->assertSame($engine->analyzeResult['bestmove'], $result['bestmove']);
        $this->assertSame($engine->analyzeResult['opening'], $result['opening']);
    }

    // --- cache HIT, empty history: STILL resolves the opening via the engine ---

    /**
     * Regression guard. Empty history was once shortcut to `opening: null` on
     * the assumption that a name needs history to resolve. It does not:
     * Openings::classify keys on the current position's own Zobrist, so a named
     * position resolves from the FEN alone. Verified against the live engine —
     * /analyze on the Italian Game with no history returns {C50, Italian Game}
     * on the search path, so the shortcut silently blanked the name on every
     * cache hit for that position.
     */
    public function test_cache_hit_with_empty_history_still_resolves_opening_via_client(): void
    {
        $this->putResult(self::START_FEN, depth: 20);

        $engine = new FakeAnalyzeEngine();
        $engine->openingResult = ['ok' => true, 'opening' => ['eco' => 'C50', 'name' => 'Italian Game']];
        $controller = $this->makeController($engine);

        $result = $controller->resolveAnalysis(self::START_FEN, 1500, 20, 0, []);

        $this->assertSame(['eco' => 'C50', 'name' => 'Italian Game'], $result['opening']);
        $this->assertSame(
            [['fen' => self::START_FEN, 'history' => []]],
            $engine->openingCalls,
            'a cache hit must resolve the opening even with no history',
        );
        $this->assertSame([], $engine->analyzeCalls, 'a cache hit must not trigger a search');
    }

    // --- cache MISS: unchanged — search, then put() ---

    public function test_cache_miss_searches_and_stores_result(): void
    {
        $engine = new FakeAnalyzeEngine();
        $engine->analyzeResult = [
            'eval' => ['type' => 'cp', 'value' => 40],
            'bestmove' => 'e2e4',
            'pv' => ['e2e4'],
            'depth' => 20,
            'opening' => null,
            'lines' => null,
            'nodes' => 12345,
        ];
        $controller = $this->makeController($engine);

        $result = $controller->resolveAnalysis(self::START_FEN, 1500, 20, 0, []);

        $this->assertCount(1, $engine->analyzeCalls);
        $this->assertSame(40, $result['eval']['value']);

        $cached = $this->cache->get(self::START_FEN, 20, 1);
        $this->assertNotNull($cached, 'a miss must populate the cache');
        $this->assertSame(20, $cached->depth);
    }

    // --- cacheOnly: the mode the board uses once the local engine is searching ---
    //
    // The whole point is that a client running its own engine must not make the
    // server run one too. If any of these ever invoke a search, the local engine
    // becomes a net COST to the server rather than a saving.

    public function test_cache_only_miss_returns_miss_and_never_searches(): void
    {
        $engine = new FakeAnalyzeEngine();
        $controller = $this->makeController($engine);

        $result = $controller->resolveAnalysis(self::START_FEN, 1500, 0, 5, [], cacheOnly: true);

        $this->assertSame('miss', $result['source']);
        $this->assertNull($result['eval']);
        $this->assertNull($result['depth']);
        $this->assertSame([], $engine->analyzeCalls, 'cacheOnly must never start a search');
    }

    public function test_cache_only_hit_returns_the_cached_eval(): void
    {
        $this->putResult(self::START_FEN, depth: 24);

        $engine = new FakeAnalyzeEngine();
        $engine->openingResult = ['ok' => true, 'opening' => ['eco' => 'B00', 'name' => "King's Pawn Game"]];
        $controller = $this->makeController($engine);

        $result = $controller->resolveAnalysis(self::START_FEN, 1500, 20, 0, [], cacheOnly: true);

        $this->assertSame('cache', $result['source']);
        $this->assertSame(24, $result['depth']);
        $this->assertSame(['eco' => 'B00', 'name' => "King's Pawn Game"], $result['opening']);
        $this->assertSame([], $engine->analyzeCalls);
    }

    public function test_cache_only_hit_omits_opening_when_lookup_fails_rather_than_searching(): void
    {
        $this->putResult(self::START_FEN, depth: 24);

        $engine = new FakeAnalyzeEngine();
        $engine->openingResult = ['ok' => false, 'opening' => null];
        $controller = $this->makeController($engine);

        $result = $controller->resolveAnalysis(self::START_FEN, 1500, 20, 0, [], cacheOnly: true);

        $this->assertSame('cache', $result['source']);
        $this->assertSame(24, $result['depth']);
        // ABSENT, not null: the client reads a missing key as "no opinion" and
        // keeps the name it is already showing. An explicit null would blank it.
        $this->assertArrayNotHasKey('opening', $result);
        $this->assertSame([], $engine->analyzeCalls, 'a failed opening lookup must not fall through to a search');
    }

    // --- cacheOnly + cache MISS: the book fallback ---
    //
    // Same "local engine is doing the search" contract as above — the book
    // probe is a pure lookup on the engine side (no Search::Context), so it's
    // allowed even under cacheOnly. These must never invoke analyze().

    public function test_cache_only_miss_with_book_hit_returns_book_result_and_writes_cache(): void
    {
        $engine = new FakeAnalyzeEngine();
        $engine->bookResult = [
            'ok' => true,
            'hit' => true,
            'eval' => ['type' => 'cp', 'value' => 33],
            'bestmove' => 'e2e4',
            'pv' => ['e2e4', 'e7e5', 'g1f3'],
            'depth' => 22,
        ];
        $controller = $this->makeController($engine);

        $result = $controller->resolveAnalysis(self::START_FEN, 1500, 0, 5, [], cacheOnly: true);

        $this->assertSame('book', $result['source']);
        $this->assertSame(['type' => 'cp', 'value' => 33], $result['eval']);
        $this->assertSame('e2e4', $result['bestmove']);
        $this->assertSame(['e2e4', 'e7e5', 'g1f3'], $result['pv']);
        $this->assertSame(22, $result['depth']);
        $this->assertSame([], $engine->analyzeCalls, 'a book hit must never trigger a search');
        $this->assertCount(1, $engine->bookCalls);
        $this->assertSame(self::START_FEN, $engine->bookCalls[0]);

        $cached = $this->cache->get(self::START_FEN, 20, 1);
        $this->assertNotNull($cached, 'a book hit must be written into eval_cache');
        $this->assertSame(22, $cached->depth);
        $this->assertSame('book', $cached->source);
        $this->assertSame('e2e4', $cached->bestmove);
    }

    public function test_cache_only_miss_with_book_miss_returns_miss_and_writes_nothing(): void
    {
        $engine = new FakeAnalyzeEngine();
        $engine->bookResult = ['ok' => true, 'hit' => false];
        $controller = $this->makeController($engine);

        $result = $controller->resolveAnalysis(self::START_FEN, 1500, 0, 5, [], cacheOnly: true);

        $this->assertSame('miss', $result['source']);
        $this->assertNull($result['eval']);
        $this->assertSame([], $engine->analyzeCalls, 'a book miss must never trigger a search');
        $this->assertCount(1, $engine->bookCalls);

        $cached = $this->cache->get(self::START_FEN, 0, 1);
        $this->assertNull($cached, 'a book miss must write nothing to eval_cache');
    }

    public function test_cache_only_hit_never_probes_the_book(): void
    {
        $this->putResult(self::START_FEN, depth: 24);

        $engine = new FakeAnalyzeEngine();
        $engine->openingResult = ['ok' => true, 'opening' => null];
        $controller = $this->makeController($engine);

        $result = $controller->resolveAnalysis(self::START_FEN, 1500, 20, 0, [], cacheOnly: true);

        $this->assertSame('cache', $result['source']);
        $this->assertSame([], $engine->bookCalls, 'a cache hit already answered — the book must never be probed');
    }

    public function test_cache_only_miss_book_hit_does_not_downgrade_a_deeper_existing_row(): void
    {
        // A deeper row is already stored (e.g. a real search on this position
        // ran via the non-cacheOnly path), but it does not satisfy the
        // requested depth (35), so the cache lookup itself still misses and
        // the book gets probed — exactly the scenario where put()'s
        // never-downgrade ordering has to hold: the book's depth-22 entry must
        // not clobber the already-deeper depth-30 row.
        $this->putResult(self::START_FEN, depth: 30);

        $engine = new FakeAnalyzeEngine();
        $engine->bookResult = [
            'ok' => true,
            'hit' => true,
            'eval' => ['type' => 'cp', 'value' => 33],
            'bestmove' => 'e2e4',
            'pv' => ['e2e4'],
            'depth' => 22,
        ];
        $controller = $this->makeController($engine);

        $result = $controller->resolveAnalysis(self::START_FEN, 1500, 35, 0, [], cacheOnly: true);

        // The response itself still reports the book's own (shallower) result
        // — the caller asked for depth 35 and cacheOnly forbids searching for
        // it, so the book move is the best available answer for THIS request.
        $this->assertSame('book', $result['source']);
        $this->assertSame(22, $result['depth']);
        $this->assertCount(1, $engine->bookCalls);

        // But the STORED row must not regress: the pre-existing depth-30 entry
        // is better than the book's depth-22 one, so put() must have left it
        // untouched.
        $cached = $this->cache->get(self::START_FEN, 0, 1);
        $this->assertNotNull($cached);
        $this->assertSame(30, $cached->depth, 'a shallower book entry must never downgrade a deeper stored row');
        $this->assertNotSame('book', $cached->source, 'the pre-existing row (not the book write) must still be stored');
    }

    private function makeController(EngineSelector $engine): AnalyzeController
    {
        $anticheat = new class extends AnticheatService {
            public function __construct()
            {
                // Deliberately skip the real constructor — resolveAnalysis()
                // never touches AnticheatService, so no real dependencies needed.
            }
        };

        return new AnalyzeController($engine, $anticheat, $this->cache);
    }

    /**
     * Build a minimal /analyze-shaped result array and put() it — mirrors
     * EvalCacheServiceTest::putResult().
     */
    private function putResult(string $fen, int $depth): void
    {
        $this->cache->put($fen, [
            'eval' => ['type' => 'cp', 'value' => 25],
            'bestmove' => 'e2e4',
            'pv' => ['e2e4', 'e7e5'],
            'depth' => $depth,
            'nodes' => 100,
            'lines' => [],
        ]);
    }
}

/**
 * Fakes the engine boundary for AnalyzeControllerTest: records every
 * analyze()/opening() call and returns whatever the test configured, so
 * these tests never touch a real zugzwang process. Deliberately skips
 * EngineSelector::__construct() (which requires real GomachineClient /
 * ZugzwangClient instances) — every method AnalyzeController calls on this
 * class is overridden below, so the parent's client properties are never
 * read.
 */
class FakeAnalyzeEngine extends EngineSelector
{
    /** @var list<array{fen: string, movetime: int, depth: int, multipv: int, history: list<string>}> */
    public array $analyzeCalls = [];

    /** @var list<array{fen: string, history: list<string>}> */
    public array $openingCalls = [];

    /** @var array<string, mixed> */
    public array $analyzeResult = [
        'eval' => ['type' => 'cp', 'value' => 0],
        'bestmove' => null,
        'pv' => [],
        'depth' => 1,
        'opening' => null,
        'lines' => null,
    ];

    /** @var array{ok: bool, opening: array<string, mixed>|null} */
    public array $openingResult = ['ok' => true, 'opening' => null];

    /** @var list<string> */
    public array $bookCalls = [];

    /** @var array{ok: false, hit: false}|array{ok: true, hit: false}|array{ok: true, hit: true, eval: array<string, mixed>, bestmove: string, pv: list<string>, depth: int} */
    public array $bookResult = ['ok' => true, 'hit' => false];

    public function __construct()
    {
    }

    public function analyze(
        string $fen,
        int $movetimeMs = 1500,
        int $depth = 0,
        int $multipv = 0,
        array $history = [],
    ): array {
        $this->analyzeCalls[] = [
            'fen' => $fen,
            'movetime' => $movetimeMs,
            'depth' => $depth,
            'multipv' => $multipv,
            'history' => $history,
        ];

        return $this->analyzeResult;
    }

    public function opening(string $fen, array $history = []): array
    {
        $this->openingCalls[] = ['fen' => $fen, 'history' => $history];

        return $this->openingResult;
    }

    public function book(string $fen): array
    {
        $this->bookCalls[] = $fen;

        return $this->bookResult;
    }
}
