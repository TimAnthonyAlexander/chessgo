<?php

namespace App\Tests\Unit;

use App\Models\EvalCache;
use App\Services\EvalCacheService;
use BaseApi\App;
use PHPUnit\Framework\TestCase;

/**
 * EvalCacheService + EvalCache model tests.
 *
 * phpunit.xml sets DB_CONNECTION=sqlite (:memory:) for the test env, but
 * config/app.php's database driver resolves `DB_DRIVER ?? DB_CONNECTION`, and
 * this project's `.env` sets `DB_DRIVER=mysql` unconditionally — that takes
 * priority (pre-existing project config, not something this task changed), so
 * App::db() actually connects to the real local dev MySQL database, same as
 * every other DB-touching part of this app in the test process. No existing
 * test in this repo exercises the DB (they're all pure-logic unit tests), so
 * there's no established isolation pattern to follow here.
 *
 * That means this test runs against the REAL `eval_cache_test` table this task
 * created via `php mason migrate:generate` + `migrate:apply -y` (see the
 * report). The CREATE TABLE below is a defensive fallback only — `IF NOT
 * EXISTS`, byte-identical to that migration's SQL — so this test file is
 * self-sufficient if it's ever run before the migration has been applied; it
 * does not replace or duplicate the mason migration workflow. Each test
 * cleans the table's rows in setUp() for isolation between runs.
 */
class EvalCacheServiceTest extends TestCase
{
    private EvalCacheService $service;

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
        // Mirrors the CREATE TABLE `eval_cache_test` migration exactly (MySQL/InnoDB
        // doesn't allow a DEFAULT on TEXT columns, hence no default there).
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

