<?php

declare(strict_types=1);

/**
 * Import Lichess's public CC0 eval dump (lichess_db_eval.jsonl(.zst)) into
 * `eval_cache`, so the analysis board has deep opening/endgame coverage from
 * day one instead of only what our own users have caused us to search.
 *
 * Source: https://database.lichess.org/lichess_db_eval.jsonl.zst (21.4 GB
 * compressed, CC0, standard variant only). One JSON object per line:
 *   {"fen":"<4-field normalized FEN>",
 *    "evals":[{"pvs":[{"cp":N,"line":"uci uci …"}, …], "knodes":N, "depth":N}, …]}
 *
 * 394M rows do NOT belong in MySQL wholesale, so this only imports records
 * whose position is in a "we actually care about" set, built from our own
 * `game`/`bot_game` corpus (LichessEvalImportService::positionsFrom*()) and/or
 * an explicit --positions file. See that service for the FEN/sign-convention
 * conversion this streams every matching record through, and for the
 * never-downgrade batched upsert.
 *
 * Streaming: reads the dump line-by-line (through `zstd -dc` for a .zst
 * input) so memory use stays flat regardless of file size — never buffers
 * the whole file or the whole match set. A truncated/aborted zstd stream
 * (e.g. testing against a partial download) is handled gracefully: the
 * partial trailing line just fails to json_decode and is skipped, already
 * committed batches are untouched, and the script exits 0 with a note that
 * the stream was truncated.
 *
 * Usage:
 *   php scripts/import_lichess_evals.php <dump.jsonl|dump.jsonl.zst> [options]
 *
 *   --commit               Actually write. Default is DRY RUN (report only).
 *   --positions=<file>     Position list, one FEN (or already-normalized key)
 *                          per line; '#' comments and blank lines ignored.
 *                          Alternative/addition to the DB-derived set — e.g.
 *                          output from a PGN corpus processed separately.
 *   --no-db                Skip building the position set from game/bot_game
 *                          (use only --positions). Default: both, unioned.
 *   --game-limit=N         Cap how many `game` rows are replayed (each ply is
 *                          one engine /move round trip — see the service doc
 *                          for why PHP doesn't reimplement chess itself here).
 *                          0 = no limit (default).
 *   --botgame-limit=N      Cap how many `bot_game` rows are scanned (cheap —
 *                          no replay, just reads stored FENs). 0 = no limit.
 *   --limit=N               Stop after N dump lines scanned (0 = no limit).
 *   --skip-lines=N          Skip the first N dump lines before processing —
 *                           resume point for a killed run (see note below).
 *   --batch=N                Rows per classify/write batch (default 1000).
 *   --progress=N              Print a progress line every N scanned dump
 *                              lines (default 200000).
 *
 * Resumability: the import is idempotent (never-downgrade upsert keyed on
 * fen_key), so the simplest "resume" after a kill is just re-running from the
 * start — no double-counting or corruption either way. --skip-lines=N lets an
 * operator skip the re-processing (JSON decode + match + write) of lines
 * already handled on a prior run; the stream still has to be decompressed up
 * to that point (zstd has no seek index), but that's normally much cheaper
 * than the DB work being skipped.
 *
 * Position set construction is entirely engine-derived or read from already-
 * engine-computed data — see LichessEvalImportService for exactly how (no
 * chess rules reimplemented in PHP, per project convention).
 */

use App\Services\EngineSelector;
use App\Services\LichessEvalImportService;
use BaseApi\App;

require_once __DIR__ . '/../vendor/autoload.php';

App::boot(dirname(__DIR__));

/** @return array{0:string,1:array<string,string>} */
function parseArgs(array $argv): array
{
    $positional = [];
    $flags = [];
    foreach (array_slice($argv, 1) as $arg) {
        if (str_starts_with($arg, '--')) {
            $eq = strpos($arg, '=');
            if ($eq === false) {
                $flags[substr($arg, 2)] = '1';
            } else {
                $flags[substr($arg, 2, $eq - 2)] = substr($arg, $eq + 1);
            }
        } else {
            $positional[] = $arg;
        }
    }

    return [$positional[0] ?? '', $flags];
}

[$dumpPath, $flags] = parseArgs($argv);

if ($dumpPath === '' || !is_readable($dumpPath)) {
    fwrite(STDERR, "Usage: php scripts/import_lichess_evals.php <dump.jsonl|dump.jsonl.zst> [--commit] [--positions=<file>] [--no-db] [--game-limit=N] [--botgame-limit=N] [--limit=N] [--skip-lines=N] [--batch=N] [--progress=N]\n");
    fwrite(STDERR, $dumpPath === '' ? "Error: no dump path given.\n" : "Error: cannot read '{$dumpPath}'.\n");
    exit(1);
}

