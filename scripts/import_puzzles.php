<?php

declare(strict_types=1);

/**
 * Seed the `puzzle` + `puzzle_theme` tables from the Lichess open puzzle
 * database CSV (CC0). See docs/SPEC.md §Puzzles.
 *
 * The CSV is downloaded separately (it is large and NOT committed):
 *   curl -L https://database.lichess.org/lichess_db_puzzle.csv.zst -o puzzles.zst
 *   zstd -d puzzles.zst -o lichess_db_puzzle.csv
 * Columns: PuzzleId,FEN,Moves,Rating,RatingDeviation,Popularity,NbPlays,Themes,GameUrl,OpeningTags
 *
 * Usage:
 *   php scripts/import_puzzles.php <csv> [--limit=N] [--min-rating=N]
 *       [--max-rating=N] [--min-popularity=N] [--themes=a,b,c] [--batch=N]
 *
 * Re-run safe: rows are INSERT IGNORE'd on the unique keys (puzzle.ext_id,
 * puzzle_theme(puzzle_ext_id,theme)). This is bulk DML, NOT schema DDL — run
 * `mason migrate:generate && mason migrate:apply -y` FIRST to create the tables.
 */

use BaseApi\App;
use BaseApi\Database\DB;

require_once __DIR__ . '/../vendor/autoload.php';

App::boot(dirname(__DIR__));

/** @return array{0:string,1:array<string,string>} [csvPath, flags] */
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

function uuidv4(): string
{
    $data = random_bytes(16);
    $data[6] = chr((ord($data[6]) & 0x0f) | 0x40);
    $data[8] = chr((ord($data[8]) & 0x3f) | 0x80);

    return vsprintf('%s%s-%s-%s-%s-%s%s%s', str_split(bin2hex($data), 4));
}

// Fixed namespace for deriving a puzzle's UUID PK from its (case-sensitive)
// Lichess id. Deterministic → import is idempotent AND distinct case-variant
// ids ("0QCaI" vs "0qcai") map to distinct, collision-free UUID keys.
const PUZZLE_NS = '6f9a1d2c-3b4e-5a6f-8c1d-2e3f4a5b6c7d';

function uuidv5(string $namespace, string $name): string
{
    $nhex = str_replace('-', '', $namespace);
    $nbin = '';
    for ($i = 0, $n = strlen($nhex); $i < $n; $i += 2) {
        $nbin .= chr((int) hexdec(substr($nhex, $i, 2)));
    }
    $hash = sha1($nbin . $name);

    return sprintf(
        '%08s-%04s-%04x-%04x-%12s',
        substr($hash, 0, 8),
        substr($hash, 8, 4),
        (hexdec(substr($hash, 12, 4)) & 0x0fff) | 0x5000, // version 5
        (hexdec(substr($hash, 16, 4)) & 0x3fff) | 0x8000, // RFC variant
        substr($hash, 20, 12),
    );
}

[$csvPath, $flags] = parseArgs($argv);

if ($csvPath === '' || !is_readable($csvPath)) {
    fwrite(STDERR, "Usage: php scripts/import_puzzles.php <csv> [--limit=N] [--min-rating=N] [--max-rating=N] [--min-popularity=N] [--themes=a,b,c] [--batch=N]\n");
    fwrite(STDERR, $csvPath === '' ? "Error: no CSV path given.\n" : "Error: cannot read '$csvPath'.\n");
    exit(1);
}

$limit = isset($flags['limit']) ? (int) $flags['limit'] : 0;            // 0 = no limit
$minRating = isset($flags['min-rating']) ? (int) $flags['min-rating'] : 0;
$maxRating = isset($flags['max-rating']) ? (int) $flags['max-rating'] : PHP_INT_MAX;
$minPop = isset($flags['min-popularity']) ? (int) $flags['min-popularity'] : PHP_INT_MIN;
$themeFilter = isset($flags['themes']) && $flags['themes'] !== ''
    ? array_flip(array_map('trim', explode(',', $flags['themes'])))
    : null;
$batchSize = isset($flags['batch']) ? max(1, (int) $flags['batch']) : 1000;

$db = App::db();

$handle = fopen($csvPath, 'r');
if ($handle === false) {
    fwrite(STDERR, "Error: failed to open CSV.\n");
    exit(1);
}

