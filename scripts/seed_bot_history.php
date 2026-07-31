<?php

declare(strict_types=1);

/**
 * Backfill REAL history for every role='bot' account so a bot's profile is
 * internally consistent, instead of the seeded-props tell it was: a real GM
 * bot shipped "276 bullet games / 2400" on the ratings tiles next to "0% win
 * rate · 0 games" on the record and "0W 31L" on the puzzle line — three
 * numbers that all come from different places (see ProfileController) and
 * none of which agreed, because seed_bot_accounts.php used to stamp a random
 * `games_<cat>` counter straight onto the `user` row with zero rows behind it.
 *
 * Confirmed against ProfileController/ProfileGamesController before writing
 * this:
 *   - `record` (wins/losses/draws/total) is a LIVE COUNT over `game` rows by
 *     white/black_user_id + result. No counter backs it — it can't lie once
 *     the rows are real.
 *   - Per-category rating tiles ('games' on each) are the `games_<cat>`
 *     COUNTER on `user`, read verbatim — never derived from `game` rows. This
 *     is the one that was fabricated.
 *   - Puzzle 'solved' is a LIVE COUNT over `puzzle_attempt` (solved=1); puzzle
 *     'games' is the `games_puzzle` COUNTER. The "0W 31L" bug is exactly
 *     COUNT(solved)=0 next to games_puzzle=31 with no puzzle_attempt rows at
 *     all for that bot.
 *
 * DECISION — counters are SET FROM the seed, not seeded up to the old counter:
 * reproducing hundreds of self-played games per category per bot (~40 bots)
 * would be tens of thousands of engine self-play games for a cosmetic profile
 * fix. Instead this script self-plays a modest, explicit batch per bot per
 * category (default 8 — "a few dozen" total across 4 categories) and then SETS
 * games_<cat> to whatever actually landed in `game`. Real-and-small beats
 * fake-and-large, and it's what the task asked for.
 *
 * DECISION — duck/crazyhouse/antichess are ZEROED, not backfilled: the only
 * batch self-play tool available (`gomachine gengames`, exactly what
 * scripts/seed_games.php already uses) only plays STANDARD chess from the
 * start position — no variant flag. zugzwang's serve HTTP exposes
 * `/duck/*` and `/crazyhouse/*` but self-playing those move-by-move over HTTP
 * would be a slow per-ply round trip per game (a real search every ply, tens
 * of bots x tens of games x ~60 plies) — that fails this task's own "sane
 * generation cost" bar, and there's no `/antichess/*` serve route at all yet
 * (only a dev-only CLI `antichess-selfplay` inside zugzwang's perft_test
 * binary, not part of the PHP-callable surface). So: games_duck /
 * games_crazyhouse / games_antichess are set to 0 and their rating/RD reset to
 * User's own fresh defaults (1500 / RD 350, provisional) — "never played this
 * variant" is honest; a fabricated 206-game Duck history is not.
 *
 * Mirrors scripts/seed_games.php's method exactly for the categories it CAN
 * back: pair opponents by rating proximity across a combined pool of bots +
 * the existing @seed.local users (so a bot's opponent list isn't suspiciously
 * all-bots), self-play the whole batch in ONE parallel `gomachine gengames`
 * invocation, persist Game rows with ratings frozen (white/black_rating_before
 * == _after — bots never take Elo), white_user_id/black_user_id set from the
 * start (no NULL-white-user_id bug to backfill later).
 *
 * Idempotent: clears its own marked rows (hub_game_id LIKE 'botgame-%', every
 * puzzle_attempt owned by a bot user) then reinserts, and ALWAYS recomputes
 * every bot's games_<cat> counters from a live COUNT over the rows actually
 * present afterward — so a re-run can never double a count or leave a stale
 * one behind, regardless of what a bot's counters looked like before this
 * script ever touched them (this also repairs bots seeded by an older version
 * of seed_bot_accounts.php, not just freshly-created ones).
 *
 * NAMESPACE ISOLATION from scripts/seed_games.php: that script owns
 * 'seedgame-'-prefixed rows for @seed.local leaderboard users and deletes by
 * that prefix on every run. An older version of THIS script wrote bot games
 * under the SAME 'seedgame-' prefix, so seed_games.php's clear-then-insert
 * (or its own --delete) would silently wipe bot history, and vice versa.
 * Fixed by giving bot rows their own prefix (BOT_GAME_PREFIX = 'botgame-')
 * and scoping every operation here — clear, --delete, counting — to it.
 * remarkLegacyBotRows() below is the one-time (but idempotent, safe to run
 * every invocation) repair for rows already written under the old shared
 * 'seedgame-' prefix before this fix existed: it re-marks any 'seedgame-' row
 * that belongs to a bot account onto 'botgame-', rewriting ONLY the prefix
 * (same random suffix) so ownership/ratings/counts never move.
 *
 * IDEMPOTENCY STRATEGY — skip-if-already-seeded, not clear-then-insert:
 * clear-then-insert on every run means a re-run deletes ~40 bots' entire
 * history and regenerates it via ~25 minutes of engine self-play, during
 * which every bot's profile sits half-empty. Default behaviour now generates
 * ONLY for bots with no 'botgame-' rows yet (a fresh bot from
 * seed_bot_accounts.php) and leaves already-seeded bots' games/puzzle
 * attempts completely untouched — no delete, no regenerate, no window where
 * their counters are wrong. Counters are still reconciled (from a live COUNT)
 * for every bot on every run, which is cheap and self-healing. Pass --force
 * to get the old full wipe-and-regenerate-everyone behaviour when you
 * actually want it (e.g. after changing the pairing/rating logic).
 *
 * created_at: every bot's account is backdated (deterministically, by
 * seed_bot_accounts.php) so it predates its own history; this script spreads
 * generated games across up to ~300 days, floored at max(white.created_at,
 * black.created_at) — never before either side existed.
 *
 * Usage:
 *   php scripts/seed_bot_history.php [gamesPerBotPerCategory]   # default 8
 *     only generates for bots with no seeded ('botgame-') history yet.
 *   php scripts/seed_bot_history.php --force [gamesPerBotPerCategory]
 *     full wipe-and-regenerate for EVERY bot (the old always-clear behaviour).
 *   php scripts/seed_bot_history.php --delete
 *     remove all 'botgame-' rows + bot puzzle attempts, reset counters.
 */

