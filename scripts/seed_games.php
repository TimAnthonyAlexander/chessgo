<?php

declare(strict_types=1);

/**
 * Seed the LOCAL dev `game` + `puzzle_attempt` tables with realistic HISTORY for
 * the fake @seed.local users created by seed_leaderboard_users.php, so their
 * profiles show real GAMES / WINS / LOSSES / DRAWS and non-zero PUZZLE wins
 * instead of all zeros.
 *
 * The heavy lifting (self-playing the games) is done by the Go engine in ONE
 * batched, parallel invocation of `gomachine gengames` — NOT a per-game PHP loop.
 * This script only: pairs similar-rated seed users into games, feeds the batch to
 * the engine, and persists the returned results as `Game` rows (bypassing the Elo
 * update in GameResultController — ratings are already seeded and must not move).
 *
 * LOCAL DEV ONLY. Seeded games are marked by a `hub_game_id` prefix
 * (seedgame-…) so they're trivially removable; seeded puzzle attempts belong to
 * @seed.local users (who have no other attempts). Re-running clears-then-inserts,
 * so it's idempotent.
 *
 * Profile stat sources (verified in ProfileController):
 *   - GAMES/WINS/LOSSES/DRAWS: live COUNT over `game` rows by white/black_user_id
 *     + `result` — so inserting rows with the users' ids is sufficient (no counter).
 *   - PUZZLES wins: live COUNT over `puzzle_attempt` where solved=1 — so we insert
 *     a handful of solved/failed attempts per user.
 *   - Per-category "N games" tiles: the `games_<cat>` COUNTER on `user` (already
 *     seeded, left untouched — the owner wants only "a few" real games here).
 *
 * Usage:
 *   php scripts/seed_games.php [gamesPerUser]     # default 10
 *   php scripts/seed_games.php --delete           # remove all seeded games + attempts
 */

use BaseApi\App;
use App\Models\Game;

require_once __DIR__ . '/../vendor/autoload.php';

App::boot(dirname(__DIR__));

const SEED_DOMAIN = 'seed.local';
const SEED_GAME_PREFIX = 'seedgame-';
const ENGINE_BIN = __DIR__ . '/../gomachine/bin/gomachine';

// Representative pool per category (categoryForPool maps these back to the category).
const CATEGORY_POOLS = [
    'bullet' => '1+0',
    'blitz' => '3+0',
    'rapid' => '10+0',
    'classical' => '30+0',
];
const CATEGORIES = ['bullet', 'blitz', 'rapid', 'classical'];

$db = App::db();

// --- CLI args -------------------------------------------------------------
$argvRest = array_slice($argv, 1);
$deleteMode = in_array('--delete', $argvRest, true);
$gamesPerUser = 10;
foreach ($argvRest as $a) {
    if (ctype_digit($a)) {
        $gamesPerUser = max(1, (int) $a);
    }
}

/** Ids of every @seed.local user. */
function seedUserIds(\BaseApi\Database\DB $db): array
{
    $rows = $db->raw('SELECT id FROM user WHERE email LIKE ?', ['%@' . SEED_DOMAIN]);
    return array_map(static fn (array $r): string => (string) $r['id'], $rows);
}

/** Remove all seeded games and every puzzle_attempt owned by a seed user. */
function clearSeeded(\BaseApi\Database\DB $db): array
{
    $ids = seedUserIds($db);
    $delGames = $db->exec('DELETE FROM game WHERE hub_game_id LIKE ?', [SEED_GAME_PREFIX . '%']);
    $delAttempts = 0;
    if ($ids !== []) {
        $ph = implode(',', array_fill(0, count($ids), '?'));
        $delAttempts = $db->exec("DELETE FROM puzzle_attempt WHERE user_id IN ($ph)", $ids);
    }
    return [$delGames, $delAttempts];
}

// --- Delete mode ----------------------------------------------------------
if ($deleteMode) {
    [$g, $p] = clearSeeded($db);
    fwrite(STDOUT, "Deleted seeded games ($g) and seeded puzzle attempts ($p).\n");
    exit(0);
}

if (!is_file(ENGINE_BIN)) {
    fwrite(STDERR, "engine binary not found at " . ENGINE_BIN . "\n"
        . "build it first: cd gomachine && go build -o bin/gomachine ./cmd/gomachine\n");
    exit(1);
}

// --- Load seed users ------------------------------------------------------
$cols = 'id,name,created_at,' . implode(',', array_map(static fn ($c) => "rating_$c", CATEGORIES)) . ',rating_puzzle';
$users = $db->raw("SELECT $cols FROM user WHERE email LIKE ?", ['%@' . SEED_DOMAIN]);
if (count($users) < 2) {
    fwrite(STDERR, "need at least 2 @seed.local users — run seed_leaderboard_users.php first.\n");
    exit(1);
}
fwrite(STDOUT, 'Loaded ' . count($users) . " seed users.\n");

// Clear any prior seeded rows so a re-run is idempotent (clear-then-insert).
[$clearedGames, $clearedAttempts] = clearSeeded($db);
if ($clearedGames > 0 || $clearedAttempts > 0) {
    fwrite(STDOUT, "Cleared prior seeded rows: games=$clearedGames attempts=$clearedAttempts.\n");
}

// --- Build the game specs (rating-proximity pairing per category) ---------
// specs[]  = one entry per game: {whiteRating, blackRating, maxPlies}
// meta[]   = parallel array of persistence context for each spec.
$specs = [];
$meta = [];

