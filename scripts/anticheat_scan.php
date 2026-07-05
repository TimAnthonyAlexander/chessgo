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
 *     --limit=N   process at most N games this run (default 200)
 *     --rescan    also reset already-scanned games (re-analyze everything)
 *     --dry-run   analyze + print would-be flags, but write NOTHING (no flags,
 *                 no ac_scanned) — preview a sweep before committing to it
 *
 * Cron example (every 10 min):
 *   *​/10 * * * * cd /path/to/chessgo && php scripts/anticheat_scan.php --limit=100
 */

use BaseApi\App;
use App\Models\Game;
use App\Services\AnticheatService;

require_once __DIR__ . '/../vendor/autoload.php';

App::boot(dirname(__DIR__));

$limit = 200;
$rescan = false;
$dryRun = false;
foreach (array_slice($argv, 1) as $arg) {
    if (preg_match('/^--limit=(\d+)$/', $arg, $m)) {
        $limit = max(1, (int) $m[1]);
    } elseif ($arg === '--rescan') {
        $rescan = true;
    } elseif ($arg === '--dry-run') {
        $dryRun = true;
    } else {
        fwrite(STDERR, "unknown argument: {$arg}\n");
        exit(1);
    }
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
$games = $q->orderBy('created_at')->limit($limit)->get();

$total = count($games);
if ($total === 0) {
    fwrite(STDOUT, "nothing to scan (all rated games processed)\n");
    exit(0);
}

fwrite(STDOUT, ($dryRun ? "DRY RUN — " : "") . "scanning {$total} game(s)…\n");

$flagged = 0;
$errors = 0;
foreach ($games as $game) {
    if (!$game instanceof Game) {
        continue;
    }
    $candidates = $anticheat->scanEngineCorrelation($game, $dryRun);
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
