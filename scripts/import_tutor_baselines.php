<?php

declare(strict_types=1);

/**
 * Build the Tutor peer-comparison baselines from a normalized game corpus.
 *
 * Usage:
 *   php scripts/import_tutor_baselines.php <games.jsonl[.zst]> [--source=lichess-2026-06]
 *                                          [--limit=N] [--dry-run] [--families=80]
 *
 * Input is the JSONL emitted by scripts/tutor/pgn_to_jsonl.py — one normalized
 * game per line. Every game is measured TWICE, once from each side, because a
 * baseline describes players, not games.
 *
 * Metrics are computed by App\Services\Tutor\TutorMetrics, the same class that
 * measures a real user's games. That is the whole point: if the peer numbers
 * and the user numbers came from different code, comparing them would be
 * meaningless. Nothing in this script knows how to compute a metric.
 *
 * Idempotent: rows are upserted on TutorBaseline::cellKey(), so re-running
 * replaces a source cleanly rather than duplicating it.
 *
 * MEMORY. The corpus is ~300k games and the cell space is (category × rating
 * band × metric × dimension), which is far too much to hold as raw values. So:
 *   - percentiles come from a bounded reservoir sample per cell, not the full
 *     value list (a few hundred samples pin a decile perfectly well);
 *   - means and weights are accumulated as running sums, exactly;
 *   - opening families are restricted to the most common ones, counted in a
 *     cheap first pass, so a long tail of one-off openings can't explode the
 *     cell count.
 */

use App\Models\TutorBaseline;
use App\Services\Tutor\TutorMetrics;
use BaseApi\App;
use BaseApi\Database\DB;

require_once __DIR__ . '/../vendor/autoload.php';

App::boot(dirname(__DIR__));

const RESERVOIR_PLAIN = 1200;
const RESERVOIR_DIMENSION = 400;
const BATCH_ROWS = 500;

/** @return array{0: string, 1: array<string, string>} */
function parseArgs(array $argv): array
{
    $path = null;
    $flags = [];

    foreach (array_slice($argv, 1) as $arg) {
        if (str_starts_with($arg, '--')) {
            $eq = strpos($arg, '=');
            if ($eq === false) {
                $flags[substr($arg, 2)] = '1';
            } else {
                $flags[substr($arg, 2, $eq - 2)] = substr($arg, $eq + 1);
            }
        } elseif ($path === null) {
            $path = $arg;
        }
    }

    if ($path === null) {
        fwrite(STDERR, "usage: php scripts/import_tutor_baselines.php <games.jsonl[.zst]> [--source=NAME] [--limit=N] [--dry-run]\n");
        exit(1);
    }

    return [$path, $flags];
}

/**
 * Line reader that transparently handles .zst, .gz and plain files.
 *
 * @return Generator<int, string>
 */
function readLines(string $path): Generator
{
    if (!file_exists($path)) {
        fwrite(STDERR, "no such file: {$path}\n");
        exit(1);
    }

    if (str_ends_with($path, '.zst')) {
        $cmd = sprintf('zstdcat %s', escapeshellarg($path));
        $handle = popen($cmd, 'r');
    } elseif (str_ends_with($path, '.gz')) {
        $handle = gzopen($path, 'r');
    } else {
        $handle = fopen($path, 'r');
    }

    if ($handle === false) {
        fwrite(STDERR, "cannot open: {$path}\n");
        exit(1);
    }

    $isGz = str_ends_with($path, '.gz');

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

    if (str_ends_with($path, '.zst')) {
        pclose($handle);
    } elseif ($isGz) {
        gzclose($handle);
    } else {
        fclose($handle);
    }
}

/**
 * Pass 1 — which opening families are common enough to be worth a baseline.
 *
 * A family that appears 30 times across the whole corpus cannot support a
 * per-rating-band cell, and keeping it would multiply the cell count by the
 * length of the tail. Counting first is cheaper than pruning later.
 *
 * @return array<string, true>
 */