$commit = isset($flags['commit']);
$noDb = isset($flags['no-db']);
$positionsFile = $flags['positions'] ?? null;
$gameLimit = isset($flags['game-limit']) ? max(0, (int) $flags['game-limit']) : 0;
$botGameLimit = isset($flags['botgame-limit']) ? max(0, (int) $flags['botgame-limit']) : 0;
$scanLimit = isset($flags['limit']) ? max(0, (int) $flags['limit']) : 0;
$skipLines = isset($flags['skip-lines']) ? max(0, (int) $flags['skip-lines']) : 0;
$batchSize = isset($flags['batch']) ? max(1, (int) $flags['batch']) : 1000;
$progressEvery = isset($flags['progress']) ? max(1, (int) $flags['progress']) : 200000;

if ($noDb && $positionsFile === null) {
    fwrite(STDERR, "Error: --no-db with no --positions=<file> leaves nothing to match against (refusing to import everything).\n");
    exit(1);
}

$service = new LichessEvalImportService();

// --- Build the position set -------------------------------------------------

/** @var array<string, true> $positions */
$positions = [];

if (!$noDb) {
    fwrite(STDOUT, "Building position set from bot_game (limit=" . ($botGameLimit ?: '∞') . ")…\n");
    $botPositions = $service->positionsFromBotGames($botGameLimit);
    $positions += $botPositions;
    fwrite(STDOUT, '  bot_game contributed ' . count($botPositions) . " position(s); running total " . count($positions) . "\n");

    fwrite(STDOUT, "Building position set from game (standard variant, replayed via engine; limit=" . ($gameLimit ?: '∞') . ")…\n");
    /** @var EngineSelector $engine */
    $engine = App::container()->make(EngineSelector::class);
    $humanResult = $service->positionsFromHumanGames($engine, $gameLimit);
    $positions += $humanResult['positions'];
    fwrite(STDOUT, sprintf(
        "  game contributed %d position(s) from %d replayed game(s), %d skipped (illegal/unreachable engine); running total %d\n",
        count($humanResult['positions']),
        $humanResult['gamesReplayed'],
        $humanResult['skippedGames'],
        count($positions),
    ));
}

if ($positionsFile !== null) {
    if (!is_readable($positionsFile)) {
        fwrite(STDERR, "Error: cannot read positions file '{$positionsFile}'.\n");
        exit(1);
    }
    fwrite(STDOUT, "Loading positions from file '{$positionsFile}'…\n");
    $filePositions = $service->positionsFromFile($positionsFile);
    $positions += $filePositions;
    fwrite(STDOUT, '  file contributed ' . count($filePositions) . " position(s); running total " . count($positions) . "\n");
}

if ($positions === []) {
    fwrite(STDERR, "Error: position set is empty — nothing to match against. Nothing to do.\n");
    exit(1);
}

fwrite(STDOUT, "Position set ready: " . count($positions) . " distinct position(s).\n\n");

// --- Open the dump (streaming; zstd -dc for .zst, plain fopen otherwise) ---

$isZst = str_ends_with(strtolower($dumpPath), '.zst');
$zstdProc = null;
$pipes = [];

if ($isZst) {
    $zstdBin = '/opt/homebrew/bin/zstd';
    if (!is_executable($zstdBin)) {
        $zstdBin = 'zstd'; // fall back to PATH resolution
    }
    $zstdProc = proc_open(
        [$zstdBin, '-dc', $dumpPath],
        [1 => ['pipe', 'w'], 2 => ['pipe', 'w']],
        $pipes,
    );
    if (!is_resource($zstdProc)) {
        fwrite(STDERR, "Error: failed to spawn zstd for '{$dumpPath}'.\n");
        exit(1);
    }
    $stream = $pipes[1];
    stream_set_blocking($pipes[2], false); // never let stderr block us
} else {
    $stream = fopen($dumpPath, 'r');
    if ($stream === false) {
        fwrite(STDERR, "Error: failed to open '{$dumpPath}'.\n");
        exit(1);
    }
}

// --- Stream, filter, convert, batch-write -----------------------------------

$startTime = microtime(true);
$scanned = 0;
$matched = 0;
$parseErrors = 0;
$convertErrors = 0;
$totalInsert = 0;
$totalUpdate = 0;
$totalSkip = 0;
/** @var list<array<string, mixed>> $batch */
$batch = [];

