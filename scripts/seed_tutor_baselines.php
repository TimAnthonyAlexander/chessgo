<?php

declare(strict_types=1);

/**
 * Load the committed Tutor peer baselines into `tutor_baseline`.
 *
 * Usage:
 *   php scripts/seed_tutor_baselines.php [--file=storage/seeds/tutor_baseline.jsonl.gz]
 *                                        [--batch=N] [--dry-run]
 *
 * The baselines are what every Tutor comparison is measured AGAINST. With an
 * empty table the report has nothing to compare to, so it silently degrades to
 * "not enough peer data to compare yet" and no headline — which is why this is
 * a seed shipped in the repo rather than something each environment is
 * expected to rebuild. Rebuilding them needs a multi-GB Lichess dump; loading
 * them needs this script and 870 KB of git history.
 *
 * Input is the gzipped JSONL written by scripts/export_tutor_baselines.php.
 *
 * Idempotent. `tutor_baseline` carries TWO unique keys — `cell_key` and the
 * composite (source, category, rating_bucket, metric, dimension) — and a
 * single INSERT ... ON DUPLICATE KEY UPDATE satisfies both: whichever key an
 * existing row matches, the row is updated in place, never duplicated. The
 * primary key `id` is deliberately NOT in the UPDATE list, so re-seeding an
 * environment that already imported its own rows corrects the numbers without
 * repointing anything that references them.
 *
 * Run it after `mason migrate:apply` (this is DML; the table must already
 * exist) and any time the seed file changes.
 */

use App\Models\TutorBaseline;
use BaseApi\App;
use BaseApi\Database\DB;

require_once __DIR__ . '/../vendor/autoload.php';

App::boot(dirname(__DIR__));

const SEED_COLUMNS = [
    'id', 'source', 'category', 'rating_bucket', 'metric', 'dimension',
    'cell_key', 'sample', 'mean', 'stddev', 'p10', 'p25', 'p50', 'p75', 'p90',
];

const DEFAULT_SEED = 'storage/seeds/tutor_baseline.jsonl.gz';

/** @return array<string, string> */
function parseArgs(array $argv): array
{
    $flags = [];
    foreach (array_slice($argv, 1) as $arg) {
        if (!str_starts_with($arg, '--')) {
            fwrite(STDERR, "unexpected argument: {$arg}\n");
            exit(1);
        }

        $eq = strpos($arg, '=');
        if ($eq === false) {
            $flags[substr($arg, 2)] = '1';
        } else {
            $flags[substr($arg, 2, $eq - 2)] = substr($arg, $eq + 1);
        }
    }

    return $flags;
}

/**
 * Line reader for .gz and plain files.
 *
 * @return Generator<int, string>
 */
function readSeedLines(string $path): Generator
{
    $isGz = str_ends_with($path, '.gz');
    $handle = $isGz ? gzopen($path, 'r') : fopen($path, 'r');

    if ($handle === false) {
        fwrite(STDERR, "cannot open: {$path}\n");
        exit(1);
    }

    while (true) {
        $line = $isGz ? gzgets($handle) : fgets($handle);
        if ($line === false) {
            break;
        }

        $line = trim($line);
        if ($line !== '') {
            yield $line;
        }
    }

    $isGz ? gzclose($handle) : fclose($handle);
}

function flushSeedRows(DB $db, array $rows): void
{
    if ($rows === []) {
        return;
    }

    $placeholder = '(' . implode(',', array_fill(0, count(SEED_COLUMNS), '?')) . ')';
    $sql = 'INSERT INTO tutor_baseline (' . implode(',', SEED_COLUMNS) . ') VALUES '
        . implode(',', array_fill(0, count($rows), $placeholder))
        . ' ON DUPLICATE KEY UPDATE '
        . 'cell_key=VALUES(cell_key), sample=VALUES(sample), mean=VALUES(mean), stddev=VALUES(stddev), '
        . 'p10=VALUES(p10), p25=VALUES(p25), p50=VALUES(p50), p75=VALUES(p75), p90=VALUES(p90), '
        . 'updated_at=CURRENT_TIMESTAMP';

    $bindings = [];
    foreach ($rows as $row) {
        foreach ($row as $value) {
            $bindings[] = $value;
        }
    }

    $db->exec($sql, $bindings);
}

$flags = parseArgs($argv);

$file = $flags['file'] ?? (dirname(__DIR__) . '/' . DEFAULT_SEED);
$batch = max(1, (int) ($flags['batch'] ?? 500));
$dryRun = isset($flags['dry-run']);

if (!is_readable($file)) {
    fwrite(STDERR, "cannot read seed file: {$file}\n");
    fwrite(STDERR, "expected the committed dump at " . DEFAULT_SEED . " — regenerate with scripts/export_tutor_baselines.php\n");
    exit(1);
}

$db = App::db();

$before = (int) ($db->raw('SELECT COUNT(*) AS c FROM tutor_baseline', [])[0]['c'] ?? 0);
printf("tutor_baseline rows before: %d\n", $before);
printf("seed file: %s (%.1f KB)\n", $file, (int) filesize($file) / 1024);

$rows = [];
$read = 0;
$upserted = 0;
$skipped = 0;

foreach (readSeedLines($file) as $line) {
    $row = json_decode($line, true);
    if (!is_array($row) || !isset($row['source'], $row['category'], $row['metric'])) {
        $skipped++;
        continue;
    }

    $read++;

    // Recompute rather than trust the file: the digest IS the identity, and a
    // hand-edited seed line with a stale cell_key would upsert into the wrong
    // cell.
    $cellKey = TutorBaseline::cellKey(
        (string) $row['source'],
        (string) $row['category'],
        (int) $row['rating_bucket'],
        (string) $row['metric'],
        (string) ($row['dimension'] ?? ''),
    );

    $rows[] = [
        (string) $row['id'],
        (string) $row['source'],
        (string) $row['category'],
        (int) $row['rating_bucket'],
        (string) $row['metric'],
        (string) ($row['dimension'] ?? ''),
        $cellKey,
        (int) $row['sample'],
        (float) $row['mean'],
        (float) $row['stddev'],
        (float) $row['p10'],
        (float) $row['p25'],
        (float) $row['p50'],
        (float) $row['p75'],
        (float) $row['p90'],
    ];

    if (count($rows) >= $batch) {
        if (!$dryRun) {
            flushSeedRows($db, $rows);
        }

        $upserted += count($rows);
        $rows = [];
        printf("  %d\r", $upserted);
    }
}

if ($rows !== []) {
    if (!$dryRun) {
        flushSeedRows($db, $rows);
    }

    $upserted += count($rows);
}

$after = (int) ($db->raw('SELECT COUNT(*) AS c FROM tutor_baseline', [])[0]['c'] ?? 0);

printf("\nread %d rows from seed%s\n", $read, $skipped > 0 ? ", skipped {$skipped} malformed" : '');
printf("%s %d rows\n", $dryRun ? 'would upsert' : 'upserted', $upserted);
printf("tutor_baseline rows after: %d (%+d)\n", $after, $after - $before);

foreach ($db->raw('SELECT source, COUNT(*) AS c FROM tutor_baseline GROUP BY source ORDER BY source', []) as $r) {
    printf("  source %s: %d rows\n", $r['source'], $r['c']);
}
