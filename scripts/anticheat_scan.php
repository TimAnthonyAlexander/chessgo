<?php

declare(strict_types=1);

/**
 * Out-of-band anti-cheat engine-correlation scan (SPEC §Anti-cheat).
 *
 * The expensive signal: a full-game engine pass per game (via GameAnalysisService)
 * to compute per-side ACPL / accuracy / top-1 match, compared against a
 * rating-band expectation. Too slow to run inside the game-persist request, so it
 * runs here — as a cron or manual sweep over recently finished rated games.
 *
 * Idempotent + resumable: each game is marked `ac_scanned` once processed, so a
 * re-run only picks up new games. Raises engine_correlation /
 * accuracy_rating_mismatch flags (never bans) via AnticheatService.
 *
 * Usage:
 *   php scripts/anticheat_scan.php [--limit=N] [--rescan] [--dry-run]
 *                                  [--include-admins] [--user=NAME|ID] [--stats]
 *     --limit=N        process at most N games this run (default 200)
 *     --rescan         also reset already-scanned games (re-analyze everything)
 *     --dry-run        analyze + print would-be flags, but write NOTHING (no
 *                      flags, no ac_scanned) — preview a sweep before committing
 *     --include-admins score admin sides too (dry-run only). A calibration knob:
 *                      admin games are the biggest sample of strong play we KNOW
 *                      is clean, so what trips on them is the false-positive rate.
 *     --user=NAME|ID   only games with that player on one side — investigate one
 *                      suspect instead of draining the queue.
 *     --stats          print the MEASUREMENTS (acpl / top-1 / accuracy / longest
 *                      best-move streak) for every scored side, tripped or not,
 *                      plus a threshold-distance summary. Implies --dry-run.
 *                      "Nothing flagged" and "nothing detectable" are different
 *                      answers, and only this mode distinguishes them.
 *
 * Cron example (every 10 min):
 *   *​/10 * * * * cd /path/to/chessgo && php scripts/anticheat_scan.php --limit=100
 */

use BaseApi\App;
use App\Models\Game;
use App\Models\User;
use App\Services\AnticheatService;

require_once __DIR__ . '/../vendor/autoload.php';

App::boot(dirname(__DIR__));

$limit = 200;
$rescan = false;
$dryRun = false;
$includeAdmins = false;
$stats = false;
$userArg = null;
foreach (array_slice($argv, 1) as $arg) {
    if (preg_match('/^--limit=(\d+)$/', $arg, $m)) {
        $limit = max(1, (int) $m[1]);
    } elseif (preg_match('/^--user=(.+)$/', $arg, $m)) {
        $userArg = $m[1];
    } elseif ($arg === '--rescan') {
        $rescan = true;
    } elseif ($arg === '--dry-run') {
        $dryRun = true;
    } elseif ($arg === '--include-admins') {
        $includeAdmins = true;
    } elseif ($arg === '--stats') {
        $stats = true;
        $dryRun = true; // measuring is never a reason to write
    } else {
        fwrite(STDERR, "unknown argument: {$arg}\n");
        exit(1);
    }
}

// Scoring admins is for calibration, never for the record: refuse to persist a
// flag against staff.
if ($includeAdmins && !$dryRun) {
    fwrite(STDERR, "--include-admins requires --dry-run (admin flags are never written)\n");
    exit(1);
}

$userId = null;
if ($userArg !== null) {
    $target = User::where('name', '=', $userArg)->first() ?? User::find($userArg);
    if (!$target instanceof User) {
        fwrite(STDERR, "no such user: {$userArg}\n");
        exit(1);
    }
    $userId = (string) $target->id;
    fwrite(STDOUT, sprintf("filtering to %s (%s)\n", $target->name, $userId));
}

/** @var AnticheatService $anticheat */
$anticheat = App::container()->make(AnticheatService::class);

if ($rescan && !$dryRun) {
    // Clear the scanned flag so the whole rated corpus is re-processed. Bulk DML
    // on existing rows (NOT schema DDL) — safe.
    App::db()->raw('UPDATE game SET ac_scanned = 0 WHERE rated = 1', []);
    fwrite(STDOUT, "rescan: cleared ac_scanned on all rated games\n");
}

// Oldest first, so a repeated cron drains the backlog in order. In dry-run we
// don't mark games, so include already-scanned ones too (preview any slice).
$q = Game::query()->where('rated', '=', true);
if (!$dryRun) {
    $q = $q->where('ac_scanned', '=', false);
}
if ($userId !== null) {
    // ModelQuery has no grouped OR, and a bare orWhere would break precedence
    // against the conditions above — resolve the id set first, then filter by it.
    $ids = array_column(
        App::db()->raw('SELECT id FROM game WHERE white_user_id = ? OR black_user_id = ?', [$userId, $userId]),
        'id',
    );
    if ($ids === []) {
        fwrite(STDOUT, "that player has no games\n");
        exit(0);
    }
    $q = $q->whereIn('id', $ids);
}
$games = $q->orderBy('created_at')->limit($limit)->get();

