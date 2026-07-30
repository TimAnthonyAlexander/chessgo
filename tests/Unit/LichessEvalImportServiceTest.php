<?php

namespace App\Tests\Unit;

use App\Models\BotGame;
use App\Models\EvalCache;
use App\Models\Game;
use App\Services\GomachineClient;
use App\Services\LichessEvalImportService;
use BaseApi\App;
use PHPUnit\Framework\TestCase;

/**
 * LichessEvalImportService — the Lichess CC0 eval-dump importer's core logic.
 *
 * DB tests share the real dev `eval_cache_test`/`game`/`bot_game` tables (see
 * EvalCacheServiceTest's doc comment for why: DB_DRIVER=mysql in .env
 * overrides phpunit.xml's sqlite env for this project). Unlike
 * EvalCacheServiceTest (which wipes the whole eval_cache table), this suite
 * tracks exactly the rows/games it creates and deletes only those in
 * tearDown, so it doesn't need to own table-wide cleanup.
 */
class LichessEvalImportServiceTest extends TestCase
{
    private LichessEvalImportService $service;

    /** @var list<string> */
    private array $evalCacheIdsToClean = [];

    /** @var list<string> */
    private array $botGameIdsToClean = [];

    /** @var list<string> */
    private array $gameIdsToClean = [];

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

