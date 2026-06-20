<?php

declare(strict_types=1);

/**
 * Clear the cached full-game analysis (`game.analysis`) for past games so they
 * re-analyze (at the current GameAnalysisService::VERSION) on their next open.
 *
 * Why: the analysis blob is cached forever per game keyed by VERSION. Bumping
 * VERSION already invalidates stale blobs lazily — but this lets you force a
 * clean slate immediately (e.g. after a payload-shape change) without waiting
 * for each game to be reopened, and reclaims the TEXT column storage now.
 *
 * This is bulk DML (UPDATE ... SET analysis = NULL), NOT schema DDL — it never
 * touches the table definition, only row data.
 *
 * Usage:
 *   php scripts/clear_analyses.php            # DRY RUN — counts only, no writes
 *   php scripts/clear_analyses.php --commit   # actually clear every cached blob
 *
 * Re-run safe + idempotent: clearing an already-null analysis is a no-op.
 */

use BaseApi\App;

require_once __DIR__ . '/../vendor/autoload.php';

App::boot(dirname(__DIR__));

$commit = in_array('--commit', array_slice($argv, 1), true);

$db = App::db();

// Table is singular snake_case for the `Game` model (BaseAPI convention).
$cached = (int) $db->scalar('SELECT COUNT(*) FROM game WHERE analysis IS NOT NULL');
$total = (int) $db->scalar('SELECT COUNT(*) FROM game');

fwrite(STDOUT, "Games total:            {$total}\n");
fwrite(STDOUT, "Games with cached analysis: {$cached}\n");

if ($cached === 0) {
    fwrite(STDOUT, "Nothing to clear.\n");
    exit(0);
}

if (!$commit) {
    fwrite(STDOUT, "\nDRY RUN — no changes made. Re-run with --commit to clear these {$cached} blob(s).\n");
    exit(0);
}

$affected = $db->exec('UPDATE game SET analysis = NULL WHERE analysis IS NOT NULL');

fwrite(STDOUT, "\nCleared analysis on {$affected} game(s). They will re-analyze on next open.\n");
exit(0);