function commonFamilies(string $path, int $keep, ?int $limit): array
{
    $counts = [];
    $n = 0;

    foreach (readLines($path) as $line) {
        $game = json_decode($line, true);
        if (!is_array($game)) {
            continue;
        }

        $opening = trim((string) ($game['opening'] ?? ''));
        if ($opening !== '') {
            $counts[$opening] = ($counts[$opening] ?? 0) + 1;
        }

        $n++;
        if ($limit !== null && $n >= $limit) {
            break;
        }

        if ($n % 50000 === 0) {
            fwrite(STDERR, sprintf("  pass 1: %s games, %d families\n", number_format($n), count($counts)));
        }
    }

    arsort($counts);
    $top = array_slice($counts, 0, $keep, true);

    fwrite(STDERR, sprintf(
        "  pass 1 done: %s games, %d families seen, keeping top %d (>= %d games each)\n",
        number_format($n),
        count($counts),
        count($top),
        $top === [] ? 0 : (int) end($top),
    ));

    return array_fill_keys(array_keys($top), true);
}

[$path, $flags] = parseArgs($argv);

$source = $flags['source'] ?? ('lichess-' . date('Y-m'));
$limit = isset($flags['limit']) ? (int) $flags['limit'] : null;
$dryRun = isset($flags['dry-run']);
$familyKeep = isset($flags['families']) ? (int) $flags['families'] : 80;

fwrite(STDERR, "Tutor baseline import\n");
fwrite(STDERR, "  corpus: {$path}\n");
fwrite(STDERR, "  source: {$source}\n");
fwrite(STDERR, $limit === null ? "  limit:  none\n" : sprintf("  limit:  %s games\n", number_format($limit)));

fwrite(STDERR, "\nPass 1 — opening families\n");
$families = commonFamilies($path, $familyKeep, $limit);

fwrite(STDERR, "\nPass 2 — measuring\n");

$metrics = new TutorMetrics();

/** @var array<string, array{sum: float, weight: float, n: int, seen: int, res: list<float>}> $cells */
$cells = [];

$games = 0;
$sides = 0;
$skipped = 0;
$started = microtime(true);

foreach (readLines($path) as $line) {
    $game = json_decode($line, true);
    if (!is_array($game)) {
        $skipped++;
        continue;
    }

    $category = (string) ($game['category'] ?? '');
    if ($category === '' || $category === 'correspondence') {
        $skipped++;
        continue;
    }

    // An opening outside the common set is measured as "no opening" rather
    // than dropped — the game still counts toward every other metric.
    $opening = trim((string) ($game['opening'] ?? ''));
    if ($opening !== '' && !isset($families[$opening])) {
        $game['opening'] = '';
    }

    foreach (['w' => 'whiteRating', 'b' => 'blackRating'] as $color => $ratingKey) {
        $rating = (int) ($game[$ratingKey] ?? 0);
        if ($rating <= 0) {
            continue;
        }

        $game['color'] = $color;
        $result = $metrics->perGame($game);

        if ($result['moves'] < 5) {
            continue;
        }

        $bucket = TutorBaseline::bucketFor($rating);
        $prefix = $category . '|' . $bucket . '|';

        foreach (['metrics' => RESERVOIR_PLAIN, 'dimensions' => RESERVOIR_DIMENSION] as $group => $reservoir) {
            foreach ($result[$group] as $key => $entry) {
                $cellKey = $prefix . $key;

                if (!isset($cells[$cellKey])) {
                    $cells[$cellKey] = ['sum' => 0.0, 'weight' => 0.0, 'n' => 0, 'seen' => 0, 'res' => []];
                }

                $cell = &$cells[$cellKey];
                $cell['sum'] += $entry['value'] * $entry['weight'];
                $cell['weight'] += $entry['weight'];
                $cell['n']++;
                $cell['seen']++;

                // Reservoir sample: keep the first N, then replace with
                // decreasing probability so the sample stays uniform.
                if (count($cell['res']) < $reservoir) {
                    $cell['res'][] = $entry['value'];
                } else {
                    $j = random_int(0, $cell['seen'] - 1);
                    if ($j < $reservoir) {
                        $cell['res'][$j] = $entry['value'];
                    }
                }

                unset($cell);
            }
        }

        $sides++;
    }

    $games++;

    if ($limit !== null && $games >= $limit) {
        break;
    }

    if ($games % 25000 === 0) {
        $rate = $games / max(0.001, microtime(true) - $started);
        fwrite(STDERR, sprintf(
            "  %s games, %s sides, %s cells, %.0f games/s, %.0f MB\n",
            number_format($games),
            number_format($sides),
            number_format(count($cells)),
            $rate,
            memory_get_usage(true) / 1048576,
        ));
    }
}

