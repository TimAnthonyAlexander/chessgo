<?php

declare(strict_types=1);

/**
 * Fit the mapping from Lichess's published evals into zugzwang's eval scale.
 *
 * Usage:
 *   php scripts/calibrate_tutor_evals.php ~/tutor-data/calibration.jsonl \
 *       [--limit=N] [--movetime=100] [--out=storage/tutor-calibration.json]
 *
 * WHY THIS EXISTS. The peer baselines are measured from the `%eval`
 * annotations in the public Lichess database; a real user's games are measured
 * by zugzwang. A first pass showed those two disagree on level by a lot — mean
 * centipawn loss ran far higher under zugzwang on the very same games — while
 * agreeing almost perfectly on ranking (Pearson ~0.97). In other words the two
 * engines agree about who played badly and disagree about what the number
 * should be called.
 *
 * That is not a cosmetic problem. Conversion and resourcefulness fire on an
 * absolute threshold (TutorMetrics::DECISIVE_CP), so an uncorrected scale gap
 * means "winning position" means two different things in the two corpora, and
 * every comparison in the product inherits the error.
 *
 * So the correction is fitted and applied at the EVAL level, before any metric
 * is computed — one adjustment at the source, after which every metric,
 * threshold and percentile is computed on one scale by one piece of code.
 *
 * The fit is a slope through the origin (an eval of 0 is 0 in any engine),
 * checked for linearity by reporting binned medians. Read-only apart from the
 * calibration file it writes.
 */

use App\Services\EngineSelector;
use BaseApi\App;

require_once __DIR__ . '/../vendor/autoload.php';

App::boot(dirname(__DIR__));

$path = $argv[1] ?? '';
if ($path === '' || !file_exists($path)) {
    fwrite(STDERR, "usage: php scripts/calibrate_tutor_evals.php <calibration.jsonl> [--limit=N] [--movetime=MS] [--out=PATH]\n");
    exit(1);
}

$limit = 100;
$movetime = 100;
$out = dirname(__DIR__) . '/storage/tutor-calibration.json';

foreach (array_slice($argv, 2) as $arg) {
    if (preg_match('/^--limit=(\d+)$/', $arg, $m)) {
        $limit = (int) $m[1];
    }

    if (preg_match('/^--movetime=(\d+)$/', $arg, $m)) {
        $movetime = (int) $m[1];
    }

    if (preg_match('/^--out=(.+)$/', $arg, $m)) {
        $out = $m[1];
    }
}

/** Positions with |eval| above this are excluded from the fit — both engines
 *  are just saying "winning" and the exact number is noise. */
const FIT_CLAMP = 1200;

$engine = App::container()->make(EngineSelector::class);

$pairs = [];
$mateAgreement = ['both' => 0, 'onlyOurs' => 0, 'onlyTheirs' => 0];

$done = 0;
$failed = 0;
$started = microtime(true);

fwrite(STDERR, sprintf("Fitting Lichess -> zugzwang eval scale at %dms/position\n\n", $movetime));

$handle = fopen($path, 'r');
if ($handle === false) {
    fwrite(STDERR, "cannot open {$path}\n");
    exit(1);
}

while (($line = fgets($handle)) !== false && $done < $limit) {
    $line = trim($line);
    if ($line === '') {
        continue;
    }

    $game = json_decode($line, true);
    if (!is_array($game)) {
        continue;
    }

    try {
        $res = $engine->analyzeGame($game['ucis'] ?? [], null, $movetime);
    } catch (Throwable) {
        $failed++;
        continue;
    }

    $positions = $res['positions'] ?? [];
    $theirs = $game['lichessEvals'] ?? [];

    if (count($positions) !== count($theirs)) {
        $failed++;
        continue;
    }

    foreach ($positions as $i => $position) {
        $mine = $position['eval'] ?? null;
        $their = $theirs[$i] ?? null;

        if (!is_array($mine) || !isset($mine['type'], $mine['value']) || !is_array($their)) {
            continue;
        }

        $mineIsMate = $mine['type'] === 'mate';
        $theirIsMate = ($their['type'] ?? '') === 'mate';

        if ($mineIsMate || $theirIsMate) {
            $key = $mineIsMate && $theirIsMate ? 'both' : ($mineIsMate ? 'onlyOurs' : 'onlyTheirs');
            $mateAgreement[$key]++;
            continue;
        }

        // zugzwang returns side-to-move-relative; the corpus is White-POV.
        $ourWhite = ($position['sideToMove'] ?? 'w') === 'b' ? -(int) $mine['value'] : (int) $mine['value'];
        $theirWhite = (int) $their['value'];

        if (abs($ourWhite) > FIT_CLAMP || abs($theirWhite) > FIT_CLAMP) {
            continue;
        }

        $pairs[] = [$theirWhite, $ourWhite];
    }

    $done++;

    if ($done % 25 === 0) {
        fwrite(STDERR, sprintf("  %d games, %s paired positions (%.0fs)\n", $done, number_format(count($pairs)), microtime(true) - $started));
    }
}