foreach (CATEGORIES as $cat) {
    $sorted = $users;
    usort($sorted, static fn ($a, $b) => (int) $a["rating_$cat"] <=> (int) $b["rating_$cat"]);
    $n = count($sorted);

    // Total games this category so each user averages ~gamesPerUser/4 games in it
    // (each game credits BOTH players, hence /2).
    $gamesInCat = (int) round($gamesPerUser * $n / 2 / count(CATEGORIES));

    for ($k = 0; $k < $gamesInCat; $k++) {
        $i = mt_rand(0, $n - 2);
        $j = min($i + mt_rand(1, 3), $n - 1);
        if ($j === $i) {
            $j = $i + 1; // neighbours only; guarantees distinct players
        }

        $a = $sorted[$i];
        $b = $sorted[$j];
        // Randomise colours.
        if (mt_rand(0, 1) === 1) {
            [$a, $b] = [$b, $a];
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

$total = count($specs);
if ($total === 0) {
    fwrite(STDERR, "no games to generate.\n");
    exit(1);
}
fwrite(STDOUT, "Generating $total games via the engine (batched, parallel)…\n");

// --- Invoke the engine ONCE (JSON batch on stdin → JSON lines on stdout) ---
$batch = json_encode(['games' => $specs], JSON_UNESCAPED_SLASHES);
$inFile = tempnam(sys_get_temp_dir(), 'gengames_in_');
$outFile = tempnam(sys_get_temp_dir(), 'gengames_out_');
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

// --- Persist each game as a Game row (no Elo re-application) ---------------
$now = time();
$thirtyDays = 30 * 24 * 3600;
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
    $game->hub_game_id = SEED_GAME_PREFIX . bin2hex(random_bytes(9));
    $game->pool = $m['pool'];
    $game->category = $cat;
    $game->rated = true;                     // display only — Elo intentionally NOT applied
    $game->result = $result;
    $game->reason = (string) ($r['reason'] ?? 'adjudicated');
    $game->white_uid = (string) $white['id'];
    $game->black_uid = (string) $black['id'];
    $game->white_name = (string) $white['name'];
    $game->black_name = (string) $black['name'];
    $game->white_user_id = (string) $white['id'];  // required for the profile record COUNT
    $game->black_user_id = (string) $black['id'];
    $game->white_is_bot = false;
    $game->black_is_bot = false;
    // Ratings frozen: before == after (no rating change, since we skip Elo).
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

    // created_at: spread over the last 30 days, clamped to >= both players' created_at
    // (insert skips created_at, so set it with a parameterised UPDATE — DML, not DDL).
    $floor = max(
        strtotime((string) $white['created_at']) ?: $now,
        strtotime((string) $black['created_at']) ?: $now,
    );
    $ts = max($floor, $now - mt_rand(0, $thirtyDays));
    $createdAt = date('Y-m-d H:i:s', $ts);
    $db->exec('UPDATE game SET created_at = ? WHERE id = ?', [$createdAt, $game->id]);

    $inserted++;
    $byResult[$result]++;
}

// --- Seed puzzle attempts (so PUZZLES wins aren't 0) ----------------------
// A handful of distinct-puzzle attempts per user, ~65% solved. rating_before ==
// rating_after (puzzle Elo intentionally NOT applied). Distinct puzzle ids per
// user satisfy the unique (user_id, puzzle_id) index.
$puzzlePool = array_map(
    static fn (array $r): string => (string) $r['id'],
    $db->raw('SELECT id FROM puzzle LIMIT 5000'),
);
$attemptsInserted = 0;
if ($puzzlePool === []) {
    fwrite(STDOUT, "No puzzles in the DB — skipping puzzle-attempt seeding.\n");
} else {
    $poolN = count($puzzlePool);
    foreach ($users as $u) {
        $howMany = mt_rand(4, 12);
        $picks = (array) array_rand($puzzlePool, min($howMany, $poolN));
        $pr = (int) $u['rating_puzzle'];
        foreach ($picks as $pi) {
            $solved = mt_rand(1, 100) <= 65;
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
                    date('Y-m-d H:i:s', max($now - mt_rand(0, $thirtyDays), strtotime((string) $u['created_at']) ?: $now)),
                    date('Y-m-d H:i:s'),
                ],
            );
            $attemptsInserted += $ok;
        }
    }
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
fwrite(STDOUT, "Puzzle attempts inserted: $attemptsInserted\n\n");

// Sample a couple of users' resulting records.
$sampleNames = array_slice(array_map(static fn ($u) => (string) $u['name'], $users), 0, 3);
foreach ($sampleNames as $nm) {
    $row = $db->raw('SELECT id FROM user WHERE name = ? LIMIT 1', [$nm]);
    if ($row === []) {
        continue;
    }
    $id = (string) $row[0]['id'];
    $w = (int) $db->scalar('SELECT COUNT(*) FROM game WHERE (white_user_id = ? AND result = ?) OR (black_user_id = ? AND result = ?)', [$id, '1-0', $id, '0-1']);
    $l = (int) $db->scalar('SELECT COUNT(*) FROM game WHERE (white_user_id = ? AND result = ?) OR (black_user_id = ? AND result = ?)', [$id, '0-1', $id, '1-0']);
    $d = (int) $db->scalar('SELECT COUNT(*) FROM game WHERE (white_user_id = ? OR black_user_id = ?) AND result = ?', [$id, $id, '1/2-1/2']);
    $ps = (int) $db->scalar('SELECT COUNT(*) FROM puzzle_attempt WHERE user_id = ? AND solved = 1', [$id]);
    fwrite(STDOUT, sprintf("  %-24s  W:%d L:%d D:%d (total %d)  puzzleWins:%d\n", $nm, $w, $l, $d, $w + $l + $d, $ps));
}
fwrite(STDOUT, "\nDone.\n");