use BaseApi\App;
use App\Models\Game;
use App\Services\Glicko2Service;

require_once __DIR__ . '/../vendor/autoload.php';

App::boot(dirname(__DIR__));

const BOT_GAME_PREFIX = 'botgame-';
// The prefix scripts/seed_games.php owns. Only referenced here to repair rows
// an older version of this script mistakenly wrote under it — never to write
// new ones. Must stay in sync with seed_games.php's SEED_GAME_PREFIX.
const LEGACY_SHARED_PREFIX = 'seedgame-';
const ENGINE_BIN = __DIR__ . '/../gomachine/bin/gomachine';

// Representative pool per category (categoryForPool maps these back to the category) —
// same mapping seed_games.php uses.
const CATEGORY_POOLS = [
    'bullet' => '1+0',
    'blitz' => '3+0',
    'rapid' => '10+0',
    'classical' => '30+0',
];
const CATEGORIES = ['bullet', 'blitz', 'rapid', 'classical'];

// No batch self-play tool for these — always zeroed/reset. See docblock.
const UNBACKED_CATEGORIES = ['duck', 'crazyhouse', 'antichess'];

$db = App::db();

// --- CLI args -------------------------------------------------------------
$argvRest = array_slice($argv, 1);
$deleteMode = in_array('--delete', $argvRest, true);
$forceMode = in_array('--force', $argvRest, true);
$gamesPerCat = 8;
foreach ($argvRest as $a) {
    if (ctype_digit($a)) {
        $gamesPerCat = max(1, (int) $a);
    }
}

/** Ids of every role='bot' account. */
function botIds(\BaseApi\Database\DB $db): array
{
    $rows = $db->raw("SELECT id FROM user WHERE role = 'bot'");
    return array_map(static fn (array $r): string => (string) $r['id'], $rows);
}