fclose($handle);

if (count($pairs) < 500) {
    fwrite(STDERR, sprintf(
        "\nToo few paired positions to fit anything trustworthy: %d pairs from %d games (%d games failed).\n",
        count($pairs),
        $done,
        $failed,
    ));

    if ($failed > $done) {
        fwrite(STDERR, "Most games failed outright — check the engine is up: curl 127.0.0.1:6476/healthz\n");
    }

    exit(1);
}

// --- Fit -------------------------------------------------------------------
// Slope through the origin: an even position is 0 under any engine, so an
// intercept would only add a bias with no physical meaning.

$sumXY = 0.0;
$sumXX = 0.0;
foreach ($pairs as [$x, $y]) {
    $sumXY += $x * $y;
    $sumXX += $x * $x;
}

$slope = $sumXX > 0 ? $sumXY / $sumXX : 1.0;

// Correlation, to say how well a single number can describe the relationship.
$n = count($pairs);
$meanX = array_sum(array_column($pairs, 0)) / $n;
$meanY = array_sum(array_column($pairs, 1)) / $n;

$num = 0.0;
$devX = 0.0;
$devY = 0.0;
foreach ($pairs as [$x, $y]) {
    $num += ($x - $meanX) * ($y - $meanY);
    $devX += ($x - $meanX) ** 2;
    $devY += ($y - $meanY) ** 2;
}

$corr = ($devX > 0 && $devY > 0) ? $num / sqrt($devX * $devY) : 0.0;

// --- Linearity check -------------------------------------------------------
// If one slope really describes the mapping, the ratio should hold across the
// range rather than drifting with magnitude.

$bins = [];
foreach ($pairs as [$x, $y]) {
    $bin = (int) (floor(abs($x) / 100) * 100);
    $bins[$bin][] = abs($x) < 1 ? 0.0 : $y / $x;
}

ksort($bins);

fwrite(STDERR, sprintf(
    "\nReplayed %d games (%d failed) in %.0fs — %s paired positions\n\n",
    $done,
    $failed,
    microtime(true) - $started,
    number_format($n),
));

printf("Fitted slope (lichess -> zugzwang): %.4f\n", $slope);
printf("Pearson correlation:                %.4f\n", $corr);
printf("Mate disagreement: both=%d oursOnly=%d theirsOnly=%d\n\n", $mateAgreement['both'], $mateAgreement['onlyOurs'], $mateAgreement['onlyTheirs']);

printf("%-14s %8s %10s\n", '|lichess cp|', 'n', 'median k');
printf("%s\n", str_repeat('-', 34));

foreach ($bins as $bin => $ratios) {
    if (count($ratios) < 30) {
        continue;
    }

    sort($ratios);
    printf("%-14s %8d %10.3f\n", $bin . '-' . ($bin + 99), count($ratios), $ratios[(int) (count($ratios) / 2)]);
}

$payload = [
    'fittedAt' => date('c'),
    'movetimeMs' => $movetime,
    'games' => $done,
    'positions' => $n,
    'slope' => round($slope, 5),
    'correlation' => round($corr, 5),
    'engine' => 'zugzwang',
    'note' => 'Multiply a Lichess-published centipawn eval by `slope` to put it on zugzwang’s scale.',
];

if (!is_dir(dirname($out))) {
    mkdir(dirname($out), 0755, true);
}

file_put_contents($out, json_encode($payload, JSON_PRETTY_PRINT) . "\n");

printf("\nWrote %s\n", $out);
printf("\nA slope near 1.0 would mean the two engines already agree. Anything else\n");
printf("is applied to every corpus eval BEFORE metrics are computed, so thresholds\n");
printf("like TutorMetrics::DECISIVE_CP mean the same thing in both corpora.\n");
