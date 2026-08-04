<?php

declare(strict_types=1);

/**
 * Dump `tutor_baseline` to a compressed, version-controlled seed file.
 *
 * Usage:
 *   php scripts/export_tutor_baselines.php [--source=lichess-2026-06]
 *                                          [--out=storage/seeds/tutor_baseline.jsonl.gz]
 *                                          [--batch=N]
 *
 * These baselines are derived REFERENCE data, not user data: ~11k rows,
 * identical in every environment, and expensive to regenerate — building them
 * needs a multi-GB Lichess dump plus hours of measurement. So they ship WITH
 * the repo rather than being rebuilt per environment, and prod is seeded from
 * the committed file (scripts/seed_tutor_baselines.php).
 *
 * Format is one JSON object per line, gzipped: the natural pairing for a
 * table that is streamed row-by-row on both ends, diff-visible enough to
 * review, and readable with `zcat` without any tooling.
 *
 * Rows are emitted in a stable order (source, category, rating_bucket, metric,
 * dimension) so re-exporting the same data produces the same bytes and git
 * does not churn.
 *
 * The row `id` is carried through. It is a random UUID assigned at import
 * time, so a rebuilt corpus produces new ids — but for the shipped file it
 * means every environment ends up with byte-identical rows, and the seeder
 * never has to invent a primary key.
 */

use App\Models\TutorBaseline;
use BaseApi\App;

require_once __DIR__ . '/../vendor/autoload.php';

App::boot(dirname(__DIR__));

const EXPORT_COLUMNS = [
    'id', 'source', 'category', 'rating_bucket', 'metric', 'dimension',
    'cell_key', 'sample', 'mean', 'stddev', 'p10', 'p25', 'p50', 'p75', 'p90',
];

const DEFAULT_OUT = 'storage/seeds/tutor_baseline.jsonl.gz';

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

$flags = parseArgs($argv);

$source = $flags['source'] ?? '';
$out = $flags['out'] ?? (dirname(__DIR__) . '/' . DEFAULT_OUT);
$batch = max(1, (int) ($flags['batch'] ?? 2000));

$dir = dirname($out);
if (!is_dir($dir) && !mkdir($dir, 0o755, true) && !is_dir($dir)) {
    fwrite(STDERR, "cannot create directory: {$dir}\n");
    exit(1);
}

$db = App::db();

$where = $source === '' ? '' : ' WHERE source = ?';
$params = $source === '' ? [] : [$source];

$total = (int) ($db->raw('SELECT COUNT(*) AS c FROM tutor_baseline' . $where, $params)[0]['c'] ?? 0);
if ($total === 0) {
    fwrite(STDERR, "tutor_baseline is empty" . ($source === '' ? '' : " for source '{$source}'") . " — nothing to export.\n");
    exit(1);
}

printf("exporting %d rows%s -> %s\n", $total, $source === '' ? '' : " (source={$source})", $out);

$tmp = $out . '.tmp';
$gz = gzopen($tmp, 'wb9');
if ($gz === false) {
    fwrite(STDERR, "cannot write: {$tmp}\n");
    exit(1);
}

$cols = implode(',', EXPORT_COLUMNS);
$written = 0;
$offset = 0;

// Keyset would be nicer, but the stable sort key is five columns wide and the
// table is small enough that OFFSET paging costs nothing here.
while (true) {
    $rows = $db->raw(
        "SELECT {$cols} FROM tutor_baseline{$where}"
        . ' ORDER BY source, category, rating_bucket, metric, dimension'
        . " LIMIT {$batch} OFFSET {$offset}",
        $params,
    );

    if ($rows === []) {
        break;
    }

    $chunk = '';
    foreach ($rows as $row) {
        $chunk .= json_encode([
            'id' => (string) $row['id'],
            'source' => (string) $row['source'],
            'category' => (string) $row['category'],
            'rating_bucket' => (int) $row['rating_bucket'],
            'metric' => (string) $row['metric'],
            'dimension' => (string) $row['dimension'],
            'cell_key' => (string) $row['cell_key'],
            'sample' => (int) $row['sample'],
            'mean' => (float) $row['mean'],
            'stddev' => (float) $row['stddev'],
            'p10' => (float) $row['p10'],
            'p25' => (float) $row['p25'],
            'p50' => (float) $row['p50'],
            'p75' => (float) $row['p75'],
            'p90' => (float) $row['p90'],
        ], JSON_UNESCAPED_SLASHES | JSON_UNESCAPED_UNICODE) . "\n";
        $written++;
    }

    gzwrite($gz, $chunk);
    $offset += $batch;

    printf("  %d / %d\r", $written, $total);
}

gzclose($gz);
rename($tmp, $out);

$bytes = (int) filesize($out);

printf("\nwrote %d rows, %s (%.1f KB compressed)\n", $written, $out, $bytes / 1024);

if ($written !== $total) {
    fwrite(STDERR, "WARNING: wrote {$written} rows but counted {$total} — the table changed under the export.\n");
    exit(1);
}

// A seed file is only worth committing while it stays small. Past this it
// belongs in object storage with a fetch step, not in git history.
if ($bytes > 5 * 1024 * 1024) {
    fwrite(STDERR, sprintf(
        "WARNING: %.1f MB is too big to commit comfortably — consider hosting it instead.\n",
        $bytes / 1024 / 1024,
    ));
}

printf("cell sources: %s\n", implode(', ', array_map(
    static fn(array $r): string => sprintf('%s=%d', $r['source'], $r['c']),
    $db->raw('SELECT source, COUNT(*) AS c FROM tutor_baseline GROUP BY source ORDER BY source', []),
)));

printf("baseline bucket width %d, min sample %d\n", TutorBaseline::BUCKET_WIDTH, TutorBaseline::MIN_SAMPLE);