/**
 * Ids of role='bot' accounts that already have at least one 'botgame-' row
 * (as either side) — i.e. already seeded by this script. Used to skip
 * regeneration for them by default.
 */
function seededBotIds(\BaseApi\Database\DB $db): array
{
    $rows = $db->raw(
        "SELECT DISTINCT u.id AS id FROM user u "
        . 'JOIN game g ON (g.white_user_id = u.id OR g.black_user_id = u.id) '
        . "WHERE u.role = 'bot' AND g.hub_game_id LIKE ?",
        [BOT_GAME_PREFIX . '%'],
    );
    return array_map(static fn (array $r): string => (string) $r['id'], $rows);
}

/**
 * One-time (but idempotent — safe on every invocation) repair: re-mark any
 * 'seedgame-' row that belongs to a bot account (white_user_id/black_user_id
 * resolves to a role='bot' user) onto 'botgame-'. Rewrites ONLY the prefix —
 * same random suffix — so ownership, ratings, and counts never move; only
 * the marker string does. After the first run no row can match the WHERE
 * clause again (they're 'botgame-%' by then), so re-running is a no-op.
 */
function remarkLegacyBotRows(\BaseApi\Database\DB $db): int
{
    return $db->exec(
        'UPDATE game SET hub_game_id = CONCAT(?, SUBSTRING(hub_game_id, ?)) '
        . 'WHERE hub_game_id LIKE ? '
        . "AND (white_user_id IN (SELECT id FROM user WHERE role = 'bot') "
        . "OR black_user_id IN (SELECT id FROM user WHERE role = 'bot'))",
        [BOT_GAME_PREFIX, strlen(LEGACY_SHARED_PREFIX) + 1, LEGACY_SHARED_PREFIX . '%'],
    );
}

/** Full wipe: every 'botgame-' game (regardless of which bot) + every puzzle_attempt
 *  owned by a CURRENT bot account. Used by --delete and --force (matches the
 *  script's original always-clear behaviour). Prefix-scoped only (no id filter)
 *  so it also sweeps up orphaned rows from a since-deleted bot account. */
function clearAllSeeded(\BaseApi\Database\DB $db): array
{
    $delGames = $db->exec('DELETE FROM game WHERE hub_game_id LIKE ?', [BOT_GAME_PREFIX . '%']);
    $ids = botIds($db);
    $delAttempts = 0;
    if ($ids !== []) {
        $ph = implode(',', array_fill(0, count($ids), '?'));
        $delAttempts = $db->exec("DELETE FROM puzzle_attempt WHERE user_id IN ($ph)", $ids);
    }

    return [$delGames, $delAttempts];
}

/** Scoped wipe: only 'botgame-' games and puzzle attempts belonging to the given
 *  bot ids. Used for the default incremental run so already-seeded bots' good
 *  history is never touched — this only ever clears partial/crash leftovers for
 *  bots about to be (re)generated. */
function clearSeededForIds(\BaseApi\Database\DB $db, array $ids): array
{
    if ($ids === []) {
        return [0, 0];
    }
    $ph = implode(',', array_fill(0, count($ids), '?'));
    $delGames = $db->exec(
        "DELETE FROM game WHERE hub_game_id LIKE ? AND (white_user_id IN ($ph) OR black_user_id IN ($ph))",
        [BOT_GAME_PREFIX . '%', ...$ids, ...$ids],
    );
    $delAttempts = $db->exec("DELETE FROM puzzle_attempt WHERE user_id IN ($ph)", $ids);

    return [$delGames, $delAttempts];
}

/**
 * Backdate every bot's `created_at` so "Member since" predates its own
 * history, using the SAME deterministic formula seed_bot_accounts.php applies
 * to newly-created bots (180..730 days back, keyed off the bot's numeric
 * index in its `botNNN@bot.local` email) — so re-running never shifts a
 * bot's date, and bots created before this fix existed (e.g. the ones already
 * in the DB with "Member since today") get repaired too, not just new ones.
 */