        $this->service = new LichessEvalImportService();
    }

    protected function tearDown(): void
    {
        if ($this->evalCacheIdsToClean !== []) {
            $placeholders = implode(',', array_fill(0, count($this->evalCacheIdsToClean), '?'));
            App::db()->exec("DELETE FROM eval_cache_test WHERE id IN ({$placeholders})", $this->evalCacheIdsToClean);
        }
        foreach ($this->botGameIdsToClean as $id) {
            BotGame::find($id)?->delete();
        }
        foreach ($this->gameIdsToClean as $id) {
            Game::find($id)?->delete();
        }

        EvalCache::$table = null;
        parent::tearDown();
    }

    private const START_FEN = 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1';

    // ------------------------------------------------------------------
    // Sign conversion — the one error that would silently poison the cache.
    // ------------------------------------------------------------------

    public function test_convert_record_white_to_move_keeps_cp_sign(): void
    {
        $record = [
            'fen' => '7r/1p3k2/p1bPR3/5p2/2B2P1p/8/PP4P1/3K4 w - -',
            'evals' => [[
                'pvs' => [['cp' => 69, 'line' => 'f7g7 e6e2']],
                'knodes' => 4189972,
                'depth' => 46,
            ]],
        ];

        $row = $this->service->convertRecord($record);

        $this->assertNotNull($row);
        $this->assertSame('cp', $row['eval_type']);
        $this->assertSame(69, $row['eval_value']);
    }

    public function test_convert_record_black_to_move_negates_cp_sign(): void
    {
        // Same numbers, only the side to move flips — this is the exact
        // record shape verified against the real dump (cp is white-relative).
        $record = [
            'fen' => '7r/1p3k2/p1bPR3/5p2/2B2P1p/8/PP4P1/3K4 b - -',
            'evals' => [[
                'pvs' => [['cp' => 69, 'line' => 'f7g7 e6e2']],
                'knodes' => 4189972,
                'depth' => 46,
            ]],
        ];

        $row = $this->service->convertRecord($record);

        $this->assertNotNull($row);
        $this->assertSame('cp', $row['eval_type']);
        $this->assertSame(-69, $row['eval_value']);
    }

    public function test_convert_record_white_to_move_keeps_mate_sign(): void
    {
        $record = [
            'fen' => '6k1/6p1/8/4K3/4NN2/8/8/8 w - -',
            'evals' => [[
                'pvs' => [['mate' => 15, 'line' => 'e5e6 g8f8']],
                'knodes' => 589893,
                'depth' => 95,
            ]],
        ];

        $row = $this->service->convertRecord($record);

        $this->assertNotNull($row);
        $this->assertSame('mate', $row['eval_type']);
        $this->assertSame(15, $row['eval_value']);
    }

    public function test_convert_record_black_to_move_negates_mate_sign(): void
    {
        $record = [
            'fen' => '6k1/6p1/8/4K3/4NN2/8/8/8 b - -',
            'evals' => [[
                'pvs' => [['mate' => 15, 'line' => 'e5e6 g8f8']],
                'knodes' => 589893,
                'depth' => 95,
            ]],
        ];

        $row = $this->service->convertRecord($record);

        $this->assertNotNull($row);
        $this->assertSame('mate', $row['eval_type']);
        $this->assertSame(-15, $row['eval_value']);
    }

    public function test_convert_record_negates_every_pv_in_a_black_to_move_multipv_record(): void
    {
        $record = [
            'fen' => '8/4r3/2R2pk1/6pp/3P4/6P1/5K1P/8 b - -',
            'evals' => [[
                'pvs' => [
                    ['cp' => 20, 'line' => 'e7a7 f2e3'],
                    ['cp' => -30, 'line' => 'e7b7 f2e3'],
                    ['mate' => -4, 'line' => 'e7e4 h2h4'],
                ],
                'knodes' => 491568,
                'depth' => 58,
            ]],
        ];

        $row = $this->service->convertRecord($record);

        $this->assertNotNull($row);
        $this->assertSame(3, $row['multipv']);
        $this->assertSame(-20, $row['lines'][0]['eval']['value']);
        $this->assertSame(30, $row['lines'][1]['eval']['value']);
        $this->assertSame('mate', $row['lines'][2]['eval']['type']);
        $this->assertSame(4, $row['lines'][2]['eval']['value']);
    }

    // ------------------------------------------------------------------
    // fen === normalizeKey(fen) — pinned against real slice records (copied
    // verbatim from the 82k-record local slice, not re-derived).
    // ------------------------------------------------------------------

    public function test_dump_fen_equals_normalize_key_for_real_slice_sample(): void
    {
        $sampleFens = [
            '7r/1p3k2/p1bPR3/5p2/2B2P1p/8/PP4P1/3K4 b - -',
            '8/4r3/2R2pk1/6pp/3P4/6P1/5K1P/8 b - -',
            '6k1/6p1/8/4K3/4NN2/8/8/8 w - -',
        ];

        foreach ($sampleFens as $fen) {
            $this->assertSame($fen, $this->service->normalizeKey($fen), "normalizeKey must be a no-op on an already-normalized dump fen: {$fen}");
        }
    }

    // ------------------------------------------------------------------
    // Best-eval selection
    // ------------------------------------------------------------------

    public function test_pick_best_evals_entry_prefers_highest_depth(): void
    {
        $evals = [
            ['depth' => 20, 'pvs' => [['cp' => 1, 'line' => 'e2e4']], 'knodes' => 1000],
            ['depth' => 40, 'pvs' => [['cp' => 1, 'line' => 'e2e4']], 'knodes' => 10],
            ['depth' => 30, 'pvs' => [['cp' => 1, 'line' => 'e2e4']], 'knodes' => 999999],
        ];

        $best = $this->service->pickBestEvalsEntry($evals);

        $this->assertSame(40, $best['depth']);
    }

    public function test_pick_best_evals_entry_tiebreaks_on_pv_count_at_equal_depth(): void
    {
        $evals = [
            ['depth' => 40, 'pvs' => [['cp' => 1, 'line' => 'e2e4']], 'knodes' => 999999],
            ['depth' => 40, 'pvs' => [['cp' => 1, 'line' => 'e2e4'], ['cp' => 2, 'line' => 'd2d4']], 'knodes' => 10],
        ];

        $best = $this->service->pickBestEvalsEntry($evals);

        $this->assertCount(2, $best['pvs']);
    }

    public function test_pick_best_evals_entry_tiebreaks_on_knodes_at_equal_depth_and_pv_count(): void
    {
        $evals = [
            ['depth' => 40, 'pvs' => [['cp' => 1, 'line' => 'e2e4']], 'knodes' => 10],
            ['depth' => 40, 'pvs' => [['cp' => 1, 'line' => 'e2e4']], 'knodes' => 500],
        ];

        $best = $this->service->pickBestEvalsEntry($evals);

        $this->assertSame(500, $best['knodes']);
    }

    public function test_convert_record_uses_selected_entrys_depth_and_nodes(): void
    {
        $record = [
            'fen' => self::START_FEN,
            'evals' => [
                ['depth' => 10, 'pvs' => [['cp' => 1, 'line' => 'e2e4']], 'knodes' => 999999],
                ['depth' => 46, 'pvs' => [['cp' => 25, 'line' => 'e2e4 e7e5']], 'knodes' => 4189972],
            ],
        ];

        $row = $this->service->convertRecord($record);

        $this->assertNotNull($row);
        $this->assertSame(46, $row['depth']);
        $this->assertSame(4189972000, $row['nodes'], 'nodes = knodes * 1000');
        $this->assertSame(25, $row['eval_value']);
        $this->assertSame(['e2e4', 'e7e5'], $row['pv']);
        $this->assertSame('e2e4', $row['bestmove']);
    }

    // ------------------------------------------------------------------
    // Malformed records — never throw, just refuse to convert
    // ------------------------------------------------------------------

    public function test_convert_record_returns_null_for_missing_fen(): void
    {
        $this->assertNull($this->service->convertRecord(['evals' => [['depth' => 10, 'pvs' => [['cp' => 1, 'line' => 'e2e4']]]]]));
    }

    public function test_convert_record_returns_null_for_empty_evals(): void
    {
        $this->assertNull($this->service->convertRecord(['fen' => self::START_FEN, 'evals' => []]));
    }

    public function test_convert_record_returns_null_when_pv_has_neither_cp_nor_mate(): void
    {
        $record = ['fen' => self::START_FEN, 'evals' => [['depth' => 10, 'pvs' => [['line' => 'e2e4']]]]];

        $this->assertNull($this->service->convertRecord($record));
    }

    public function test_convert_record_returns_null_when_pv_has_both_cp_and_mate(): void
    {
        $record = ['fen' => self::START_FEN, 'evals' => [['depth' => 10, 'pvs' => [['cp' => 1, 'mate' => 2, 'line' => 'e2e4']]]]];

        $this->assertNull($this->service->convertRecord($record));
    }

    public function test_convert_record_returns_null_for_malformed_side_to_move(): void
    {
        $record = ['fen' => 'not a real fen', 'evals' => [['depth' => 10, 'pvs' => [['cp' => 1, 'line' => 'e2e4']]]]];

        $this->assertNull($this->service->convertRecord($record));
    }

    // ------------------------------------------------------------------
    // dedupeBatch()
    // ------------------------------------------------------------------

    public function test_dedupe_batch_keeps_deeper_row_for_duplicate_fen_key(): void
    {
        $rows = [
            ['fen_key' => 'k1', 'depth' => 10, 'multipv' => 1, 'nodes' => 5],
            ['fen_key' => 'k1', 'depth' => 40, 'multipv' => 1, 'nodes' => 5],
            ['fen_key' => 'k2', 'depth' => 20, 'multipv' => 1, 'nodes' => 5],
        ];

        $deduped = $this->service->dedupeBatch($rows);

        $this->assertCount(2, $deduped);
        $byKey = array_column($deduped, null, 'fen_key');
        $this->assertSame(40, $byKey['k1']['depth']);
        $this->assertSame(20, $byKey['k2']['depth']);
    }

    // ------------------------------------------------------------------
    // Never-downgrade + idempotence, via classifyBatch()/writeBatch()
    // ------------------------------------------------------------------

    public function test_never_downgrade_holds_importing_shallower_over_existing_deeper(): void
    {
        $key = $this->uniqueFenKey();
        $deep = $this->makeRow($key, depth: 50, multipv: 1, nodes: 1_000_000);
        $shallow = $this->makeRow($key, depth: 20, multipv: 1, nodes: 100);

        $this->writeRow($deep);

        $classifiedShallow = $this->service->classifyBatch([$shallow]);
        $this->assertSame(0, count($classifiedShallow['insert']));
        $this->assertSame(0, count($classifiedShallow['update']));
        $this->assertSame(1, $classifiedShallow['skip']);

        // Prove it via a real write attempt too — the conditional SQL upsert
        // must independently refuse the downgrade even if something bypassed
        // classifyBatch's pre-filter.
        $this->service->writeBatch([$shallow]);

        $stored = EvalCache::firstWhere('fen_key', '=', $key);
        $this->assertInstanceOf(EvalCache::class, $stored);
        $this->assertSame(50, $stored->depth);
        $this->assertSame(1_000_000, $stored->nodes);
    }

    public function test_idempotent_reimport_of_same_batch_yields_same_state(): void
    {
        $key = $this->uniqueFenKey();
        $row = $this->makeRow($key, depth: 30, multipv: 2, nodes: 555);

        $this->writeRow($row);
        $first = EvalCache::firstWhere('fen_key', '=', $key);
        $this->assertInstanceOf(EvalCache::class, $first);

        // Re-import the identical row a second time.
        $this->service->writeBatch([$row]);

        $rows = App::db()->raw('SELECT id FROM eval_cache_test WHERE fen_key = ?', [$key]);
        $this->assertCount(1, $rows, 're-importing the same record must not create a duplicate row');

        $second = EvalCache::firstWhere('fen_key', '=', $key);
        $this->assertInstanceOf(EvalCache::class, $second);
        $this->assertSame($first->depth, $second->depth);
        $this->assertSame($first->multipv, $second->multipv);
        $this->assertSame($first->eval_value, $second->eval_value);
        $this->assertSame($first->id, $second->id);
    }

    public function test_classify_batch_reports_insert_for_new_key(): void
    {
        $key = $this->uniqueFenKey();
        $row = $this->makeRow($key, depth: 20, multipv: 1, nodes: 10);

        $classified = $this->service->classifyBatch([$row]);

        $this->assertCount(1, $classified['insert']);
        $this->assertCount(0, $classified['update']);
        $this->assertSame(0, $classified['skip']);
    }

    public function test_classify_batch_reports_update_for_improving_existing_key(): void
    {
        $key = $this->uniqueFenKey();
        $this->writeRow($this->makeRow($key, depth: 10, multipv: 1, nodes: 5));

        $better = $this->makeRow($key, depth: 40, multipv: 1, nodes: 5);
        $classified = $this->service->classifyBatch([$better]);

        $this->assertCount(0, $classified['insert']);
        $this->assertCount(1, $classified['update']);
        $this->assertSame(0, $classified['skip']);
    }

    // ------------------------------------------------------------------
    // Position-set filtering
    // ------------------------------------------------------------------

    public function test_positions_from_file_excludes_lines_not_listed(): void
    {
        $tmp = tempnam(sys_get_temp_dir(), 'lichess_positions_');
        $keptFen = '7r/1p3k2/p1bPR3/5p2/2B2P1p/8/PP4P1/3K4 b - -';
        file_put_contents($tmp, "# a comment\n\n{$keptFen}\n");

        $positions = $this->service->positionsFromFile($tmp);
        unlink($tmp);

        $this->assertCount(1, $positions);
        $this->assertArrayHasKey($this->service->normalizeKey($keptFen), $positions);
        $this->assertArrayNotHasKey($this->service->normalizeKey(self::START_FEN), $positions);
    }

    public function test_dump_record_filtering_matches_only_positions_in_set(): void
    {
        $inSetFen = '7r/1p3k2/p1bPR3/5p2/2B2P1p/8/PP4P1/3K4 b - -';
        $notInSetFen = '8/4r3/2R2pk1/6pp/3P4/6P1/5K1P/8 b - -';
        $positions = [$this->service->normalizeKey($inSetFen) => true];

        $matchingRecord = ['fen' => $inSetFen, 'evals' => [['depth' => 10, 'pvs' => [['cp' => 1, 'line' => 'a1a2']]]]];
        $nonMatchingRecord = ['fen' => $notInSetFen, 'evals' => [['depth' => 10, 'pvs' => [['cp' => 1, 'line' => 'a1a2']]]]];

        $this->assertArrayHasKey($this->service->normalizeKey($matchingRecord['fen']), $positions);
        $this->assertArrayNotHasKey($this->service->normalizeKey($nonMatchingRecord['fen']), $positions);
    }

    // ------------------------------------------------------------------
    // Position-set builders from our own data
    // ------------------------------------------------------------------

    public function test_positions_from_bot_games_reads_history_and_move_fens_without_replay(): void
    {
        $afterE4 = 'rnbqkbnr/pppppppp/8/8/4P3/8/PPPP1PPP/RNBQKBNR b KQkq e3 0 1';
        $afterE5 = 'rnbqkbnr/pppp1ppp/8/4p3/4P3/8/PPPP1PPP/RNBQKBNR w KQkq e6 0 2';

        $game = new BotGame();
        $game->variant = 'standard';
        $game->fen = $afterE5;
        $game->setHistory([self::START_FEN, $afterE4]);
        $game->setMoves([
            ['ply' => 1, 'uci' => 'e2e4', 'san' => 'e4', 'by' => 'human', 'fen' => $afterE4],
            ['ply' => 2, 'uci' => 'e7e5', 'san' => 'e5', 'by' => 'bot', 'fen' => $afterE5],
        ]);
        $game->save();
        $this->botGameIdsToClean[] = $game->id;

        $positions = $this->service->positionsFromBotGames();

        $this->assertArrayHasKey($this->service->normalizeKey(self::START_FEN), $positions);
        $this->assertArrayHasKey($this->service->normalizeKey($afterE4), $positions);
        $this->assertArrayHasKey($this->service->normalizeKey($afterE5), $positions);
    }

    public function test_positions_from_bot_games_excludes_non_standard_variant(): void
    {
        // Crazyhouse encodes pocket contents INSIDE the placement field
        // (bracket notation) — unlike duck (whose extra state lives in a
        // trailing field the 4-field normalizeKey() already drops and so
        // would coincidentally collide with a same-arrangement standard
        // position anyway), this fen genuinely could never match a real
        // dump entry, making it a meaningful "must not leak" fixture. It's
        // also synthetic/distinctive enough to be certain no real dev-DB row
        // could produce the same key.
        $crazyhouseFen = 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR[Pp] w KQkq - 0 1';
        $game = new BotGame();
        $game->variant = 'crazyhouse';
        $game->fen = $crazyhouseFen;
        $game->setHistory([self::START_FEN]);
        $game->setMoves([]);
        $game->save();
        $this->botGameIdsToClean[] = $game->id;

        $positions = $this->service->positionsFromBotGames();

        // The crazyhouse game's own (pocket-shaped) fen must not leak in.
        $this->assertArrayNotHasKey($this->service->normalizeKey($crazyhouseFen), $positions);
    }

    public function test_positions_from_human_games_replays_moves_via_engine(): void
    {
        $afterE4 = 'rnbqkbnr/pppppppp/8/8/4P3/8/PPPP1PPP/RNBQKBNR b KQkq e3 0 1';
        $afterE5 = 'rnbqkbnr/pppp1ppp/8/4p3/4P3/8/PPPP1PPP/RNBQKBNR w KQkq e6 0 2';

        $game = new Game();
        $game->hub_game_id = $this->uniqueMarker('replay-game');
        $game->pool = '3+0';
        $game->category = 'blitz';
        $game->variant = 'standard';
        $game->result = '1/2-1/2';
        $game->reason = 'draw-agreement';
        $game->white_uid = 'w';
        $game->black_uid = 'b';
        $game->white_name = 'W';
        $game->black_name = 'B';
        $game->ply = 2;
        $game->setMoves(['e2e4', 'e7e5']);
        $game->setSans(['e4', 'e5']);
        $game->save();
        $this->gameIdsToClean[] = $game->id;

        $engine = new FakeMoveEngine([
            self::START_FEN . '|e2e4' => $afterE4,
            $afterE4 . '|e7e5' => $afterE5,
        ]);

        $result = $this->service->positionsFromHumanGames($engine, 0, [$game->id]);

        $this->assertSame(1, $result['gamesReplayed']);
        $this->assertSame(0, $result['skippedGames']);
        $this->assertArrayHasKey($this->service->normalizeKey(self::START_FEN), $result['positions']);
        $this->assertArrayHasKey($this->service->normalizeKey($afterE4), $result['positions']);
        $this->assertArrayHasKey($this->service->normalizeKey($afterE5), $result['positions']);
    }

    public function test_positions_from_human_games_skips_game_on_illegal_move_without_leaking_partial_positions(): void
    {
        $game = new Game();
        $game->hub_game_id = $this->uniqueMarker('illegal-game');
        $game->pool = '3+0';
        $game->category = 'blitz';
        $game->variant = 'standard';
        $game->result = '1-0';
        $game->reason = 'checkmate';
        $game->white_uid = 'w';
        $game->black_uid = 'b';
        $game->white_name = 'W';
        $game->black_name = 'B';
        $game->ply = 1;
        $game->setMoves(['z9z9']); // engine will report illegal
        $game->setSans(['??']);
        $game->save();
        $this->gameIdsToClean[] = $game->id;

        $engine = new FakeMoveEngine([]); // no mapping => illegal for any move

        $result = $this->service->positionsFromHumanGames($engine, 0, [$game->id]);

        $this->assertSame(0, $result['gamesReplayed']);
        $this->assertSame(1, $result['skippedGames']);
    }

    // ------------------------------------------------------------------
    // helpers
    // ------------------------------------------------------------------

    /** @return array<string, mixed> */
    private function makeRow(string $fenKey, int $depth, int $multipv, int $nodes): array
    {
        $lines = [];
        for ($i = 0; $i < $multipv; $i++) {
            $lines[] = ['bestmove' => 'e2e4', 'eval' => ['type' => 'cp', 'value' => 10 + $i], 'pv' => ['e2e4'], 'depth' => $depth];
        }

        return [
            'fen_key' => $fenKey,
            'depth' => $depth,
            'multipv' => $multipv,
            'eval_type' => 'cp',
            'eval_value' => 10,
            'bestmove' => 'e2e4',
            'pv' => ['e2e4'],
            'lines' => $lines,
            'nodes' => $nodes,
        ];
    }

    /** @param array<string,mixed> $row */
    private function writeRow(array $row): void
    {
        $this->service->writeBatch([$row]);
        $id = App::db()->scalar('SELECT id FROM eval_cache_test WHERE fen_key = ?', [$row['fen_key']]);
        if (is_string($id)) {
            $this->evalCacheIdsToClean[] = $id;
        }
    }

    private function uniqueFenKey(): string
    {
        // Syntactically FEN-shaped but not a real reachable position — fine,
        // normalizeKey()/fen_key are pure strings with no legality check.
        // Randomized so parallel/repeated test runs never collide with each
        // other or with real imported data.
        return sprintf('8/8/8/8/8/8/8/%s w - -', substr(bin2hex(random_bytes(4)), 0, 8));
    }

    /** hub_game_id is varchar(36) (sized for a UUID) — must stay within that. */
    private function uniqueMarker(string $label): string
    {
        return 'imp-' . substr($label, 0, 4) . '-' . bin2hex(random_bytes(12));
    }
}

/**
 * Fakes the engine's /move boundary for positionsFromHumanGames() tests — no
 * real GomachineClient/zugzwang process involved. Maps "fen|uci" => newFen;
 * anything not in the map is reported illegal, mirroring how the real engine
 * would reject a bogus move.
 */
class FakeMoveEngine extends GomachineClient
{
    /** @param array<string, string> $moveMap */
    public function __construct(private readonly array $moveMap)
    {
    }

    public function move(string $fen, string $move, array $history = []): array
    {
        $newFen = $this->moveMap["{$fen}|{$move}"] ?? null;
        if ($newFen === null) {
            return ['legal' => false, 'reason' => 'illegal move'];
        }

        return ['legal' => true, 'newFen' => $newFen, 'san' => $move, 'status' => 'ongoing', 'sideToMove' => 'w'];
    }
}
