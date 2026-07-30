<?php

namespace App\Tests\Unit;

use App\Models\EvalCache;
use App\Services\BookEvalImportService;
use BaseApi\App;
use PHPUnit\Framework\TestCase;

/**
 * BookEvalImportService — the zugzwang opening-book (book.bin) TSV importer's
 * core logic (scripts/import_book_evals.php's CLI is a thin wrapper around
 * this + a transaction).
 *
 * DB tests share the real dev `eval_cache_test` table (see EvalCacheServiceTest's
 * doc comment for why: DB_DRIVER=mysql in .env overrides phpunit.xml's
 * sqlite env for this project). Like LichessEvalImportServiceTest (and
 * UNLIKE EvalCacheServiceTest, which wipes the whole table), this suite
 * tracks exactly the rows it creates and deletes only those in tearDown, so
 * it's safe to run alongside other work touching eval_cache.
 */
class BookEvalImportTest extends TestCase
{
    private BookEvalImportService $service;

    /** @var list<string> */
    private array $evalCacheIdsToClean = [];

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

        $this->service = new BookEvalImportService();
    }

    protected function tearDown(): void
    {
        if ($this->evalCacheIdsToClean !== []) {
            $placeholders = implode(',', array_fill(0, count($this->evalCacheIdsToClean), '?'));
            App::db()->exec("DELETE FROM eval_cache_test WHERE id IN ({$placeholders})", $this->evalCacheIdsToClean);
        }

        EvalCache::$table = null;
        parent::tearDown();
    }

    private const START_FEN = 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1';

    // ------------------------------------------------------------------
    // Score/mate perspective — the book's score/mate fields are already
    // side-to-move relative (see BookEvalImportService's doc comment for how
    // this was determined: serve_handlers.cpp's book_eval_json() doc
    // comment, cross-referenced against eval_json()'s own doc comment and
    // EvalCache::$eval_value's doc comment — all three agree: side-to-move
    // POV, no sign flip). Unlike the Lichess importer (whose dump is
    // white-relative and DOES negate for black), this importer must pass
    // score/mate straight through regardless of which side is to move.
    // ------------------------------------------------------------------

    public function test_convert_line_keeps_cp_sign_for_white_to_move(): void
    {
        $line = "rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1\t33\t0\t22\te2e4 e7e5";

        $row = $this->service->convertLine($line);

        $this->assertNotNull($row);
        $this->assertSame('cp', $row['eval']['type']);
        $this->assertSame(33, $row['eval']['value']);
    }

    public function test_convert_line_keeps_cp_sign_for_black_to_move(): void
    {
        // Same numeric score, only side-to-move flips. If the book's score
        // were white-relative (like Lichess's dump), this would need
        // negation to -103; it does not, per the finding above.
        $line = "rnbqkbnr/ppp2ppp/8/3pp3/5P2/6PN/PPPPP2P/RNBQKB1R b KQkq - 0 3\t103\t0\t22\te5e4 d2d3";

        $row = $this->service->convertLine($line);

        $this->assertNotNull($row);
        $this->assertSame('cp', $row['eval']['type']);
        $this->assertSame(103, $row['eval']['value']);
    }

    public function test_convert_line_keeps_negative_cp_sign_for_white_to_move(): void
    {
        $line = "rn1qkbnr/ppp2ppp/8/3pp3/5P2/6Pb/PPPPP2P/RNBQKB1R w KQkq - 0 4\t-86\t0\t22\tf1h3 e5f4";

        $row = $this->service->convertLine($line);

        $this->assertNotNull($row);
        $this->assertSame('cp', $row['eval']['type']);
        $this->assertSame(-86, $row['eval']['value']);
    }

    // ------------------------------------------------------------------
    // Mate entries — the current book.bin has none, but the GMBK format
    // allows them and the importer must map them correctly regardless of
    // side to move (same no-sign-flip rule as cp).
    // ------------------------------------------------------------------

    public function test_convert_line_maps_positive_mate_for_white_to_move(): void
    {
        $line = "6k1/6p1/8/4K3/4NN2/8/8/8 w - - 0 1\t0\t7\t22\te5e6 g8f8";

        $row = $this->service->convertLine($line);

        $this->assertNotNull($row);
        $this->assertSame('mate', $row['eval']['type']);
        $this->assertSame(7, $row['eval']['value']);
    }

    public function test_convert_line_maps_negative_mate_for_black_to_move(): void
    {
        // A negative mate value: the side to move is the one getting mated,
        // same signed convention as eval_json()'s mate distance. No flip
        // applied merely because black is to move.
        $line = "6k1/6p1/8/4K3/4NN2/8/8/8 b - - 0 1\t0\t-3\t22\tg8f8 e5e6";

        $row = $this->service->convertLine($line);

        $this->assertNotNull($row);
        $this->assertSame('mate', $row['eval']['type']);
        $this->assertSame(-3, $row['eval']['value']);
    }

    public function test_convert_line_mate_field_wins_over_nonzero_score(): void
    {
        // Mirrors book_eval_json()'s rule: mate != 0 wins even if score is
        // also populated (shouldn't happen in practice, but the C++ reader
        // doesn't special-case it either).
        $line = "6k1/6p1/8/4K3/4NN2/8/8/8 w - - 0 1\t900\t4\t22\te5e6";

        $row = $this->service->convertLine($line);

        $this->assertNotNull($row);
        $this->assertSame('mate', $row['eval']['type']);
        $this->assertSame(4, $row['eval']['value']);
    }

    // ------------------------------------------------------------------
    // Malformed/short TSV lines — must be skipped (return null), never throw
    // or abort the run.
    // ------------------------------------------------------------------

    public function test_convert_line_returns_null_for_empty_line(): void
    {
        $this->assertNull($this->service->convertLine(''));
        $this->assertNull($this->service->convertLine("\n"));
    }

    public function test_convert_line_returns_null_for_too_few_fields(): void
    {
        $this->assertNull($this->service->convertLine(self::START_FEN . "\t33\t0"));
    }

    public function test_convert_line_returns_null_for_too_many_fields(): void
    {
        $this->assertNull($this->service->convertLine(self::START_FEN . "\t33\t0\t22\te2e4\textra"));
    }

    public function test_convert_line_returns_null_for_non_numeric_score(): void
    {
        $this->assertNull($this->service->convertLine(self::START_FEN . "\tNaN\t0\t22\te2e4"));
    }

    public function test_convert_line_returns_null_for_non_numeric_depth(): void
    {
        $this->assertNull($this->service->convertLine(self::START_FEN . "\t33\t0\tdeep\te2e4"));
    }

    public function test_convert_line_returns_null_for_zero_depth(): void
    {
        $this->assertNull($this->service->convertLine(self::START_FEN . "\t33\t0\t0\te2e4"));
    }

    public function test_convert_line_returns_null_for_empty_pv(): void
    {
        $this->assertNull($this->service->convertLine(self::START_FEN . "\t33\t0\t22\t"));
    }

    public function test_convert_line_returns_null_for_short_fen(): void
    {
        // Only 4 fields (a normalizeKey()-shaped key, not a full FEN) — the
        // importer requires the full 6-field FEN book_export.cpp emits.
        $this->assertNull($this->service->convertLine('rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq' . "\t33\t0\t22\te2e4"));
    }

    public function test_convert_line_returns_null_for_garbage(): void
    {
        $this->assertNull($this->service->convertLine('not a tsv line at all'));
    }

    public function test_convert_line_parses_bestmove_and_pv(): void
    {
        $line = self::START_FEN . "\t33\t0\t22\te2e4 e7e5 g1f3 b8c6";

        $row = $this->service->convertLine($line);

        $this->assertNotNull($row);
        $this->assertSame('e2e4', $row['bestmove']);
        $this->assertSame(['e2e4', 'e7e5', 'g1f3', 'b8c6'], $row['pv']);
        $this->assertSame(22, $row['depth']);
        $this->assertSame(self::START_FEN, $row['fen']);
    }

    // ------------------------------------------------------------------
    // Never-downgrade: importRow() must not clobber a deeper stored row.
    // Verifies the SAME EvalCacheService::put() ordering AnalyzeController's
    // live-search path relies on, not a reimplementation of it.
    // ------------------------------------------------------------------

    public function test_never_downgrade_holds_a_depth_22_book_row_does_not_clobber_a_deeper_stored_row(): void
    {
        $fen = $this->uniqueFen();
        $key = $this->cache()->normalizeKey($fen);

        // Seed a "deeper" existing entry directly (as if a live /analyze
        // search had already reached depth 40 on this position).
        $deep = new EvalCache();
        $deep->fen_key = $key;
        $deep->depth = 40;
        $deep->multipv = 1;
        $deep->eval_type = 'cp';
        $deep->eval_value = 12;
        $deep->bestmove = 'a2a3';
        $deep->setPv(['a2a3']);
        $deep->source = 'zugzwang';
        $deep->nodes = 5_000_000;
        $deep->save();
        $this->evalCacheIdsToClean[] = $deep->id;

        $bookRow = $this->service->convertLine("{$fen}\t33\t0\t22\te2e4 e7e5");
        $this->assertNotNull($bookRow);

        $status = $this->service->importRow($bookRow);
        $this->assertSame('skip', $status);

        $stored = EvalCache::firstWhere('fen_key', '=', $key);
        $this->assertInstanceOf(EvalCache::class, $stored);
        $this->assertSame(40, $stored->depth, 'the depth-22 book row must not clobber the stored depth-40 row');
        $this->assertSame(12, $stored->eval_value);
        $this->assertSame('a2a3', $stored->bestmove);
    }

    public function test_a_book_row_does_insert_into_an_empty_slot(): void
    {
        $fen = $this->uniqueFen();
        $key = $this->cache()->normalizeKey($fen);

        $bookRow = $this->service->convertLine("{$fen}\t33\t0\t22\te2e4 e7e5");
        $this->assertNotNull($bookRow);

        $status = $this->service->importRow($bookRow);
        $this->assertSame('insert', $status);

        $stored = EvalCache::firstWhere('fen_key', '=', $key);
        $this->assertInstanceOf(EvalCache::class, $stored);
        $this->evalCacheIdsToClean[] = $stored->id;
        $this->assertSame(22, $stored->depth);
        $this->assertSame(33, $stored->eval_value);
        $this->assertSame('book', $stored->source);
        $this->assertSame(1, $stored->multipv);
        $this->assertSame(['e2e4', 'e7e5'], $stored->getPv());
    }

    // ------------------------------------------------------------------
    // Idempotence: importing the same row twice must leave the table
    // identical (second import classified as 'skip', no duplicate row).
    // ------------------------------------------------------------------

    public function test_idempotent_reimport_of_same_row_yields_same_state_and_no_duplicate(): void
    {
        $fen = $this->uniqueFen();
        $key = $this->cache()->normalizeKey($fen);
        $bookRow = $this->service->convertLine("{$fen}\t33\t0\t22\te2e4 e7e5");
        $this->assertNotNull($bookRow);

        $first = $this->service->importRow($bookRow);
        $this->assertSame('insert', $first);
        $stored = EvalCache::firstWhere('fen_key', '=', $key);
        $this->assertInstanceOf(EvalCache::class, $stored);
        $this->evalCacheIdsToClean[] = $stored->id;

        $second = $this->service->importRow($bookRow);
        $this->assertSame('skip', $second, 're-importing the identical row is not an improvement');

        $rows = App::db()->raw('SELECT id FROM eval_cache_test WHERE fen_key = ?', [$key]);
        $this->assertCount(1, $rows, 're-importing the same record must not create a duplicate row');

        $after = EvalCache::firstWhere('fen_key', '=', $key);
        $this->assertInstanceOf(EvalCache::class, $after);
        $this->assertSame($stored->depth, $after->depth);
        $this->assertSame($stored->eval_value, $after->eval_value);
        $this->assertSame($stored->id, $after->id);
    }

    // ------------------------------------------------------------------
    // helpers
    // ------------------------------------------------------------------

    private function cache(): \App\Services\EvalCacheService
    {
        return new \App\Services\EvalCacheService();
    }

    /** Syntactically FEN-shaped, not necessarily a real reachable position —
     *  fine, fen_key/normalizeKey are pure strings with no legality check.
     *  Randomized so parallel/repeated test runs never collide. */
    private function uniqueFen(): string
    {
        // Full 6-field FEN (book_export.cpp always emits all 6 fields) —
        // syntactically FEN-shaped, not necessarily a reachable position;
        // fine, fen_key/normalizeKey are pure strings with no legality
        // check. Randomized so parallel/repeated test runs never collide.
        return sprintf('8/8/8/8/8/8/8/%s w - - 0 1', substr(bin2hex(random_bytes(4)), 0, 8));
    }
}