function backdateBotAccounts(\BaseApi\Database\DB $db, int $now): int
{
    $rows = $db->raw("SELECT id, email FROM user WHERE role = 'bot'");
    $touched = 0;
    foreach ($rows as $r) {
        if (preg_match('/^bot(\d+)@bot\.local$/', (string) $r['email'], $m) !== 1) {
            continue; // not one of our seeded bots (defensive) — leave untouched
        }
        $i = (int) $m[1];
        mt_srand($i * 67867967 + 23); // identical formula to seed_bot_accounts.php
        $daysAgo = mt_rand(180, 730);
        $createdAt = date('Y-m-d H:i:s', $now - $daysAgo * 86400);
        $db->exec('UPDATE user SET created_at = ? WHERE id = ?', [$createdAt, (string) $r['id']]);
        $touched++;
    }
    mt_srand(); // reseed randomly — the deterministic mt_srand above must not
                // leak into the pairing/self-play randomness below.

    return $touched;
}

/**
 * Reset the given bot ids' counters to an honest baseline before (re)computing
 * them: duck/crazyhouse/antichess always go to User's fresh defaults (no
 * backing tool exists), and the 4 standard categories + puzzle go to
 * games=0/RD=350 so a stale pre-existing counter can never survive a run even
 * if this script ends up inserting zero rows for some category (e.g. engine
 * binary missing). The real counts get set from live COUNT()s right after
 * generation below. Callers pass ONLY the ids about to be (re)generated — an
 * already-seeded bot excluded from this run must never have its counters
 * zeroed, or its profile goes empty for the ~25 minutes other bots take.
 */
function resetBotCounters(\BaseApi\Database\DB $db, array $ids): int
{
    if ($ids === []) {
        return 0;
    }
    $ph = implode(',', array_fill(0, count($ids), '?'));

    $setsBacked = [];
    foreach ([...CATEGORIES, 'puzzle'] as $cat) {
        $setsBacked[] = "games_$cat = 0";
        $setsBacked[] = "rd_$cat = " . Glicko2Service::START_RD;
        $setsBacked[] = "rated_at_$cat = NULL";
    }
    $setsUnbacked = [];
    foreach (UNBACKED_CATEGORIES as $cat) {
        $setsUnbacked[] = "rating_$cat = " . Glicko2Service::START;
        $setsUnbacked[] = "rd_$cat = " . Glicko2Service::START_RD;
        $setsUnbacked[] = "vol_$cat = " . Glicko2Service::START_VOL;
        $setsUnbacked[] = "games_$cat = 0";
        $setsUnbacked[] = "rated_at_$cat = NULL";
    }
    $sql = 'UPDATE user SET ' . implode(', ', [...$setsBacked, ...$setsUnbacked]) . " WHERE id IN ($ph)";

    return $db->exec($sql, $ids);
}

// --- Legacy-data repair: always runs first, in every mode. Re-marks any
// 'seedgame-' row that actually belongs to a bot account onto 'botgame-' so
// the two seeders' row sets are disjoint before anything else touches them.
// No-op (0 rows) once every such row has already been re-marked. -----------
$remarked = remarkLegacyBotRows($db);
if ($remarked > 0) {
    fwrite(STDOUT, "Re-marked $remarked legacy bot row(s) from 'seedgame-' onto 'botgame-'.\n");
}

// --- Delete mode ------------------------------------------------------------
if ($deleteMode) {
    [$g, $p] = clearAllSeeded($db);
    $reset = resetBotCounters($db, botIds($db));
    fwrite(STDOUT, "Deleted botgame- games ($g) and bot puzzle attempts ($p); reset counters on $reset bot(s).\n");
    exit(0);
}

// --- Load the pairing pool: bots + the existing @seed.local users, so a
// bot's opponent list isn't suspiciously all-bots ---------------------------
$cols = "id,name,role,created_at," . implode(',', array_map(static fn ($c) => "rating_$c", CATEGORIES));
$pool = $db->raw("SELECT $cols FROM user WHERE role = 'bot' OR email LIKE '%@seed.local'");
$allBots = array_values(array_filter($pool, static fn (array $r): bool => $r['role'] === 'bot'));

if (count($allBots) === 0) {
    fwrite(STDERR, "no role='bot' accounts found — run seed_bot_accounts.php first.\n");
    exit(1);
}
if (count($pool) < 2) {
    fwrite(STDERR, "need at least 2 users (bots + @seed.local) to pair games.\n");
    exit(1);
}
fwrite(STDOUT, 'Loaded ' . count($allBots) . ' bot(s) and ' . (count($pool) - count($allBots)) . " seed.local user(s).\n");

