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
 * all-bots), self-play in per-bot-chunk `gomachine gengames` invocations (see
 * the 2026-07-31 incident note below for why it's chunked, not one shot),
 * persist Game rows with ratings frozen (white/black_rating_before ==
 * _after — bots never take Elo), white_user_id/black_user_id set from the
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
 * --- 2026-07-31 PRODUCTION INCIDENT: chunking + reconnect + ordering fix ---
 * The old version generated ALL bots' games in ONE `gomachine gengames`
 * batch (4800 games), which blocked PHP in a single `exec()` call for 3.4
 * hours, opened the DB connection at startup, and only started inserting
 * once the whole batch came back. By then MySQL's wait_timeout had long
 * since closed the idle connection: the very first `Game::save()` fatalled
 * with "MySQL server has gone away" and ALL 4800 generated games were lost.
 * Worse, the "clear prior rows + reset counters" step had already run for
 * every target bot BEFORE generation started, so the crash left those bots
 * at zero games/zero counters — strictly worse than their pre-run state.
 * Three fixes, all below:
 *   1. RECONNECT (ensureLiveConnection()) — BaseApi\Database\Connection has
 *      no public reconnect/ping; its PDO is a private property created
 *      lazily only when null. Reflection is the least-hacky way to reach it
 *      without patching the framework: null the private $pdo so the very
 *      next Connection::pdo() call reconnects. Since DB::raw/scalar/exec,
 *      QueryBuilder, and BaseModel::save() all resolve App::db() fresh, this
 *      one reset reaches every write path. Called right after every chunk's
 *      engine call returns — the exact point where a long-idle connection
 *      would otherwise be used for the first time.
 *   2. CHUNKING — bots are processed in fixed-size groups (see
 *      GAMES_PER_CHUNK_TARGET / --chunk-bots below): generate a chunk's
 *      worth of games, persist them, print progress, move on. A crash costs
 *      one chunk's generation time, not the whole run, and the DB is never
 *      held idle for more than one chunk's engine call.
 *   3. DESTRUCTIVE ORDERING — clearSeededForIds() for a bot's OLD rows now
 *      runs INSIDE the same transaction as inserting its NEW rows
 *      (persistChunk()), which only begins after that chunk's engine call
 *      has already returned real results. A bot's history is only ever
 *      replaced together, atomically, once its replacement is in hand —
 *      never cleared up front on the hope that generation will succeed.
 * RESUMABILITY: unchanged in spirit from the existing skip-if-seeded logic,
 * but now correct at chunk granularity. Because a chunk always covers EVERY
 * category for its bots and clear+insert+reconcile commit together in one
 * transaction, a bot is either fully seeded (all 4 categories + puzzle rows
 * committed) or not seeded at all (0 'botgame-' rows) — there is no partial
 * state for seededBotIds() to misjudge. Re-running the plain script after a
 * crash regenerates only the chunks (bots) that never committed; already-
 * committed bots are untouched. Finer-than-bot granularity (e.g. per
 * category) was considered and rejected: specs are built category-major
 * (all bots x bullet, then all bots x blitz, ...), so persisting
 * category-by-category would let a crash leave a bot with, say, bullet rows
 * but no blitz rows — and the existing "has ANY botgame- row" seeded check
 * would then skip it forever, permanently missing categories. Whole-bot
 * chunks avoid that failure mode entirely.
 *
 * --- ENGINE-RATING COMPRESSION (2026-07-31): decouple play strength from the
 * stored rating ---
 * `gomachine gengames` maps a rating to an engine level via the hub's own
 * `ratingForLevel = 600 + 180*level` (capped at level 8), and per-move cost is
 * flat up to about level 3 (~600-1200) then rises steeply — measured on prod
 * (60 games/point, maxPlies 160, 4 cores): 1000->0.175s/game, 1200->0.347s/game,
 * 1600->2.26s/game, 2000->3.32s/game. The 1200->1600 jump (level 3->6) is
 * 6.5x. Our bot pool spans roughly 900-2400, so most of a seeding run's wall
 * clock was the expensive top of that curve — 4800 games took 3.4h on prod.
 *
 * Nobody inspects these move lists; they exist only so a profile has a
 * plausible-looking record. A "2400-rated" bot does not need to actually PLAY
 * 2400-strength chess — it only needs to beat lower-rated bots more often than
 * it loses, so a profile's win/loss pattern still correlates with the ratings
 * shown on it. So: the rating fed to `gengames` (and therefore the engine
 * LEVEL/strength) is compressed into the cheap flat part of the curve
 * (ENGINE_RATING_FLOOR..ENGINE_RATING_CEIL, default 600..1200 == levels 0..3,
 * a ~540 Elo spread — plenty of separation for win-rate correlation) via a
 * simple linear rescale of each bot's REAL rating within the pool's
 * observed min/max, per category. This value is used ONLY to build the
 * `gengames` spec (engine.BestMove's difficulty knob) — it is NEVER written
 * anywhere. The `Game` rows persisted afterward (persistChunk()) always use
 * each bot's REAL `rating_$cat` for white/black_rating_before/after, exactly
 * as before this change: stored ratings are real, only the ENGINE'S PLAYING
 * STRENGTH for self-play is deliberately weakened for generation speed. See
 * compressRatingForEngine() below. Ordering is preserved (a higher real
 * rating always compresses to a >= engine rating), so a level-3-vs-level-0
 * pairing (real 2400 vs real 900, say) still lets the stronger engine win
 * more often — verified empirically (see the script's own commit/PR notes).
 *
 * Tunable/escapable: `--no-compress` reverts to feeding gengames the REAL
 * rating (the old, slow-but-literal behaviour) for comparison or if the
 * compression ever needs to be disabled; ENGINE_RATING_FLOOR/CEIL below are
 * the tunable knobs for HOW compressed the fast range is.
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
 *     full wipe-and-regenerate for EVERY bot (the old always-clear behaviour;
 *     now performed chunk-by-chunk, so a bot's old history is only replaced
 *     once its new history exists — see the incident note above).
 *   php scripts/seed_bot_history.php --delete
 *     remove all 'botgame-' rows + bot puzzle attempts, reset counters.
 *   --limit=N
 *     cap this run to the first N target bots (after --force/seeded
 *     filtering). For testing a change on a couple of accounts before
 *     committing to the full bot roster.
 *   --chunk-bots=N
 *     override the auto-computed chunk size (bots processed — and
 *     persisted — per engine invocation). Auto default targets roughly
 *     GAMES_PER_CHUNK_TARGET games per chunk, scaled by gamesPerCat.
 *   --no-compress
 *     feed gengames each bot's REAL rating instead of the compressed
 *     ENGINE_RATING_FLOOR..CEIL engine-strength rating (see "ENGINE-RATING
 *     COMPRESSION" above). Slower (the whole point of compression is
 *     avoiding this), useful only for comparison/debugging. Stored
 *     ratings on the Game rows are unaffected either way — always real.
 */

use BaseApi\App;
use BaseApi\Database\DB;
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

// Target games per chunk (see incident note above) — chunk size in BOTS is
// derived from this divided by games-per-bot-per-run, floored to [1, 50] so
// a huge --limit run still prints progress reasonably often and a tiny
// gamesPerCat doesn't produce an unwieldy single mega-chunk.
const GAMES_PER_CHUNK_TARGET = 300;

// Engine-strength compression range (see "ENGINE-RATING COMPRESSION" in the
// docblock above): the rating fed to `gengames` for self-play is rescaled
// into this band before generation, which the hub's levelForSeedRating
// (600 + 180*level) puts at levels 0..3 — the flat, cheap part of the
// measured per-game-cost curve. Tune these two constants to widen/narrow the
// fast band; --no-compress bypasses this entirely.
const ENGINE_RATING_FLOOR = 600;  // level 0 — hub's own floor, cheapest
const ENGINE_RATING_CEIL = 1200;  // level 3 — (1200-600)/180 = 3.33 rounds to 3, still on the cheap flat part

$db = App::db();

// --- CLI args -------------------------------------------------------------
$argvRest = array_slice($argv, 1);
$deleteMode = in_array('--delete', $argvRest, true);
$forceMode = in_array('--force', $argvRest, true);
$noCompress = in_array('--no-compress', $argvRest, true);
$gamesPerCat = 8;
$limit = null;
$chunkBotsOverride = null;
foreach ($argvRest as $a) {
    if (ctype_digit($a)) {
        $gamesPerCat = max(1, (int) $a);
    } elseif (preg_match('/^--limit=(\d+)$/', $a, $m) === 1) {
        $limit = max(1, (int) $m[1]);
    } elseif (preg_match('/^--chunk-bots=(\d+)$/', $a, $m) === 1) {
        $chunkBotsOverride = max(1, (int) $m[1]);
    }
}

/**
 * Rescale a bot's REAL rating into the cheap engine-strength band
 * [ENGINE_RATING_FLOOR, ENGINE_RATING_CEIL] for feeding to `gengames` —
 * linear within the pool's observed [$poolMin, $poolMax] for this category,
 * so ordering is preserved (a higher real rating never compresses below a
 * lower one's engine rating). Used ONLY to pick the self-play engine's
 * difficulty; never written to a Game row (those always use the real
 * rating — see persistChunk()). Returns the real rating unchanged when
 * compression is disabled (--no-compress).
 */
function compressRatingForEngine(int $realRating, float $poolMin, float $poolMax, bool $enabled): int
{
    if (!$enabled) {
        return $realRating;
    }
    if ($poolMax <= $poolMin) {
        return ENGINE_RATING_FLOOR;
    }
    $t = ($realRating - $poolMin) / ($poolMax - $poolMin);
    $t = max(0.0, min(1.0, $t));

    return (int) round(ENGINE_RATING_FLOOR + $t * (ENGINE_RATING_CEIL - ENGINE_RATING_FLOOR));
}

/** Ids of every role='bot' account. */
function botIds(DB $db): array
{
    $rows = $db->raw("SELECT id FROM user WHERE role = 'bot'");
    return array_map(static fn (array $r): string => (string) $r['id'], $rows);
}

/**
 * Ids of role='bot' accounts that already have at least one 'botgame-' row
 * (as either side) — i.e. already seeded by this script. Used to skip
 * regeneration for them by default.
 */
function seededBotIds(DB $db): array
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
function remarkLegacyBotRows(DB $db): int
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
 *  owned by a CURRENT bot account. Used ONLY by --delete (an explicit, one-shot
 *  destructive operation the user asked for directly — not part of the
 *  generate flow, which never wipes before a replacement is in hand). */
function clearAllSeeded(DB $db): array
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
 *  bot ids. Called from inside persistChunk()'s transaction, AFTER that chunk's
 *  replacement games already exist in memory (engine call succeeded) — so a
 *  bot's old rows and new rows are removed/inserted atomically together. Never
 *  called up front for bots that haven't generated yet. */
function clearSeededForIds(DB $db, array $ids): array
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
function backdateBotAccounts(DB $db, int $now): int
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
 * Reset ONLY the unbacked categories (duck/crazyhouse/antichess) to User's
 * fresh defaults. Always safe to run regardless of generation outcome — these
 * are never populated by this script (see docblock), so there is no
 * "replacement" for a crash to race against. Called from inside
 * persistChunk()'s transaction so an untouched (not-yet-processed) bot's
 * unbacked categories are never reset ahead of its actual turn.
 */
function resetUnbackedCounters(DB $db, array $ids): int
{
    if ($ids === []) {
        return 0;
    }
    $ph = implode(',', array_fill(0, count($ids), '?'));
    $sets = [];
    foreach (UNBACKED_CATEGORIES as $cat) {
        $sets[] = "rating_$cat = " . Glicko2Service::START;
        $sets[] = "rd_$cat = " . Glicko2Service::START_RD;
        $sets[] = "vol_$cat = " . Glicko2Service::START_VOL;
        $sets[] = "games_$cat = 0";
        $sets[] = "rated_at_$cat = NULL";
    }

    return $db->exec('UPDATE user SET ' . implode(', ', $sets) . " WHERE id IN ($ph)", $ids);
}

/**
 * Full counter reset (all 4 standard categories + puzzle to 0/START_RD/NULL,
 * plus the unbacked categories to fresh defaults). Used ONLY by --delete
 * mode, where all rows have already been deleted, so zeroing counters is
 * simply catching them up to a truth that's already on disk — not a
 * pre-generation guess that a crash could strand.
 */
function resetBotCounters(DB $db, array $ids): int
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

/**
 * Recompute games_<cat>/rd_<cat>/rated_at_<cat> (+ puzzle) for exactly the
 * given user ids from a live COUNT() over `game`/`puzzle_attempt` — the
 * actual source of truth. Called both per-chunk (so progress is visible in
 * the DB immediately, not just at the very end) and once more at the end of
 * the script over every bot (cheap self-heal safety net). Never blind-zeros:
 * it only ever sets a counter to what's really on disk, so it's safe to call
 * at any time, including on bots this run didn't touch.
 */
function reconcileCountersForIds(DB $db, array $ids): int
{
    $reconciled = 0;
    foreach ($ids as $id) {
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

    return $reconciled;
}

/**
 * Verify the DB connection survived the last engine call. A long `exec()`
 * blocks PHP with no queries in flight, which is exactly how MySQL's
 * wait_timeout silently closes an idle connection — the root cause of the
 * 2026-07-31 "server has gone away" crash (3.4h idle, then the first write
 * fatalled and every generated game was lost). If the connection is dead,
 * force a reconnect.
 *
 * BaseApi\Database\Connection (vendor/baseapi/baseapi/src/Database/
 * Connection.php) has no public reconnect/ping method — its PDO is a
 * private property, created lazily only when null (see pdo()/connect()).
 * Reflection is the least-hacky way to reach it without patching the
 * framework: nulling the private $pdo makes the VERY NEXT call into
 * Connection::pdo() reconnect. Because DB::raw()/scalar()/exec(),
 * QueryBuilder, and BaseModel::save() all resolve App::db() fresh and then
 * call $connection->pdo() themselves, this one reset reaches every write
 * path in the script — not just calls made directly through $db here.
 */
function ensureLiveConnection(DB $db): void
{
    try {
        $db->scalar('SELECT 1');
        return; // still alive — nothing to do
    } catch (\Throwable) {
        // falls through to reconnect below
    }

    $conn = $db->getConnection();
    $prop = new ReflectionProperty($conn, 'pdo');
    $prop->setValue($conn, null);

    // Prove the reconnect actually works rather than assuming it — this
    // throws right here (loud, before any write) if it doesn't.
    $db->scalar('SELECT 1');
    fwrite(STDOUT, "  (DB connection had gone away — reconnected.)\n");
}

/**
 * Persist one chunk's already-generated results atomically: clear this
 * chunk's bots' OLD 'botgame-' rows, insert their NEW games + puzzle
 * attempts, reset their unbacked-category counters, and reconcile their
 * real counters from a live COUNT — all in ONE transaction. A bot's history
 * is only ever removed together with its replacement being written in the
 * same commit; if anything in here throws, the rollback means that bot's
 * OLD rows (if any) are exactly as they were before this chunk started.
 *
 * Retries once after a forced reconnect if the write itself hits a dead
 * connection (this chunk's own engine call could itself have been long
 * enough to idle the connection out). If the retry also fails, the chunk's
 * bots are left with whatever they had before (nothing partially written)
 * and will be picked up by seededBotIds() on the next run.
 */
function persistChunk(
    DB $db,
    array $chunkIds,
    array $results,
    array $meta,
    int $now,
    int $spanSeconds,
    array $puzzlePool,
): array {
    $attempt = 0;
    while (true) {
        $attempt++;
        $conn = $db->getConnection();
        try {
            $conn->beginTransaction();

            [$clearedGames, $clearedAttempts] = clearSeededForIds($db, $chunkIds);

            $inserted = 0;
            $byResult = ['1-0' => 0, '0-1' => 0, '1/2-1/2' => 0];
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
                    throw new RuntimeException("failed to save game index $idx");
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

            // --- Seed puzzle attempts for this chunk's bots only -----------
            $attemptsInserted = 0;
            if ($puzzlePool !== []) {
                $poolN = count($puzzlePool);
                $ph = implode(',', array_fill(0, count($chunkIds), '?'));
                $puzzleBots = $db->raw(
                    "SELECT id, created_at, rating_puzzle FROM user WHERE role = 'bot' AND id IN ($ph)",
                    $chunkIds,
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

            resetUnbackedCounters($db, $chunkIds);
            reconcileCountersForIds($db, $chunkIds);

            $conn->commit();

            return [
                'ok' => true,
                'inserted' => $inserted,
                'byResult' => $byResult,
                'attemptsInserted' => $attemptsInserted,
                'clearedGames' => $clearedGames,
                'clearedAttempts' => $clearedAttempts,
                'attempt' => $attempt,
            ];
        } catch (\Throwable $e) {
            try {
                if ($conn->pdo()->inTransaction()) {
                    $conn->rollback();
                }
            } catch (\Throwable) {
                // Connection may already be dead — nothing to roll back over the
                // wire, and since we never committed, no partial data landed.
            }

            if ($attempt >= 2) {
                fwrite(STDERR, "  chunk failed after $attempt attempt(s): " . $e->getMessage() . "\n");

                return [
                    'ok' => false,
                    'inserted' => 0,
                    'byResult' => ['1-0' => 0, '0-1' => 0, '1/2-1/2' => 0],
                    'attemptsInserted' => 0,
                    'clearedGames' => 0,
                    'clearedAttempts' => 0,
                    'attempt' => $attempt,
                ];
            }

            fwrite(STDOUT, '  write failed (' . $e->getMessage() . ") — reconnecting and retrying this chunk once…\n");
            ensureLiveConnection($db);
        }
    }
}

/** Build {specs, meta} for exactly the given bots, across all 4 standard
 *  categories, using a precomputed rating-sorted pool per category. Mirrors
 *  scripts/seed_games.php's rating-proximity pairing. The `whiteRating`/
 *  `blackRating` sent to gengames are the ENGINE-STRENGTH (possibly
 *  compressed, see compressRatingForEngine()) values — $meta['white']/
 *  ['black'] keep the full original user row (real rating_$cat included) so
 *  persistChunk() always stores the real rating regardless of compression. */
function buildSpecsForBots(
    array $chunkBots,
    array $sortedByCat,
    int $gamesPerCat,
    bool $compressionEnabled,
): array {
    $specs = [];
    $meta = [];

    foreach (CATEGORIES as $cat) {
        $sorted = $sortedByCat[$cat]['sorted'];
        $posById = $sortedByCat[$cat]['posById'];
        $poolMin = $sortedByCat[$cat]['min'];
        $poolMax = $sortedByCat[$cat]['max'];
        $n = count($sorted);

        foreach ($chunkBots as $bot) {
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
                    'whiteRating' => compressRatingForEngine((int) $a["rating_$cat"], $poolMin, $poolMax, $compressionEnabled),
                    'blackRating' => compressRatingForEngine((int) $b["rating_$cat"], $poolMin, $poolMax, $compressionEnabled),
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

    return [$specs, $meta];
}

/** Invoke `gomachine gengames` once for the given specs; returns
 *  [resultsByIndex, elapsedSeconds]. */
function invokeEngine(array $specs): array
{
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
        $err = file_get_contents($outFile);
        @unlink($inFile);
        @unlink($outFile);
        throw new RuntimeException("engine gengames failed (exit $exitCode): $err");
    }

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

    return [$results, $elapsed];
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
$pool = $db->raw("SELECT $cols FROM user WHERE role = 'bot' OR email LIKE '%@seed.local' ORDER BY id");
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
// good history to prove it can. --force restores the old full-regen behaviour
// (now performed chunk-by-chunk — see the incident note in the docblock).
if ($forceMode) {
    $bots = $allBots;
    fwrite(STDOUT, "--force: regenerating ALL " . count($bots) . " bot(s).\n");
} else {
    $alreadySeeded = array_flip(seededBotIds($db));
    $bots = array_values(array_filter($allBots, static fn (array $b): bool => !isset($alreadySeeded[$b['id']])));
    fwrite(STDOUT, count($alreadySeeded) . ' bot(s) already have seeded history (untouched), '
        . count($bots) . " bot(s) need generation.\n");
}

if ($limit !== null && count($bots) > $limit) {
    fwrite(STDOUT, "--limit=$limit: capping this run to the first $limit of " . count($bots) . " target bot(s).\n");
    $bots = array_slice($bots, 0, $limit);
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

    // Precompute each category's rating-sorted pool ONCE — ratings don't
    // change while this script runs (bots never take Elo), so every chunk
    // can reuse the same sort instead of re-sorting per chunk.
    $sortedByCat = [];
    foreach (CATEGORIES as $cat) {
        $sorted = $pool;
        usort($sorted, static fn ($a, $b) => (int) $a["rating_$cat"] <=> (int) $b["rating_$cat"]);
        $posById = [];
        foreach ($sorted as $idx => $row) {
            $posById[$row['id']] = $idx;
        }
        $sortedByCat[$cat] = [
            'sorted' => $sorted,
            'posById' => $posById,
            // Pool-wide min/max for this category — the domain compressRatingForEngine()
            // rescales from. Computed once here (ratings frozen for the whole run).
            'min' => (float) ($sorted === [] ? 0 : $sorted[0]["rating_$cat"]),
            'max' => (float) ($sorted === [] ? 0 : $sorted[count($sorted) - 1]["rating_$cat"]),
        ];
    }
    fwrite(STDOUT, $noCompress
        ? "Engine-rating compression: DISABLED (--no-compress) — gengames plays each bot's real rating.\n"
        : sprintf(
            "Engine-rating compression: ENABLED — self-play strength rescaled into [%d,%d] (levels 0-3); stored ratings stay real.\n",
            ENGINE_RATING_FLOOR,
            ENGINE_RATING_CEIL,
        ));

    $puzzlePool = array_map(
        static fn (array $r): string => (string) $r['id'],
        $db->raw('SELECT id FROM puzzle LIMIT 5000'),
    );
    if ($puzzlePool === []) {
        fwrite(STDOUT, "No puzzles in the DB — puzzle-attempt seeding will be skipped for every chunk.\n");
    }

    $specsPerBot = $gamesPerCat * count(CATEGORIES);
    $botsPerChunk = $chunkBotsOverride
        ?? max(1, min(50, (int) floor(GAMES_PER_CHUNK_TARGET / max(1, $specsPerBot))));
    fwrite(STDOUT, "Chunk size: $botsPerChunk bot(s)/chunk (~" . ($botsPerChunk * $specsPerBot) . " games/chunk).\n");

    $now = time();
    $spanDays = 300; // games spread across up to ~300 days, floored per-pair below
    $spanSeconds = $spanDays * 24 * 3600;

    $chunks = array_chunk($bots, $botsPerChunk);
    $numChunks = count($chunks);
    $failedChunks = 0;

    foreach ($chunks as $chunkIdx => $chunkBots) {
        $chunkNum = $chunkIdx + 1;
        $chunkIds = array_map(static fn (array $b): string => (string) $b['id'], $chunkBots);

        [$specs, $meta] = buildSpecsForBots($chunkBots, $sortedByCat, $gamesPerCat, !$noCompress);
        $chunkTotal = count($specs);
        $total += $chunkTotal;

        if ($chunkTotal === 0) {
            continue;
        }

        fwrite(STDOUT, sprintf(
            "\n[chunk %d/%d] %d bot(s), %d games — invoking engine…\n",
            $chunkNum,
            $numChunks,
            count($chunkBots),
            $chunkTotal,
        ));

        try {
            [$results, $elapsed] = invokeEngine($specs);
        } catch (RuntimeException $e) {
            fwrite(STDERR, "[chunk $chunkNum/$numChunks] " . $e->getMessage() . "\n");
            $failedChunks++;
            continue;
        }
        fwrite(STDOUT, sprintf(
            "[chunk %d/%d] engine returned %d/%d results in %.1fs.\n",
            $chunkNum,
            $numChunks,
            count($results),
            $chunkTotal,
            $elapsed,
        ));

        // Test-only hook: deliberately kill THIS process's own MySQL
        // connection right here — after a (possibly long) engine call,
        // immediately before the write step — to prove ensureLiveConnection()
        // actually recovers rather than assuming it does. Mirrors exactly
        // where the 2026-07-31 crash happened. Never fires without the env
        // var explicitly set; safe to leave in permanently for re-verifying
        // the reconnect path after any future framework upgrade.
        if ($chunkNum === 1 && getenv('SEED_BOT_HISTORY_TEST_KILL_CONN') === '1') {
            $cid = $db->scalar('SELECT CONNECTION_ID()');
            fwrite(STDOUT, "  [TEST] killing own connection id=$cid to simulate a gone-away MySQL link…\n");
            try {
                $db->exec('KILL ' . (int) $cid);
            } catch (\Throwable $e) {
                fwrite(STDOUT, '  [TEST] KILL threw as expected (connection died mid-response): ' . $e->getMessage() . "\n");
            }
        }

        // The connection may have gone idle/stale during that engine call —
        // verify and, if needed, reconnect BEFORE writing. This is the actual
        // fix for the "server has gone away" crash.
        ensureLiveConnection($db);

        $res = persistChunk($db, $chunkIds, $results, $meta, $now, $spanSeconds, $puzzlePool);
        if ($res['ok']) {
            $inserted += $res['inserted'];
            $attemptsInserted += $res['attemptsInserted'];
            foreach ($byResult as $k => $_) {
                $byResult[$k] += $res['byResult'][$k];
            }
            fwrite(STDOUT, sprintf(
                "[chunk %d/%d] persisted: games=%d (1-0:%d 0-1:%d 1/2:%d) puzzle_attempts=%d"
                . " cleared(games=%d,attempts=%d)%s\n",
                $chunkNum,
                $numChunks,
                $res['inserted'],
                $res['byResult']['1-0'],
                $res['byResult']['0-1'],
                $res['byResult']['1/2-1/2'],
                $res['attemptsInserted'],
                $res['clearedGames'],
                $res['clearedAttempts'],
                $res['attempt'] > 1 ? ' [succeeded on attempt ' . $res['attempt'] . ']' : '',
            ));
        } else {
            $failedChunks++;
            fwrite(STDOUT, "[chunk $chunkNum/$numChunks] FAILED — its bot(s) are untouched and will be "
                . "retried on the next run (nothing partially written; seededBotIds() will pick them up again).\n");
        }
    }

    if ($failedChunks > 0) {
        fwrite(STDOUT, "\n$failedChunks/$numChunks chunk(s) failed. Re-run the script (same args) to retry "
            . "only the missing bots.\n");
    }
}

// --- Final self-heal reconciliation over EVERY bot -------------------------
// Cheap, idempotent, and never destructive (it only ever SETS a counter to a
// live COUNT() over rows already on disk) — a safety net beyond the
// per-chunk reconciliation above, covering any bot untouched by this run.
$reconciled = reconcileCountersForIds($db, botIds($db));

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

// Sample a few of the bots this run targeted, at different rating tiers.
// Nothing to sample when generation was skipped entirely.
if ($bots === []) {
    fwrite(STDOUT, "(no bots targeted this run — nothing to sample)\n");
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