        $this->service = new EvalCacheService();
    }

    protected function tearDown(): void
    {
        EvalCache::$table = null;
        parent::tearDown();
    }

    private const START_FEN = 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1';

    // --- normalizeKey() ---

    /**
     * Producers disagree about the en-passant field: zugzwang (like Stockfish)
     * only writes it when the capture is actually available, chess.js and the
     * frontend write it after every double push. Keying on the raw field meant
     * the same position arrived under two keys and every post-double-push
     * position missed — measured on the exported book, only 18 of 5,428
     * positions carry a live ep square, so this was most of the opening.
     */
    public function test_normalize_key_drops_a_dead_en_passant_square(): void
    {
        $boardSpelling = 'rnbqkbnr/pppppppp/8/8/4P3/8/PPPP1PPP/RNBQKBNR b KQkq e3 0 1';
        $engineSpelling = 'rnbqkbnr/pppppppp/8/8/4P3/8/PPPP1PPP/RNBQKBNR b KQkq - 0 1';

        $this->assertSame(
            $this->service->normalizeKey($engineSpelling),
            $this->service->normalizeKey($boardSpelling),
            'both spellings of the same position must produce one key',
        );
        $this->assertStringEndsWith(' -', $this->service->normalizeKey($boardSpelling));
    }

    public function test_normalize_key_keeps_a_live_en_passant_square(): void
    {
        // Black pawn on d4 sits beside the e-pawn that just pushed to e4, so the
        // ep capture is genuinely on and the position is NOT the same as one
        // without ep rights.
        $fen = 'rnbqkbnr/ppp1pppp/8/8/3pP3/8/PPPP1PPP/RNBQKBNR b KQkq e3 0 2';
        $this->assertStringEndsWith(' e3', $this->service->normalizeKey($fen));
    }

    public function test_normalize_key_en_passant_disagreement_degrades_to_a_miss_not_a_wrong_eval(): void
    {
        // The adjacency test is deliberately not a legality test — a pinned
        // capturer would make the engine drop the square while we keep it. That
        // direction costs a cache miss. The opposite direction (we drop it, the
        // engine kept it) would serve an eval computed without ep rights for a
        // position that has them, and must never happen: whenever an adjacent
        // enemy pawn exists we keep the square.
        $withCapturer = 'rnbqkbnr/ppp1pppp/8/8/3pP3/8/PPPP1PPP/RNBQKBNR b KQkq e3 0 2';
        $withoutCapturer = 'rnbqkbnr/pppppppp/8/8/4P3/8/PPPP1PPP/RNBQKBNR b KQkq e3 0 1';
        $this->assertStringEndsWith(' e3', $this->service->normalizeKey($withCapturer));
        $this->assertStringEndsWith(' -', $this->service->normalizeKey($withoutCapturer));
    }

    public function test_normalize_key_strips_halfmove_and_fullmove(): void
    {
        $key = $this->service->normalizeKey(self::START_FEN);

        $this->assertSame('rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq -', $key);
    }

    public function test_normalize_key_same_for_different_move_numbers(): void
    {
        $a = $this->service->normalizeKey('rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1');
        $b = $this->service->normalizeKey('rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 12 37');

        $this->assertSame($a, $b);
    }

    public function test_normalize_key_differs_on_castling_rights(): void
    {
        $a = $this->service->normalizeKey('rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1');
        $b = $this->service->normalizeKey('rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w Kkq - 0 1');

        $this->assertNotSame($a, $b);
    }

    public function test_normalize_key_differs_on_en_passant(): void
    {
        $a = $this->service->normalizeKey('rnbqkbnr/ppp1pppp/8/3pP3/8/8/PPPP1PPP/RNBQKBNR w KQkq d6 0 3');
        $b = $this->service->normalizeKey('rnbqkbnr/ppp1pppp/8/3pP3/8/8/PPPP1PPP/RNBQKBNR w KQkq - 0 3');

        $this->assertNotSame($a, $b);
    }

    // --- get() ---

    public function test_get_returns_null_when_stored_depth_below_requested(): void
    {
        $this->putResult(self::START_FEN, depth: 10, multipv: 1);

        $this->assertNull($this->service->get(self::START_FEN, 20, 1));
    }

    public function test_get_returns_entry_when_stored_depth_meets_requested(): void
    {
        $this->putResult(self::START_FEN, depth: 20, multipv: 1);

        $entry = $this->service->get(self::START_FEN, 20, 1);

        $this->assertInstanceOf(EvalCache::class, $entry);
        $this->assertSame(20, $entry->depth);
    }

    public function test_get_returns_entry_when_stored_depth_exceeds_requested(): void
    {
        $this->putResult(self::START_FEN, depth: 30, multipv: 1);

        $entry = $this->service->get(self::START_FEN, 20, 1);

        $this->assertInstanceOf(EvalCache::class, $entry);
    }

    public function test_get_returns_null_when_stored_multipv_below_requested(): void
    {
        $this->putResult(self::START_FEN, depth: 20, multipv: 1);

        $this->assertNull($this->service->get(self::START_FEN, 20, 3));
    }

    public function test_get_returns_entry_when_stored_multipv_meets_requested(): void
    {
        $this->putResult(self::START_FEN, depth: 20, multipv: 3);

        $entry = $this->service->get(self::START_FEN, 20, 3);

        $this->assertInstanceOf(EvalCache::class, $entry);
    }

    public function test_get_bumps_used_at_on_hit(): void
    {
        $this->putResult(self::START_FEN, depth: 20, multipv: 1);
        $stored = EvalCache::firstWhere('fen_key', '=', $this->service->normalizeKey(self::START_FEN));
        $this->assertInstanceOf(EvalCache::class, $stored);
        $this->assertNull($stored->used_at);

        $this->service->get(self::START_FEN, 20, 1);

        $reloaded = EvalCache::firstWhere('fen_key', '=', $this->service->normalizeKey(self::START_FEN));
        $this->assertInstanceOf(EvalCache::class, $reloaded);
        $this->assertNotNull($reloaded->used_at);
    }

    // --- put() ---

    public function test_put_does_not_downgrade_deeper_existing_entry(): void
    {
        $this->putResult(self::START_FEN, depth: 30, multipv: 1, nodes: 1_000_000);
        $this->putResult(self::START_FEN, depth: 10, multipv: 1, nodes: 999);

        $entry = EvalCache::firstWhere('fen_key', '=', $this->service->normalizeKey(self::START_FEN));
        $this->assertInstanceOf(EvalCache::class, $entry);
        $this->assertSame(30, $entry->depth);
        $this->assertSame(1_000_000, $entry->nodes);
    }

    public function test_put_upgrades_on_greater_depth(): void
    {
        $this->putResult(self::START_FEN, depth: 10, multipv: 1);
        $this->putResult(self::START_FEN, depth: 25, multipv: 1);

        $entry = EvalCache::firstWhere('fen_key', '=', $this->service->normalizeKey(self::START_FEN));
        $this->assertInstanceOf(EvalCache::class, $entry);
        $this->assertSame(25, $entry->depth);
    }

    public function test_put_upgrades_on_more_multipv_at_equal_depth(): void
    {
        $this->putResult(self::START_FEN, depth: 20, multipv: 1);
        $this->putResult(self::START_FEN, depth: 20, multipv: 5);

        $entry = EvalCache::firstWhere('fen_key', '=', $this->service->normalizeKey(self::START_FEN));
        $this->assertInstanceOf(EvalCache::class, $entry);
        $this->assertSame(5, $entry->multipv);
        $this->assertSame(20, $entry->depth);
    }

    public function test_put_does_not_downgrade_on_fewer_multipv_at_equal_depth(): void
    {
        $this->putResult(self::START_FEN, depth: 20, multipv: 5);
        $this->putResult(self::START_FEN, depth: 20, multipv: 1);

        $entry = EvalCache::firstWhere('fen_key', '=', $this->service->normalizeKey(self::START_FEN));
        $this->assertInstanceOf(EvalCache::class, $entry);
        $this->assertSame(5, $entry->multipv);
    }

    public function test_put_upgrades_on_equal_depth_more_nodes(): void
    {
        $this->putResult(self::START_FEN, depth: 20, multipv: 1, nodes: 100);
        $this->putResult(self::START_FEN, depth: 20, multipv: 1, nodes: 500);

        $entry = EvalCache::firstWhere('fen_key', '=', $this->service->normalizeKey(self::START_FEN));
        $this->assertInstanceOf(EvalCache::class, $entry);
        $this->assertSame(500, $entry->nodes);
    }

    // --- isCacheable() ---

    public function test_is_cacheable_false_at_halfmove_clock_80(): void
    {
        $fen = 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 80 45';

        $this->assertFalse($this->service->isCacheable($fen, []));
    }

    public function test_is_cacheable_false_above_halfmove_clock_80(): void
    {
        $fen = 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 95 45';

        $this->assertFalse($this->service->isCacheable($fen, []));
    }

    public function test_is_cacheable_true_below_halfmove_clock_80(): void
    {
        $fen = 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 79 45';

        $this->assertTrue($this->service->isCacheable($fen, []));
    }

    public function test_is_cacheable_false_when_position_repeats_in_history(): void
    {
        $current = 'r1bqkbnr/pppp1ppp/2n5/4p3/4P3/2N5/PPPP1PPP/R1BQKBNR w KQkq - 4 3';
        // Same position reached earlier along the line, with different move
        // counters — must still be detected via the NORMALIZED key.
        $priorSamePosition = 'r1bqkbnr/pppp1ppp/2n5/4p3/4P3/2N5/PPPP1PPP/R1BQKBNR w KQkq - 0 1';
        $history = [self::START_FEN, $priorSamePosition];

        $this->assertFalse($this->service->isCacheable($current, $history));
    }

    public function test_is_cacheable_true_for_normal_opening_position_not_in_history(): void
    {
        $current = 'rnbqkbnr/pppp1ppp/8/4p3/4P3/8/PPPP1PPP/RNBQKBNR w KQkq - 0 2';
        $history = [self::START_FEN];

        $this->assertTrue($this->service->isCacheable($current, $history));
    }

    // --- JSON round-trip (array-cast footgun) ---

    public function test_pv_and_lines_round_trip_through_save_and_reload_as_real_arrays(): void
    {
        $pv = ['e2e4', 'e7e5', 'g1f3'];
        $lines = [
            ['multipv' => 1, 'eval' => ['type' => 'cp', 'value' => 25], 'pv' => ['e2e4']],
            ['multipv' => 2, 'eval' => ['type' => 'cp', 'value' => 20], 'pv' => ['d2d4']],
        ];

        $entry = new EvalCache();
        $entry->fen_key = $this->service->normalizeKey(self::START_FEN);
        $entry->depth = 20;
        $entry->multipv = 2;
        $entry->eval_type = 'cp';
        $entry->eval_value = 25;
        $entry->bestmove = 'e2e4';
        $entry->setPv($pv);
        $entry->setLines($lines);
        $entry->save();

        // Fresh instance from the DB — proves the JSON survived a real
        // round-trip, not just in-memory state on the same object. If the
        // array-cast footgun applied here, `pv`/`lines` would have been
        // written as the literal string "Array".
        $reloaded = EvalCache::firstWhere('fen_key', '=', $entry->fen_key);
        $this->assertInstanceOf(EvalCache::class, $reloaded);
        $this->assertNotSame('Array', $reloaded->pv);
        $this->assertNotSame('Array', $reloaded->lines);
        $this->assertSame($pv, $reloaded->getPv());
        $this->assertSame($lines, $reloaded->getLines());
    }

    /**
     * Build a minimal /analyze-shaped result array and put() it.
     */
    // --- tablebase verdicts are never cached ---

    /**
     * The cache key drops the halfmove clock (normalizeKey), and the halfmove
     * clock is exactly what decides whether a Syzygy win is real or cursed — so
     * the same key legitimately has two different answers. The row also has no
     * column for the `tb` tag, so storing one would downgrade the verdict back
     * to a bare "+10.00". A TB probe is instant; nothing is lost by re-deriving.
     */
    public function test_put_refuses_a_tablebase_verdict(): void
    {
        $this->service->put(self::START_FEN, [
            'eval' => ['type' => 'cp', 'value' => 1000, 'tb' => 'win'],
            'bestmove' => 'e2e4',
            'pv' => ['e2e4'],
            'depth' => 30,
        ]);

        $this->assertNull(EvalCache::firstWhere('fen_key', '=', $this->service->normalizeKey(self::START_FEN)));
    }

    public function test_put_refuses_a_raw_pre_fix_tablebase_value(): void
    {
        $this->service->put(self::START_FEN, [
            'eval' => ['type' => 'cp', 'value' => 31497], // VALUE_TB_WIN, untagged
            'bestmove' => 'e2e4',
            'pv' => ['e2e4'],
            'depth' => 30,
        ]);

        $this->assertNull(EvalCache::firstWhere('fen_key', '=', $this->service->normalizeKey(self::START_FEN)));
    }

    /**
     * Rows written before put() learned to refuse verdicts are still on disk.
     * Serving one would render "+314.97", so it reads as a miss and the engine
     * re-derives it with its tag.
     */
    public function test_get_treats_a_stored_raw_tablebase_value_as_a_miss(): void
    {
        $entry = new EvalCache();
        $entry->fen_key = $this->service->normalizeKey(self::START_FEN);
        $entry->depth = 30;
        $entry->multipv = 1;
        $entry->eval_type = 'cp';
        $entry->eval_value = 31497;
        $entry->source = 'zugzwang';
        $entry->nodes = 0;
        $entry->save();

        $this->assertNull($this->service->get(self::START_FEN, 20, 1));
    }

    private function putResult(string $fen, int $depth, int $multipv, int $nodes = 0): void
    {
        $lines = [];
        for ($i = 0; $i < $multipv; $i++) {
            $lines[] = ['multipv' => $i + 1, 'eval' => ['type' => 'cp', 'value' => 10 + $i], 'pv' => ['e2e4']];
        }

        $this->service->put($fen, [
            'eval' => ['type' => 'cp', 'value' => 25],
            'bestmove' => 'e2e4',
            'pv' => ['e2e4', 'e7e5'],
            'depth' => $depth,
            'nodes' => $nodes,
            'lines' => $lines,
        ]);
    }
}