// --- Decide which bots actually need (re)generation ------------------------
// Default: only bots with no 'botgame-' history yet, so a re-run never wipes
// good history to prove it can. --force restores the old full-regen behaviour.
if ($forceMode) {
    $bots = $allBots;
    fwrite(STDOUT, "--force: regenerating ALL " . count($bots) . " bot(s).\n");
} else {
    $alreadySeeded = array_flip(seededBotIds($db));
    $bots = array_values(array_filter($allBots, static fn (array $b): bool => !isset($alreadySeeded[$b['id']])));
    fwrite(STDOUT, count($alreadySeeded) . ' bot(s) already have seeded history (untouched), '
        . count($bots) . " bot(s) need generation.\n");
}

$targetIds = array_map(static fn (array $b): string => (string) $b['id'], $bots);

// Backdating is cheap/idempotent (deterministic per bot) — always run for all
// bots regardless of which ones get fresh games this run.
$backdated = backdateBotAccounts($db, time());
fwrite(STDOUT, "Backdated created_at on $backdated bot(s).\n");

// Defaults so the summary section is well-defined even when generation is skipped.
$total = 0;
$inserted = 0;
$byResult = ['1-0' => 0, '0-1' => 0, '1/2-1/2' => 0];
$attemptsInserted = 0;

