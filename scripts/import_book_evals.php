<?php

declare(strict_types=1);

/**
 * Bulk-load zugzwang's Stockfish opening-book cache (book.bin) into
 * `eval_cache`, from the TSV `zugzwang/tools/book_export.cpp` recovers out
 * of it. The book itself stores gomachine-Zobrist KEYS only, no FENs — see
 * that tool's header comment for the BFS-recovery approach and how it
 * reports its own coverage (found / total book entries). Run it first:
 *
 *   cd zugzwang && make book_export
 *   ./tools/book_export -o /tmp/book.tsv ../gomachine/data/opening_suite.epd \
 *       ../gomachine/data/opening_suite_shallow.epd
 *
 * TSV row shape: fen<TAB>score<TAB>mate<TAB>depth<TAB>pv (pv is a
 * space-separated UCI move list). Every book row today is depth 22 with
 * mate == 0, but the importer honors mate rows too — see
 * BookEvalImportService::convertLine().
 *
 * Perspective: the book's score/mate fields are already side-to-move
 * relative — the SAME convention `eval_cache.eval_value` uses — confirmed by
 * reading zugzwang/src/serve_handlers.cpp's book_eval_json() doc comment,
 * not assumed. No sign flip is applied. See BookEvalImportService's doc
 * comment and BookEvalImportServiceTest's pinned fixtures for both
 * directions (black-to-move and white-to-move).
 *
 * Every write goes through EvalCacheService::put() — unmodified, so the
 * exact same never-downgrade ordering `/analyze` itself relies on governs
 * this import. The whole run is wrapped in one DB transaction: a dry run
 * still executes every put() call (so the reported insert/update/skip
 * counts are exactly what a real run would produce) and then ROLLS BACK,
 * leaving the database untouched. Only --commit COMMITs.
 *
 * Usage:
 *   php scripts/import_book_evals.php <book.tsv> [--commit] [--source=book] [--progress=N]
 *
 *   --commit        Actually write (COMMIT the transaction). Default is a
 *                    DRY RUN (report only, then ROLLBACK).
 *   --source=NAME    eval_cache.source value to write (default 'book').
 *   --progress=N     Print a progress line every N scanned lines (default 1000).
 */

use App\Services\BookEvalImportService;
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

[$tsvPath, $flags] = parseArgs($argv);

if ($tsvPath === '' || !is_readable($tsvPath)) {
    fwrite(STDERR, "Usage: php scripts/import_book_evals.php <book.tsv> [--commit] [--source=book] [--progress=N]\n");
    fwrite(STDERR, $tsvPath === '' ? "Error: no TSV path given.\n" : "Error: cannot read '{$tsvPath}'.\n");
    exit(1);
}

$commit = isset($flags['commit']);
$source = $flags['source'] ?? 'book';
$progressEvery = isset($flags['progress']) ? max(1, (int) $flags['progress']) : 1000;

$service = new BookEvalImportService();

$stream = fopen($tsvPath, 'r');
if ($stream === false) {
    fwrite(STDERR, "Error: failed to open '{$tsvPath}'.\n");
    exit(1);
}

$startTime = microtime(true);
$scanned = 0;
$parseErrors = 0;
$inserted = 0;
$updated = 0;
$skipped = 0;

$pdo = App::db()->pdo();
$pdo->beginTransaction();

try {
    while (($line = fgets($stream)) !== false) {
        if (trim($line) === '') {
            continue;
        }
        $scanned++;

        $row = $service->convertLine($line);
        if ($row === null) {
            $parseErrors++;
        } else {
            $status = $service->importRow($row, $source);
            match ($status) {
                'insert' => $inserted++,
                'update' => $updated++,
                default => $skipped++,
            };
        }

        if ($scanned % $progressEvery === 0) {
            $elapsed = microtime(true) - $startTime;
            fwrite(STDOUT, sprintf(
                "  … scanned=%d insert=%d update=%d skip=%d parse_err=%d elapsed=%.1fs\n",
                $scanned,
                $inserted,
                $updated,
                $skipped,
                $parseErrors,
                $elapsed,
            ));
        }
    }

    if ($commit) {
        $pdo->commit();
    } else {
        $pdo->rollBack();
    }
} catch (\Throwable $e) {
    if ($pdo->inTransaction()) {
        $pdo->rollBack();
    }
    fclose($stream);
    fwrite(STDERR, 'Error during import: ' . $e->getMessage() . "\n");
    exit(1);
}

fclose($stream);

$elapsed = microtime(true) - $startTime;

fwrite(STDOUT, "\n" . ($commit ? '=== COMMIT ===' : '=== DRY RUN (no writes — pass --commit to apply) ===') . "\n");
fwrite(STDOUT, sprintf("Lines scanned:           %d\n", $scanned));
fwrite(STDOUT, sprintf("Parse errors (skipped):  %d\n", $parseErrors));
fwrite(STDOUT, sprintf("%-25s %d\n", $commit ? 'Inserted:' : 'Would insert:', $inserted));
fwrite(STDOUT, sprintf("%-25s %d\n", $commit ? 'Updated:' : 'Would update:', $updated));
fwrite(STDOUT, sprintf("Skipped as downgrade:    %d\n", $skipped));
fwrite(STDOUT, sprintf("Elapsed:                 %.1fs\n", $elapsed));

exit(0);