$total = count($games);
if ($total === 0) {
    fwrite(STDOUT, "nothing to scan (all rated games processed)\n");
    exit(0);
}

fwrite(STDOUT, ($dryRun ? "DRY RUN — " : "") . ($includeAdmins ? "admins included — " : "") . "scanning {$total} game(s)…\n");

if ($stats) {
    // Measure-only pass: every scored side, tripped or not, so the gap between
    // "clean" and "just under the threshold" is visible.
    $rows = [];
    foreach ($games as $game) {
        if (!$game instanceof Game) {
            continue;
        }
        foreach ($anticheat->measureGame($game, $includeAdmins) as $m) {
            $rows[] = $m;
        }
    }

    if ($rows === []) {
        fwrite(STDOUT, "no scorable sides (all games too short / wrong variant / no registered human)\n");
        exit(0);
    }

    fwrite(STDOUT, sprintf(
        "\n%-10s %-8s %-9s %4s %5s %5s %6s %6s %6s %6s %6s %5s  %s\n",
        'game', 'player', 'category', 'side', 'rtng', 'moves', 'acpl', 'exp', 'acc%', 'exp', 'top1%', 'strk', 'flags',
    ));
    foreach ($rows as $m) {
        fwrite(STDOUT, sprintf(
            "%-10s %-8s %-9s %4s %5d %5d %6d %6d %6.1f %6.1f %6.1f %5d  %s\n",
            substr((string) $m['game_id'], 0, 10),
            substr((string) $m['user_name'], 0, 8),
            substr((string) $m['category'], 0, 9),
            $m['side'],
            $m['rating'],
            $m['own_moves'],
            $m['acpl'],
            $m['expected_acpl'],
            $m['accuracy'],
            $m['expected_accuracy'],
            $m['t1_match'] * 100,
            $m['best_streak'],
            $m['flags'] === [] ? '-' : implode(',', $m['flags']),
        ));
    }

    $n = count($rows);
    $tripped = count(array_filter($rows, static fn(array $m): bool => $m['flags'] !== []));
    $t1s = array_map(static fn(array $m): float => (float) $m['t1_match'], $rows);
    $streaks = array_map(static fn(array $m): int => (int) $m['best_streak'], $rows);
    sort($t1s);
    sort($streaks);
    $median = static fn(array $v): float => count($v) % 2 === 1
        ? (float) $v[intdiv(count($v), 2)]
        : ((float) $v[intdiv(count($v), 2) - 1] + (float) $v[intdiv(count($v), 2)]) / 2;

    fwrite(STDOUT, sprintf(
        "\n%d scored side(s), %d tripped (%.1f%%)\n" .
        "top-1 match: median %.1f%%, max %.1f%% (engine_correlation needs >=60%%)\n" .
        "longest best-move streak: median %d, max %d (no threshold reads this)\n",
        $n,
        $tripped,
        $n > 0 ? $tripped / $n * 100 : 0.0,
        $median($t1s) * 100,
        end($t1s) * 100,
        (int) $median($streaks),
        (int) end($streaks),
    ));
    exit(0);
}

$flagged = 0;
$errors = 0;
foreach ($games as $game) {
    if (!$game instanceof Game) {
        continue;
    }
    $candidates = $anticheat->scanEngineCorrelation($game, $dryRun, $includeAdmins);
    foreach ($candidates as $c) {
        $flagged++;
        fwrite(STDOUT, sprintf(
            "  [%s] %s (%s): %s\n",
            $c['severity'],
            $c['user_name'] !== '' ? $c['user_name'] : $c['user_id'],
            $c['category'],
            $c['detail'],
        ));
    }
    // On a real run scanEngineCorrelation marks every processed game (even skips),
    // so the loop always makes forward progress. A still-unscanned game means the
    // analysis threw (engine down) — count it so a nonzero exit is visible to cron.
    if (!$dryRun && !$game->ac_scanned) {
        $errors++;
    }
}

fwrite(STDOUT, sprintf(
    "done: %d game(s) processed, %d flag(s)%s, %d error(s)\n",
    $total,
    $flagged,
    $dryRun ? ' (dry-run, not written)' : ' raised',
    $errors,
));
exit($errors > 0 ? 1 : 0);