if ($bots === []) {
    fwrite(STDOUT, "Nothing to generate. Pass --force to wipe and regenerate everyone.\n");
} else {
    if (!is_file(ENGINE_BIN)) {
        fwrite(STDERR, "engine binary not found at " . ENGINE_BIN . "\n"
            . "build it first: cd gomachine && go build -o bin/gomachine ./cmd/gomachine\n");
        exit(1);
    }

    // Clear only the target bots' rows (already-seeded bots are never touched);
    // reset only the target bots' counters (an untouched bot's counters must
    // never go to zero while other bots take ~25 minutes of self-play).
    [$clearedGames, $clearedAttempts] = $forceMode ? clearAllSeeded($db) : clearSeededForIds($db, $targetIds);
    $resetCount = resetBotCounters($db, $targetIds);
    fwrite(STDOUT, "Cleared prior rows for target bot(s): games=$clearedGames attempts=$clearedAttempts. "
        . "Reset counters on $resetCount bot(s).\n");

    // Re-read the pool fresh (ratings/created_at are unaffected by the counter
    // reset above, but re-read for clarity) and re-filter $bots to the same target set.
    $cols2 = "id,name,role,created_at," . implode(',', array_map(static fn ($c) => "rating_$c", CATEGORIES));
    $pool = $db->raw("SELECT $cols2 FROM user WHERE role = 'bot' OR email LIKE '%@seed.local'");
    $targetIdSet = array_flip($targetIds);
    $bots = array_values(array_filter($pool, static fn (array $r): bool => isset($targetIdSet[$r['id']])));

    // --- Build the game specs: for every TARGET bot x every standard category,
    // pair a handful of rating-proximity opponents from the combined pool
    // (which includes every bot, seeded or not, plus @seed.local users) ----
    $specs = [];
    $meta = [];

    foreach (CATEGORIES as $cat) {
        $sorted = $pool;
        usort($sorted, static fn ($a, $b) => (int) $a["rating_$cat"] <=> (int) $b["rating_$cat"]);
        $n = count($sorted);

        $posById = [];
        foreach ($sorted as $idx => $row) {
            $posById[$row['id']] = $idx;
        }

        foreach ($bots as $bot) {
            $bIdx = $posById[$bot['id']];

            for ($k = 0; $k < $gamesPerCat; $k++) {
                $offset = 0;
                while ($offset === 0) {
                    $offset = mt_rand(-5, 5); // rating-proximity neighbours, never itself
                }
                $oIdx = max(0, min($n - 1, $bIdx + $offset));
                if ($oIdx === $bIdx) {
                    $oIdx = $bIdx === $n - 1 ? $bIdx - 1 : $bIdx + 1;
                }
                $opp = $sorted[$oIdx];
                if ($opp['id'] === $bot['id']) {
                    continue; // defensive; shouldn't happen given the above
                }

                $a = $bot;
                $b = $opp;
                if (mt_rand(0, 1) === 1) {
                    [$a, $b] = [$b, $a]; // randomise colours
                }

                $specs[] = [
                    'whiteRating' => (int) $a["rating_$cat"],
                    'blackRating' => (int) $b["rating_$cat"],
                    'maxPlies' => 160,
                ];
                $meta[] = [
                    'cat' => $cat,
                    'pool' => CATEGORY_POOLS[$cat],
                    'white' => $a,
                    'black' => $b,
                ];
            }
        }
    }

    $total = count($specs);
    if ($total === 0) {
        fwrite(STDERR, "no games to generate.\n");
        exit(1);
    }
    fwrite(STDOUT, "Generating $total games via the engine (batched, parallel)…\n");

    // --- Invoke the engine ONCE (JSON batch on stdin → JSON lines on stdout) --
    $batch = json_encode(['games' => $specs], JSON_UNESCAPED_SLASHES);
    $inFile = tempnam(sys_get_temp_dir(), 'genbothist_in_');
    $outFile = tempnam(sys_get_temp_dir(), 'genbothist_out_');
    file_put_contents($inFile, $batch);

    $cmd = escapeshellarg(ENGINE_BIN) . ' gengames '
        . '< ' . escapeshellarg($inFile) . ' > ' . escapeshellarg($outFile) . ' 2>&1';
    $t0 = microtime(true);
    exec($cmd, $_, $exitCode);
    $elapsed = microtime(true) - $t0;

    if ($exitCode !== 0) {
        fwrite(STDERR, "engine gengames failed (exit $exitCode):\n" . file_get_contents($outFile) . "\n");
        @unlink($inFile);
        @unlink($outFile);
        exit(1);
    }

    // Parse JSON-lines results, indexed by their batch position.
    $results = [];
    foreach (explode("\n", (string) file_get_contents($outFile)) as $line) {
        $line = trim($line);
        if ($line === '') {
            continue;
        }
        $r = json_decode($line, true);
        if (is_array($r) && isset($r['index'])) {
            $results[(int) $r['index']] = $r;
        }
    }
    @unlink($inFile);
    @unlink($outFile);

    fwrite(STDOUT, sprintf("Engine returned %d/%d results in %.1fs.\n", count($results), $total, $elapsed));

    // --- Persist each game as a Game row (no Elo re-application) -----------
    $now = time();
    $spanDays = 300; // games spread across up to ~300 days, floored per-pair below
    $spanSeconds = $spanDays * 24 * 3600;

    foreach ($results as $idx => $r) {
        if (!isset($meta[$idx])) {
            continue;
        }
        $m = $meta[$idx];
        $cat = $m['cat'];
        $white = $m['white'];
        $black = $m['black'];
        $result = (string) ($r['result'] ?? '1/2-1/2');
        if (!isset($byResult[$result])) {
            continue;
        }

        $wRating = (int) $white["rating_$cat"];
        $bRating = (int) $black["rating_$cat"];

        $game = new Game();
        $game->hub_game_id = BOT_GAME_PREFIX . bin2hex(random_bytes(9));
        $game->pool = $m['pool'];
        $game->category = $cat;
        $game->rated = true;                     // display only — Elo intentionally NOT applied (bots freeze)
        $game->result = $result;
        $game->reason = (string) ($r['reason'] ?? 'adjudicated');
        $game->white_uid = (string) $white['id'];
        $game->black_uid = (string) $black['id'];
        $game->white_name = (string) $white['name'];
        $game->black_name = (string) $black['name'];
        $game->white_user_id = (string) $white['id'];  // set from the start — no NULL white_user_id
        $game->black_user_id = (string) $black['id'];
        $game->white_is_bot = $white['role'] === 'bot';
        $game->black_is_bot = $black['role'] === 'bot';
        // Ratings frozen: before == after (bots never take Elo).
        $game->white_rating_before = $wRating;
        $game->white_rating_after = $wRating;
        $game->black_rating_before = $bRating;
        $game->black_rating_after = $bRating;
        $game->setMoves(array_map('strval', (array) ($r['moves'] ?? [])));
        $game->setSans([]); // SAN not produced by gengames; history/record don't need it
        $game->ply = (int) ($r['ply'] ?? count($game->getMoves()));

        if (!$game->save()) {
            fwrite(STDERR, "failed to save game index $idx\n");
            continue;
        }

        // created_at: spread over up to ~300 days, clamped to >= both players'
        // created_at (insert skips created_at, so set it with a parameterised
        // UPDATE — DML, not DDL — exactly like seed_games.php does).
        $floor = max(
            strtotime((string) $white['created_at']) ?: $now,
            strtotime((string) $black['created_at']) ?: $now,
        );
        $ts = max($floor, $now - mt_rand(0, $spanSeconds));
        $createdAt = date('Y-m-d H:i:s', $ts);
        $db->exec('UPDATE game SET created_at = ? WHERE id = ?', [$createdAt, $game->id]);

        $inserted++;
        $byResult[$result]++;
    }

    // --- Seed puzzle attempts for TARGET bots only (so PUZZLES wins aren't 0) -
    // A handful of distinct-puzzle attempts per bot, ~65% solved — same approach
    // as seed_games.php. rating_before == rating_after (puzzle Elo intentionally
    // NOT applied for bots). Distinct puzzle ids per bot satisfy the unique
    // (user_id, puzzle_id) index. Scoped to $targetIds so an already-seeded
    // bot never gets extra attempts appended on top of its existing history.
    $puzzlePool = array_map(
        static fn (array $r): string => (string) $r['id'],
        $db->raw('SELECT id FROM puzzle LIMIT 5000'),
    );
    if ($puzzlePool === []) {
        fwrite(STDOUT, "No puzzles in the DB — skipping puzzle-attempt seeding.\n");
    } else {
        $poolN = count($puzzlePool);
        // Re-read target bots' rating_puzzle + created_at fresh (rating_puzzle is
        // untouched by resetBotCounters; created_at is the backdated value).
        $ph = implode(',', array_fill(0, count($targetIds), '?'));
        $puzzleBots = $db->raw(
            "SELECT id, created_at, rating_puzzle FROM user WHERE role = 'bot' AND id IN ($ph)",
            $targetIds,
        );
        foreach ($puzzleBots as $u) {
            $howMany = mt_rand(4, 12);
            $picks = (array) array_rand($puzzlePool, min($howMany, $poolN));
            $pr = (int) $u['rating_puzzle'];
            $floor = strtotime((string) $u['created_at']) ?: $now;
            foreach ($picks as $pi) {
                $solved = mt_rand(1, 100) <= 65;
                $ts = max($floor, $now - mt_rand(0, $spanSeconds));
                $ok = $db->exec(
                    'INSERT INTO puzzle_attempt (id, user_id, puzzle_id, solved, rating_before, rating_after, created_at, updated_at) '
                    . 'VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
                    [
                        bin2hex(random_bytes(16)),
                        (string) $u['id'],
                        $puzzlePool[$pi],
                        $solved ? 1 : 0,
                        $pr,
                        $pr,
                        date('Y-m-d H:i:s', $ts),
                        date('Y-m-d H:i:s'),
                    ],
                );
                $attemptsInserted += $ok;
            }
        }
    }
}