$header = fgetcsv($handle, 0, ',', '"', '');
if ($header === false) {
    fwrite(STDERR, "Error: empty CSV.\n");
    exit(1);
}
// Map header names → column index (tolerant of column reordering).
$col = array_flip(array_map('trim', $header));
$required = ['PuzzleId', 'FEN', 'Moves', 'Rating'];
foreach ($required as $name) {
    if (!isset($col[$name])) {
        fwrite(STDERR, "Error: CSV missing required column '$name'.\n");
        exit(1);
    }
}

$now = date('Y-m-d H:i:s');
$puzzleRows = [];   // each: list of 12 bound values
$themeRows = [];    // each: list of 6 bound values
$imported = 0;
$scanned = 0;

/** @param list<list<mixed>> $rows */
function flushRows(DB $db, string $table, array $cols, array $rows): void
{
    if ($rows === []) {
        return;
    }
    $placeholder = '(' . implode(',', array_fill(0, count($cols), '?')) . ')';
    $sql = "INSERT IGNORE INTO $table (" . implode(',', $cols) . ') VALUES '
        . implode(',', array_fill(0, count($rows), $placeholder));
    $bindings = [];
    foreach ($rows as $row) {
        foreach ($row as $v) {
            $bindings[] = $v;
        }
    }
    $db->exec($sql, $bindings);
}

$puzzleCols = ['id', 'ext_id', 'fen', 'moves', 'rating', 'rating_deviation', 'popularity', 'nb_plays', 'themes', 'game_url', 'created_at', 'updated_at'];
$themeCols = ['id', 'puzzle_id', 'theme', 'rating', 'created_at', 'updated_at'];

while (($row = fgetcsv($handle, 0, ',', '"', '')) !== false) {
    $scanned++;

    $extId = $row[$col['PuzzleId']] ?? '';
    $fen = $row[$col['FEN']] ?? '';
    $movesRaw = trim($row[$col['Moves']] ?? '');
    $rating = (int) ($row[$col['Rating']] ?? 0);

    if ($extId === '' || $fen === '' || $movesRaw === '') {
        continue;
    }
    if ($rating < $minRating || $rating > $maxRating) {
        continue;
    }

    $popularity = isset($col['Popularity']) ? (int) ($row[$col['Popularity']] ?? 0) : 0;
    if ($popularity < $minPop) {
        continue;
    }

    $themes = isset($col['Themes']) && trim($row[$col['Themes']] ?? '') !== ''
        ? preg_split('/\s+/', trim($row[$col['Themes']]))
        : [];

    if ($themeFilter !== null) {
        $hit = false;
        foreach ($themes as $t) {
            if (isset($themeFilter[$t])) {
                $hit = true;
                break;
            }
        }
        if (!$hit) {
            continue;
        }
    }

    $moves = preg_split('/\s+/', $movesRaw);
    $ratingDev = isset($col['RatingDeviation']) ? (int) ($row[$col['RatingDeviation']] ?? 0) : 0;
    $nbPlays = isset($col['NbPlays']) ? (int) ($row[$col['NbPlays']] ?? 0) : 0;
    $gameUrl = isset($col['GameUrl']) ? ($row[$col['GameUrl']] ?? null) : null;

    $puzzleId = uuidv5(PUZZLE_NS, $extId);

    $puzzleRows[] = [
        $puzzleId, $extId, $fen, json_encode(array_values($moves)),
        $rating, $ratingDev, $popularity, $nbPlays,
        json_encode(array_values($themes)), $gameUrl, $now, $now,
    ];

    foreach ($themes as $t) {
        $themeRows[] = [uuidv4(), $puzzleId, $t, $rating, $now, $now];
    }

    $imported++;

    if (count($puzzleRows) >= $batchSize) {
        flushRows($db, 'puzzle', $puzzleCols, $puzzleRows);
        flushRows($db, 'puzzle_theme', $themeCols, $themeRows);
        $puzzleRows = [];
        $themeRows = [];
        fwrite(STDOUT, "\rimported: $imported  (scanned: $scanned)");
    }

    if ($limit > 0 && $imported >= $limit) {
        break;
    }
}

flushRows($db, 'puzzle', $puzzleCols, $puzzleRows);
flushRows($db, 'puzzle_theme', $themeCols, $themeRows);
fclose($handle);

fwrite(STDOUT, "\rimported: $imported  (scanned: $scanned)\nDone.\n");
