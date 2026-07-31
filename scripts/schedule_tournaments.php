<?php

declare(strict_types=1);

/**
 * Keeps the tournament calendar populated: computes every occurrence the
 * recurring rota ({@see \App\Services\TournamentSchedule}) says should exist
 * between now and now+horizon, and inserts whichever ones don't already
 * exist yet (matched by the unique `schedule_key`).
 *
 * Idempotent by construction: `schedule_key` is one-per-occurrence
 * (e.g. "hourly-bullet-2026-08-01T14:00:00Z"), so a re-run only ever inserts
 * the slice of the window that's new — running it twice in a row back-to-back
 * creates nothing the second time. This NEVER updates or deletes an existing
 * tournament row (someone may already have joined it).
 *
 * Usage:
 *   php scripts/schedule_tournaments.php [--horizon-hours=N] [--dry-run]
 *     --horizon-hours=N   populate through now+N hours (default 48)
 *     --dry-run           print what would be created, create nothing
 *
 * Cron/timer example (every 10 min — see deploy/chessgo-schedule-tournaments.timer):
 *   *​/10 * * * * cd /path/to/chessgo && php scripts/schedule_tournaments.php
 */

use BaseApi\App;
use App\Models\Tournament;
use App\Services\TournamentSchedule;

require_once __DIR__ . '/../vendor/autoload.php';

App::boot(dirname(__DIR__));

$horizonHours = 48;
$dryRun = false;
foreach (array_slice($argv, 1) as $arg) {
    if (preg_match('/^--horizon-hours=(\d+)$/', $arg, $m)) {
        $horizonHours = max(1, (int) $m[1]);
    } elseif ($arg === '--dry-run') {
        $dryRun = true;
    } else {
        fwrite(STDERR, "unknown argument: {$arg}\n");
        exit(1);
    }
}

$from = time();
$to = $from + $horizonHours * 3600;

$occurrences = TournamentSchedule::occurrencesBetween($from, $to);
$total = count($occurrences);

if ($total === 0) {
    fwrite(STDOUT, "nothing scheduled in the next {$horizonHours}h window\n");
    exit(0);
}

// One batched lookup for every schedule_key in the window, rather than a
// query per occurrence.
$keys = array_map(static fn (array $occ): string => $occ['schedule_key'], $occurrences);
$existing = [];
foreach (Tournament::query()->whereIn('schedule_key', $keys)->get() as $t) {
    if ($t instanceof Tournament && $t->schedule_key !== null) {
        $existing[$t->schedule_key] = true;
    }
}

fwrite(STDOUT, ($dryRun ? "DRY RUN — " : "") . sprintf(
    "%d occurrence(s) in the next %dh window, %d already exist\n",
    $total,
    $horizonHours,
    count($existing),
));

$created = 0;
$skipped = 0;
$errors = 0;

foreach ($occurrences as $occ) {
    if (isset($existing[$occ['schedule_key']])) {
        $skipped++;
        continue;
    }

    if ($dryRun) {
        fwrite(STDOUT, sprintf(
            "  would create: %s  %s %s  starts %s UTC  (%s)\n",
            $occ['schedule_key'],
            $occ['name'],
            $occ['pool'],
            $occ['starts_at'],
            $occ['series'],
        ));
        $created++;
        continue;
    }

    $tournament = new Tournament();
    $tournament->name = $occ['name'];
    $tournament->variant = $occ['variant'];
    $tournament->pool = $occ['pool'];
    $tournament->starts_at = $occ['starts_at'];
    $tournament->duration_minutes = $occ['duration_minutes'];
    $tournament->rated = $occ['rated'];
    $tournament->status = 'scheduled';
    $tournament->created_by = 'scheduler';
    $tournament->schedule_key = $occ['schedule_key'];
    $tournament->series = $occ['series'];
    $tournament->min_rating = $occ['min_rating'];
    $tournament->max_rating = $occ['max_rating'];
    $tournament->titled_only = $occ['titled_only'];

    if ($tournament->save()) {
        $created++;
        fwrite(STDOUT, sprintf(
            "  created: %s  %s %s  starts %s UTC\n",
            $occ['schedule_key'],
            $occ['name'],
            $occ['pool'],
            $occ['starts_at'],
        ));
    } else {
        $errors++;
        fwrite(STDERR, "  FAILED to create: {$occ['schedule_key']}\n");
    }
}

fwrite(STDOUT, sprintf(
    "done: %d created%s, %d already existed (skipped), %d error(s)\n",
    $created,
    $dryRun ? ' (dry-run, not written)' : '',
    $skipped,
    $errors,
));
exit($errors > 0 ? 1 : 0);
