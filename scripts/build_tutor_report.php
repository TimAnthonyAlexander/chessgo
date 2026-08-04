<?php

declare(strict_types=1);

/**
 * Build a Tutor report for one user, synchronously, and print what came out.
 *
 * Usage:
 *   php scripts/build_tutor_report.php <username> [--range=6m] [--summary]
 *
 * The normal path is the queue (TutorReportJob). This runs the same
 * TutorBuildService inline, which is what you want when you're checking
 * whether the pipeline produces something sensible without waiting on a
 * worker — and when you want the failure in your terminal rather than in a
 * log.
 *
 * Writes a real tutor_report row, exactly as a user request would.
 */

use App\Models\TutorReport;
use App\Models\User;
use App\Services\Tutor\TutorBuildService;
use BaseApi\App;

require_once __DIR__ . '/../vendor/autoload.php';

App::boot(dirname(__DIR__));

$name = $argv[1] ?? '';
if ($name === '' || str_starts_with($name, '--')) {
    fwrite(STDERR, "usage: php scripts/build_tutor_report.php <username> [--range=6m] [--summary]\n");
    exit(1);
}

$range = '6m';
$summaryOnly = false;
foreach (array_slice($argv, 2) as $arg) {
    if (preg_match('/^--range=(\w+)$/', $arg, $m)) {
        $range = $m[1];
    }

    if ($arg === '--summary') {
        $summaryOnly = true;
    }
}

$ranges = ['1m' => '-1 month', '3m' => '-3 months', '6m' => '-6 months', '12m' => '-12 months'];
if (!isset($ranges[$range])) {
    fwrite(STDERR, "unknown range: {$range}\n");
    exit(1);
}

$user = User::firstWhere('name', '=', $name);
if (!$user instanceof User) {
    fwrite(STDERR, "no such user: {$name}\n");
    exit(1);
}

$report = new TutorReport();
$report->user_id = $user->id;
$report->range_label = $range;
$report->range_from = date('Y-m-d H:i:s', strtotime($ranges[$range]));
$report->range_to = date('Y-m-d H:i:s');
$report->status = 'queued';
$report->save();

fwrite(STDERR, sprintf("Building report %s for %s (%s)…\n", $report->id, $user->name, $range));

$started = microtime(true);
App::container()->make(TutorBuildService::class)->build($report);
$elapsed = microtime(true) - $started;

$report = TutorReport::find($report->id);
if (!$report instanceof TutorReport) {
    fwrite(STDERR, "report vanished\n");
    exit(1);
}

fwrite(STDERR, sprintf(
    "\nstatus=%s in %.1fs — considered=%d used=%d analyzed=%d capHit=%s\n",
    $report->status,
    $elapsed,
    $report->games_considered,
    $report->games_used,
    $report->games_analyzed,
    $report->cap_hit ? 'yes' : 'no',
));

if ($report->error !== null) {
    fwrite(STDERR, "error: {$report->error}\n");
}

$payload = $report->getPayload();

if (!$summaryOnly) {
    echo json_encode($payload, JSON_PRETTY_PRINT | JSON_UNESCAPED_SLASHES), "\n";
    exit(0);
}

// --- Human-readable summary -------------------------------------------------

echo "\nHEADLINE: ", $payload['headline']['text'] ?? '(none)', "\n";
echo 'baseline source: ', $payload['baselineSource'] ?? '(none)', "\n";

foreach ($payload['insufficient'] ?? [] as $category => $info) {
    printf("  %-11s %d of %d games — not enough\n", $category, $info['games'], $info['need']);
}

foreach ($payload['categories'] ?? [] as $category => $section) {
    printf(
        "\n=== %s — %d of %d games, rating %d, peer tier '%s' (%d-%d) ===\n",
        strtoupper($category),
        $section['games'],
        $section['gamesAvailable'],
        $section['rating'],
        $section['peer']['tier'],
        $section['peer']['bandFrom'],
        $section['peer']['bandTo'],
    );

    printf("\n  %-24s %10s %10s %8s\n", 'metric', 'you', 'peers', 'games');
    foreach ($section['metrics'] ?? [] as $metric => $entry) {
        $comparison = null;
        foreach ($section['comparisons'] ?? [] as $c) {
            if ($c['metric'] === $metric && $c['dimension'] === '') {
                $comparison = $c;
                break;
            }
        }

        printf(
            "  %-24s %10.1f %10s %8d  %s\n",
            $entry['label'],
            $entry['value'],
            $comparison === null ? '—' : sprintf('%.1f', $comparison['peer']),
            $entry['sample'],
            $comparison === null ? '' : $comparison['wording'],
        );
    }

    foreach (['strengths' => 'STRENGTHS', 'weaknesses' => 'WEAKNESSES'] as $key => $title) {
        if (($section[$key] ?? []) === []) {
            continue;
        }

        echo "\n  {$title}\n";
        foreach ($section[$key] as $c) {
            printf(
                "    %-22s %.1f vs %.1f — %s (n=%d, peers n=%d%s)\n",
                $c['label'],
                $c['mine'],
                $c['peer'],
                $c['wording'],
                $c['sample'],
                $c['peerSample'],
                $c['percentile'] === null ? '' : ', ' . $c['percentile'] . 'th pct',
            );
        }
    }

    foreach (['phases' => 'BY PHASE', 'pieces' => 'BY PIECE'] as $key => $title) {
        if (($section[$key] ?? []) === []) {
            continue;
        }

        echo "\n  {$title}\n";
        foreach (array_slice($section[$key], 0, 8) as $c) {
            printf("    %-24s %8.1f vs %8.1f  %s\n", $c['name'] ?? $c['dimension'], $c['mine'], $c['peer'], $c['wording']);
        }
    }

    // Openings are keyed by the colour they were played with.
    foreach (['w' => 'BY OPENING (as White)', 'b' => 'BY OPENING (as Black)'] as $colour => $title) {
        $list = $section['openings'][$colour] ?? [];
        if ($list === []) {
            continue;
        }

        echo "\n  {$title}\n";
        foreach (array_slice($list, 0, 6) as $c) {
            printf(
                "    %-28s %7.1f vs %7.1f  %-14s (n=%d)\n",
                $c['name'] ?? '?',
                $c['mine'],
                $c['peer'],
                $c['wording'],
                $c['sample'],
            );
        }
    }

    if (($section['drills'] ?? []) !== []) {
        echo "\n  DRILLS\n";
        foreach ($section['drills'] as $drill) {
            printf("    [%s] %s\n", $drill['kind'], $drill['title']);
            if (($drill['themes'] ?? []) !== []) {
                printf("      themes: %s\n", implode(', ', $drill['themes']));
            }

            if (($drill['positions'] ?? []) !== []) {
                printf("      %d positions, biggest swing %dcp\n", count($drill['positions']), $drill['positions'][0]['swing']);
            }

            if (($drill['games'] ?? []) !== []) {
                printf("      %d games\n", count($drill['games']));
            }
        }
    }
}

echo "\n";