// --- Reconcile every counter from the real rows now present ----------------
// This is the actual fix: games_<cat> is SET FROM a live COUNT(), never
// claimed independently of what's in `game`/`puzzle_attempt`. Also derives a
// non-provisional-looking RD only when the real count warrants it — low
// counts stay honestly provisional (RD > 110), which is normal for a player
// with only a handful of rated games, not a contradiction.
$allBots = $db->raw("SELECT id FROM user WHERE role = 'bot'");
$reconciled = 0;
foreach ($allBots as $row) {
    $id = (string) $row['id'];
    foreach (CATEGORIES as $cat) {
        $n = (int) $db->scalar(
            'SELECT COUNT(*) FROM game WHERE category = ? AND (white_user_id = ? OR black_user_id = ?)',
            [$cat, $id, $id],
        );
        // Same RD-from-games-played curve seed_bot_accounts.php/seed_leaderboard_users.php
        // use elsewhere, but anchored on the REAL count and never below Glicko2's
        // START_RD-derived ceiling — a handful of games stays provisional, which is honest.
        $rd = max(45.0, min(Glicko2Service::START_RD, 85.0 - ($n / 400.0) * 40.0));
        $ratedAt = $n > 0 ? date('Y-m-d H:i:s') : null;
        $db->exec(
            "UPDATE user SET games_$cat = ?, rd_$cat = ?, rated_at_$cat = ? WHERE id = ?",
            [$n, round($rd, 4), $ratedAt, $id],
        );
    }

    $puzzleN = (int) $db->scalar('SELECT COUNT(*) FROM puzzle_attempt WHERE user_id = ?', [$id]);
    $rdP = max(45.0, min(Glicko2Service::START_RD, 85.0 - ($puzzleN / 400.0) * 40.0));
    $ratedAtP = $puzzleN > 0 ? date('Y-m-d H:i:s') : null;
    $db->exec(
        'UPDATE user SET games_puzzle = ?, rd_puzzle = ?, rated_at_puzzle = ? WHERE id = ?',
        [$puzzleN, round($rdP, 4), $ratedAtP, $id],
    );
    $reconciled++;
}