/**
 * @param list<array<string, mixed>> $batch
 * @return array{0:int,1:int,2:int} [inserted, updated, skipped]
 */
$flushBatch = function (array $batch) use ($service, $commit): array {
    if ($batch === []) {
        return [0, 0, 0];
    }
    $deduped = $service->dedupeBatch($batch);
    $classified = $service->classifyBatch($deduped);
    if ($commit) {
        $service->writeBatch(array_merge($classified['insert'], $classified['update']));
    }

    return [count($classified['insert']), count($classified['update']), $classified['skip']];
};

for ($i = 0; $i < $skipLines; $i++) {
    if (fgets($stream) === false) {
        break;
    }
}

while (($line = fgets($stream)) !== false) {
    $line = trim($line);
    if ($line === '') {
        continue;
    }
    $scanned++;

    $record = json_decode($line, true);
    if (!is_array($record)) {
        $parseErrors++;
        continue; // malformed/truncated line — skip, don't corrupt the run
    }

    $fen = $record['fen'] ?? null;
    if (!is_string($fen) || $fen === '') {
        $parseErrors++;
        continue;
    }

    $key = $service->normalizeKey($fen);
    if (isset($positions[$key])) {
        $matched++;
        $row = $service->convertRecord($record);
        if ($row === null) {
            $convertErrors++;
        } else {
            $batch[] = $row;
            if (count($batch) >= $batchSize) {
                [$ins, $upd, $skip] = $flushBatch($batch);
                $totalInsert += $ins;
                $totalUpdate += $upd;
                $totalSkip += $skip;
                $batch = [];
            }
        }
    }

    if ($scanned % $progressEvery === 0) {
        $elapsed = microtime(true) - $startTime;
        fwrite(STDOUT, sprintf(
            "  … scanned=%d matched=%d insert=%d update=%d skip=%d parse_err=%d convert_err=%d elapsed=%.1fs\n",
            $scanned,
            $matched,
            $totalInsert,
            $totalUpdate,
            $totalSkip,
            $parseErrors,
            $convertErrors,
            $elapsed,
        ));
    }

    if ($scanLimit > 0 && $scanned >= $scanLimit) {
        break;
    }
}

// Flush whatever's left in the final partial batch.
[$ins, $upd, $skip] = $flushBatch($batch);
$totalInsert += $ins;
$totalUpdate += $upd;
$totalSkip += $skip;

$streamTruncated = false;
if ($isZst && $zstdProc !== null) {
    $stderrOut = stream_get_contents($pipes[2]) ?: '';
    fclose($pipes[1]);
    fclose($pipes[2]);
    $exitCode = proc_close($zstdProc);
    if ($exitCode !== 0) {
        $streamTruncated = true;
        fwrite(STDOUT, "\nNote: zstd exited with status {$exitCode} (truncated/aborted stream — expected for a partial download). "
            . "Already-processed lines are unaffected; the run simply ends where the stream ends.\n");
        if (trim($stderrOut) !== '') {
            fwrite(STDOUT, 'zstd stderr: ' . trim($stderrOut) . "\n");
        }
    }
} else {
    fclose($stream);
}

$elapsed = microtime(true) - $startTime;
$peakMb = memory_get_peak_usage(true) / 1024 / 1024;

fwrite(STDOUT, "\n" . ($commit ? '=== COMMIT ===' : '=== DRY RUN (no writes — pass --commit to apply) ===') . "\n");
fwrite(STDOUT, sprintf("Records scanned:        %d\n", $scanned));
fwrite(STDOUT, sprintf("Matched position set:   %d\n", $matched));
fwrite(STDOUT, sprintf("Parse errors:            %d\n", $parseErrors));
fwrite(STDOUT, sprintf("Convert errors:          %d\n", $convertErrors));
fwrite(STDOUT, sprintf("%-20s   %d\n", $commit ? 'Inserted:' : 'Would insert:', $totalInsert));
fwrite(STDOUT, sprintf("%-20s   %d\n", $commit ? 'Updated:' : 'Would update:', $totalUpdate));
fwrite(STDOUT, sprintf("Skipped as downgrade:    %d\n", $totalSkip));
fwrite(STDOUT, sprintf("Elapsed:                 %.1fs\n", $elapsed));
fwrite(STDOUT, sprintf("Peak memory:             %.1f MB\n", $peakMb));
if ($streamTruncated) {
    fwrite(STDOUT, "Stream ended early (truncated zstd input) — this is expected for a partial file, not an error.\n");
}

exit(0);
