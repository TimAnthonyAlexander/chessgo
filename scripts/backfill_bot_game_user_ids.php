<?php

declare(strict_types=1);

/**
 * ONE-OFF MAINTENANCE SCRIPT — backfill white_user_id/black_user_id for
 * bot-account games persisted before the GameResultController fix that
 * attaches accounts whenever a side's uid resolves to a real `user` row
 * (bot account or not), not just for humans.
 *
 * Before the fix, GameResultController set white_user_id/black_user_id only
 * from resolveAccount() — which deliberately returns null for ANY bot side
 * (that's the Elo path and must stay that way). So every arena game played by
 * a seeded bot account (role='bot', a real `user` row, uid = the account's
 * real id) persisted with white_uid/black_uid populated but the matching
 * *_user_id left null — invisible on the bot's own profile (0 games, empty
 * history) even though the game row exists.
 *
 * This script is the one-time correction for games that already landed in
 * the DB under the old behavior: for every game where a side's *_user_id is
 * still null but its *_uid matches a real `user.id`, fill in *_user_id from
 * that match. It does NOT touch Elo, ratings, or anything else — it only
 * fills the two nullable FK columns, and only where they're currently null.
 *
 * Ordinary hub backfill bots (bot-<random> uids) don't match any user row,
 * so they correctly stay null — same as resolveAccount()/the fix leaves them.
 *
 * Idempotent: matched rows have *_user_id set to NOT NULL after the first
 * run, so a re-run finds nothing left to do (0 rows), regardless of --dry-run.
 *
 * DML only — plain UPDATE statements against existing columns. No DDL, no
 * migrations; nothing here touches the schema.
 *
 * Usage:
 *   php scripts/backfill_bot_game_user_ids.php [--dry-run]
 *     --dry-run   report how many rows WOULD change, write nothing
 */

use BaseApi\App;

require_once __DIR__ . '/../vendor/autoload.php';

App::boot(dirname(__DIR__));

$dryRun = in_array('--dry-run', array_slice($argv, 1), true);
foreach (array_slice($argv, 1) as $arg) {
    if ($arg !== '--dry-run') {
        fwrite(STDERR, "unknown argument: {$arg}\n");
        exit(1);
    }
}

$db = App::db();

// One row per (side, count) so the report is exact even when a run is
// re-triggered mid-way. Match by uid == user.id; only rows still null.
$sides = [
    'white' => ['uid' => 'white_uid', 'user_id' => 'white_user_id'],
    'black' => ['uid' => 'black_uid', 'user_id' => 'black_user_id'],
];

fwrite(STDOUT, ($dryRun ? "DRY RUN — " : '') . "backfilling game.*_user_id from *_uid where it matches a real user row…\n");

$totalMatched = 0;
$totalUpdated = 0;

foreach ($sides as $side => $cols) {
    $uidCol = $cols['uid'];
    $userIdCol = $cols['user_id'];

    $countRows = $db->raw(
        "SELECT COUNT(*) AS n FROM game g JOIN user u ON u.id = g.{$uidCol} WHERE g.{$userIdCol} IS NULL AND g.{$uidCol} <> ''",
        [],
    );
    $matched = (int) ($countRows[0]['n'] ?? 0);
    $totalMatched += $matched;

    fwrite(STDOUT, sprintf("  %s: %d row(s) with a real user match and null %s\n", $side, $matched, $userIdCol));

    if ($dryRun || $matched === 0) {
        continue;
    }

    $db->raw(
        "UPDATE game g JOIN user u ON u.id = g.{$uidCol} SET g.{$userIdCol} = u.id WHERE g.{$userIdCol} IS NULL AND g.{$uidCol} <> ''",
        [],
    );
    $totalUpdated += $matched;
}

fwrite(STDOUT, sprintf(
    "done: %d row(s) matched%s\n",
    $totalMatched,
    $dryRun ? ' (dry-run, nothing written)' : ", {$totalUpdated} updated",
));
exit(0);