$elapsed = microtime(true) - $started;

fwrite(STDERR, sprintf(
    "\nMeasured %s games (%s player-sides) in %.1fs, %s cells, peak %.0f MB\n",
    number_format($games),
    number_format($sides),
    $elapsed,
    number_format(count($cells)),
    memory_get_peak_usage(true) / 1048576,
));

// ---------------------------------------------------------------------------
// Write
// ---------------------------------------------------------------------------

/** Matches scripts/import_puzzles.php — the id column is a UUID everywhere. */
function uuidv4(): string
{
    $data = random_bytes(16);
    $data[6] = chr(ord($data[6]) & 0x0f | 0x40);
    $data[8] = chr(ord($data[8]) & 0x3f | 0x80);

    return vsprintf('%s%s-%s-%s-%s-%s%s%s', str_split(bin2hex($data), 4));
}

/** @param list<float> $sorted */
function percentile(array $sorted, float $q): float
{
    $n = count($sorted);
    if ($n === 0) {
        return 0.0;
    }

    if ($n === 1) {
        return $sorted[0];
    }

    $pos = $q * ($n - 1);
    $lo = (int) floor($pos);
    $hi = (int) ceil($pos);

    return $sorted[$lo] + ($sorted[$hi] - $sorted[$lo]) * ($pos - $lo);
}

function flushRows(DB $db, array $rows): void
{
    if ($rows === []) {
        return;
    }

    $cols = [
        'id', 'source', 'category', 'rating_bucket', 'metric', 'dimension',
        'cell_key', 'sample', 'mean', 'stddev', 'p10', 'p25', 'p50', 'p75', 'p90',
    ];

    $placeholder = '(' . implode(',', array_fill(0, count($cols), '?')) . ')';
    $sql = 'INSERT INTO tutor_baseline (' . implode(',', $cols) . ') VALUES '
        . implode(',', array_fill(0, count($rows), $placeholder))
        . ' ON DUPLICATE KEY UPDATE '
        . 'sample=VALUES(sample), mean=VALUES(mean), stddev=VALUES(stddev), '
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

$db = App::db();

$written = 0;
$dropped = 0;
$batch = [];
$byMetric = [];

foreach ($cells as $cellKey => $cell) {
    if ($cell['n'] < TutorBaseline::MIN_SAMPLE || $cell['weight'] <= 0.0) {
        $dropped++;
        continue;
    }

    [$category, $bucket, $composite] = explode('|', $cellKey, 3);
    [$metric, $dimension] = $metrics->splitKey($composite);

    $values = $cell['res'];
    sort($values);

    $mean = $cell['sum'] / $cell['weight'];

    $varianceSum = 0.0;
    foreach ($values as $value) {
        $varianceSum += ($value - $mean) ** 2;
    }

    $stddev = count($values) > 1 ? sqrt($varianceSum / (count($values) - 1)) : 0.0;

    $batch[] = [
        uuidv4(),
        $source,
        $category,
        (int) $bucket,
        $metric,
        $dimension,
        TutorBaseline::cellKey($source, $category, (int) $bucket, $metric, $dimension),
        $cell['n'],
        $mean,
        $stddev,
        percentile($values, 0.10),
        percentile($values, 0.25),
        percentile($values, 0.50),
        percentile($values, 0.75),
        percentile($values, 0.90),
    ];

    $byMetric[$metric] = ($byMetric[$metric] ?? 0) + 1;
    $written++;

    if (count($batch) >= BATCH_ROWS) {
        if (!$dryRun) {
            flushRows($db, $batch);
        }

        $batch = [];
    }
}

if (!$dryRun) {
    flushRows($db, $batch);
}

fwrite(STDERR, sprintf(
    "\n%s %s cells (dropped %s below the %d-game minimum)\n",
    $dryRun ? 'Would write' : 'Wrote',
    number_format($written),
    number_format($dropped),
    TutorBaseline::MIN_SAMPLE,
));

ksort($byMetric);
foreach ($byMetric as $metric => $count) {
    fwrite(STDERR, sprintf("  %-14s %s cells\n", $metric, number_format($count)));
}

if ($dryRun) {
    fwrite(STDERR, "\n(dry run — nothing written)\n");
}