// --- Summary --------------------------------------------------------------
fwrite(STDOUT, "\n=== Summary ===\n");
fwrite(STDOUT, "Games generated: $total\n");
fwrite(STDOUT, "Games inserted:  $inserted\n");
fwrite(STDOUT, sprintf(
    "Result breakdown: 1-0 %d | 0-1 %d | 1/2-1/2 %d\n",
    $byResult['1-0'],
    $byResult['0-1'],
    $byResult['1/2-1/2'],
));
fwrite(STDOUT, "Puzzle attempts inserted: $attemptsInserted\n");
fwrite(STDOUT, "Bots reconciled (games_<cat>/rd_<cat> set from real rows): $reconciled\n\n");

// Sample a few of the bots this run actually (re)generated, at different
// rating tiers. Nothing to sample when generation was skipped entirely.
if ($bots === []) {
    fwrite(STDOUT, "(no bots generated this run — nothing to sample)\n");
    fwrite(STDOUT, "\nDone.\n");
    exit(0);
}
usort($bots, static fn ($a, $b) => (int) $a['rating_bullet'] <=> (int) $b['rating_bullet']);
$sample = array_values(array_unique(array_merge(
    array_slice($bots, 0, 2),
    array_slice($bots, (int) (count($bots) / 2), 2),
    array_slice($bots, -2),
), SORT_REGULAR));
foreach ($sample as $b) {
    $id = (string) $b['id'];
    $w = (int) $db->scalar('SELECT COUNT(*) FROM game WHERE (white_user_id = ? AND result = ?) OR (black_user_id = ? AND result = ?)', [$id, '1-0', $id, '0-1']);
    $l = (int) $db->scalar('SELECT COUNT(*) FROM game WHERE (white_user_id = ? AND result = ?) OR (black_user_id = ? AND result = ?)', [$id, '0-1', $id, '1-0']);
    $d = (int) $db->scalar('SELECT COUNT(*) FROM game WHERE (white_user_id = ? OR black_user_id = ?) AND result = ?', [$id, $id, '1/2-1/2']);
    $ps = (int) $db->scalar('SELECT COUNT(*) FROM puzzle_attempt WHERE user_id = ? AND solved = 1', [$id]);
    $pt = (int) $db->scalar('SELECT COUNT(*) FROM puzzle_attempt WHERE user_id = ?', [$id]);
    fwrite(STDOUT, sprintf(
        "  %-24s bullet:%-4d  W:%d L:%d D:%d (total %d)  puzzle:%d/%d\n",
        (string) $b['name'],
        (int) $b['rating_bullet'],
        $w,
        $l,
        $d,
        $w + $l + $d,
        $ps,
        $pt,
    ));
}
fwrite(STDOUT, "\nDone.\n");
