<?php

declare(strict_types=1);

/**
 * Seed a pool of bot accounts so Arena tournaments always have a credible
 * field (ArenaInternalController auto-enrols from this pool into every
 * running arena). PRODUCTION-visible — unlike scripts/seed_leaderboard_users.php
 * (a local-dev-only leaderboard filler), these accounts are real, live
 * tournament participants.
 *
 * Marked, idempotent, removable, exactly like seed_leaderboard_users.php:
 *   - role = 'bot' (checked everywhere `role` matters — App::grep confirms it
 *     is only ever special-cased for 'admin'; 'bot' grants/denies nothing)
 *   - email domain @bot.local (recognisable, filterable)
 *   - password is a random, never-recorded hash — these accounts can never
 *     log in (no code path hands out or accepts a password for them)
 *
 * Deterministic + idempotent: account #i always gets email botNNN@bot.local
 * and (via a per-index seed) the same name/ratings/title on every run, so
 * re-running with the same --count is a total no-op (every email already
 * exists → skipped). Running with a larger --count only adds the new indices.
 *
 * Ratings are seeded across ALL 8 Glicko-2 categories (bullet, blitz, rapid,
 * classical, puzzle, duck, crazyhouse, antichess) spread ~900-2400, with a
 * fixed subset given a real chess title (see TITLED_SLOTS) so a titled_only
 * arena has a real field to draw from.
 *
 * Usage:
 *   php scripts/seed_bot_accounts.php [--count=150]
 *   php scripts/seed_bot_accounts.php --delete
 */

use BaseApi\App;
use App\Models\User;
use App\Services\Glicko2Service;

require_once __DIR__ . '/../vendor/autoload.php';

App::boot(dirname(__DIR__));

const BOT_DOMAIN = 'bot.local';

/**
 * Categories a freshly-created bot gets a plausible SKILL rating in — these are
 * the ones {@see scripts/seed_bot_history.php} can actually back with real,
 * self-played Game rows (bullet/blitz/rapid/classical) or real puzzle_attempt
 * rows (puzzle). `games_<cat>`/`rd_<cat>`/`rated_at_<cat>` start FRESH (0 /
 * START_RD / null) here — seed_bot_history.php sets them from whatever it
 * actually inserts. This is the fix for the old bug: this script used to stamp
 * a random `games_<cat>` (20-400) onto every category with zero rows behind
 * it, so a profile could read "276 bullet games" next to "0 games played" —
 * every number contradicting every other one.
 *
 * duck/crazyhouse/antichess are deliberately NOT in this list: there's no
 * batched self-play tool for those variants (gomachine gengames is standard-
 * chess-only, and zugzwang doesn't even expose an antichess serve route yet),
 * so a bot simply keeps User's own fresh defaults there (1500 / RD 350 / 0
 * games) — an honest "never played this variant" rather than a fabricated
 * history. See seed_bot_history.php's docblock for the full reasoning.
 */
const BOT_CATEGORIES = ['bullet', 'blitz', 'rapid', 'classical', 'puzzle'];

/**
 * Legacy fixed title assignment for the original 40-account pool (by 1-based
 * index, evenly spread so they aren't clustered at the front). Kept verbatim
 * — these 40 accounts already exist and are skipped by the idempotency check
 * below, but the mapping stays here so a from-scratch reseed of a fresh DB
 * reproduces the exact same 8 legacy titled accounts.
 *
 * @var array<int, string>
 */
const TITLED_SLOTS = [
    1 => 'GM',
    6 => 'IM',
    11 => 'GM',
    16 => 'WGM',
    21 => 'IM',
    26 => 'FM',
    31 => 'WIM',
    36 => 'NM',
];

/**
 * The 8-title cycle TITLED_SLOTS walks every 5th index through, in order.
 * Reused by {@see titleForIndex()} to keep assigning titles past index 40 on
 * the same cycle, just at a tighter spacing (every 4th index instead of every
 * 5th) so the titled SHARE of the pool goes up, not just the absolute count.
 *
 * @var list<string>
 */
const TITLE_CYCLE = ['GM', 'IM', 'GM', 'WGM', 'IM', 'FM', 'WIM', 'NM'];

/**
 * Title for bot index $i, or null for an untitled bot. Indices 1-40 use the
 * legacy fixed TITLED_SLOTS mapping unchanged (see its docblock). Indices
 * above 40 get a title every 4th index (41, 45, 49, ...), cycling through the
 * same 8 titles TITLED_SLOTS uses — a ~25% titled share for the new range,
 * up from the legacy pool's 1-in-5 (20%), so growing the pool raises the
 * titled share as well as the absolute count (see task: "raise the titled
 * share"). A titled_only event (Titled Tuesday) needs a credible field of
 * real, differently-titled entrants, not 8 repeats.
 */
function titleForIndex(int $i): ?string
{
    if ($i <= 40) {
        return TITLED_SLOTS[$i] ?? null;
    }

    if (($i - 41) % 4 !== 0) {
        return null;
    }

    $cyclePos = intdiv($i - 41, 4) % count(TITLE_CYCLE);

    return TITLE_CYCLE[$cyclePos];
}

/** @var array<string, array{0:int,1:int}> title => [min,max] base-rating band */
const TITLE_RATING_BANDS = [
    'GM' => [2300, 2400],
    'IM' => [2150, 2300],
    'FM' => [2000, 2150],
    'WGM' => [2100, 2250],
    'WIM' => [1950, 2100],
    'NM' => [1900, 2000],
];

// --- CLI args -------------------------------------------------------------
$argvRest = array_slice($argv, 1);
$deleteMode = in_array('--delete', $argvRest, true);
// 150: the biggest scaled field (ArenaInternalController's monthly-championship
// / weekly-long-arena target, ~100) needs a pool comfortably bigger than the
// largest single field so different tournaments (different crc32(tournamentId)
// orderings) draw visibly different subsets instead of the same ~100 every
// time. 150 new-account indices at 4 self-play categories x 8 games each is
// real engine self-play time (see seed_bot_history.php) — big enough to look
// like a real site, not so big the backfill run balloons past an hour.
$count = 150;
foreach ($argvRest as $a) {
    if (str_starts_with($a, '--count=')) {
        $count = max(1, (int) substr($a, strlen('--count=')));
    }
}

// --- Delete mode: remove every seeded row ---------------------------------
if ($deleteMode) {
    $deleted = App::db()->exec(
        'DELETE FROM user WHERE role = ? AND email LIKE ?',
        ['bot', '%@' . BOT_DOMAIN],
    );
    fwrite(STDOUT, "Deleted bot accounts (role='bot' AND email LIKE %@" . BOT_DOMAIN . ").\n");
    exit(0);
}

// --- Handle generation ------------------------------------------------------
// PRODUCTION MUST NOT DEPEND ON fakerphp/faker: it's require-dev only, and prod
// deploys `composer install --no-dev` — `\Faker\Factory` does not exist there
// (this is exactly the fatal this script used to throw on prod). No dev
// library, no fixture-only vocab file: this is a from-scratch generator in the
// style of the hub's fakeUsername() (gomachine/internal/hub/bot.go) — small
// hardcoded word lists, mt_srand-seeded per index, zero external dependency.
$chessAdjs = [
    'sharp', 'positional', 'tactical', 'drawish', 'sound', 'dubious', 'romantic',
    'hypermodern', 'prophylactic', 'greedy', 'solid', 'speculative', 'quiet',
    'swift', 'silent', 'iron', 'lazy', 'cosmic', 'grim', 'lucky', 'vivid',
    'rusty', 'brave', 'sly', 'noble', 'wild', 'crimson', 'patient', 'reckless',
];
$chessNouns = [
    'knight', 'bishop', 'rook', 'pawn', 'queen', 'king', 'fork', 'pin', 'skewer',
    'gambit', 'endgame', 'zugzwang', 'fianchetto', 'passer', 'tempo', 'zwischenzug',
    'outpost', 'battery', 'discovery', 'sac', 'windmill', 'trap', 'blunder',
    'falcon', 'raven', 'otter', 'badger', 'comet', 'viper', 'phoenix', 'walrus',
];

// Small curated first/last-name pools standing in for Faker's name generator —
// deliberately generic and global, not exhaustive; just enough entropy that
// the ~30% "real player" style handles don't repeat across 150 accounts.
const REAL_FIRST_NAMES = [
    'james', 'john', 'robert', 'michael', 'david', 'william', 'richard', 'thomas',
    'daniel', 'matthew', 'anthony', 'mark', 'paul', 'andrew', 'joshua', 'kevin',
    'brian', 'george', 'edward', 'ronald', 'mary', 'jennifer', 'linda', 'elizabeth',
    'susan', 'jessica', 'sarah', 'karen', 'nancy', 'lisa', 'emma', 'olivia', 'ava',
    'sophia', 'mia', 'amelia', 'harper', 'ella', 'grace', 'chloe', 'victoria',
    'alexei', 'ivan', 'dmitri', 'sergei', 'magnus', 'viktor', 'henrik', 'erik',
    'wei', 'jian', 'hiroshi', 'kenji', 'arjun', 'ravi', 'priya', 'ananya',
];
const REAL_LAST_NAMES = [
    'smith', 'johnson', 'williams', 'brown', 'jones', 'garcia', 'miller', 'davis',
    'rodriguez', 'martinez', 'hernandez', 'lopez', 'gonzalez', 'wilson', 'anderson',
    'thomas', 'taylor', 'moore', 'jackson', 'martin', 'lee', 'perez', 'thompson',
    'white', 'harris', 'clark', 'lewis', 'robinson', 'walker', 'young', 'allen',
    'king', 'wright', 'scott', 'torres', 'nguyen', 'hill', 'flores', 'green',
    'petrov', 'ivanov', 'sokolov', 'volkov', 'kobayashi', 'tanaka', 'sharma', 'singh',
];

/** Deterministic handle for index $i — same input always yields the same name. */
function makeBotHandle(int $i, array $chessAdjs, array $chessNouns): string
{
    mt_srand($i * 7919 + 42);
    $pick = static fn(array $a): string => $a[array_rand($a)];

    // ~30% plausible real-ish display names, the rest chess handles — same mix
    // the hub's fakeUsername() and seed_leaderboard_users.php already use.
    if (mt_rand(1, 100) <= 30) {
        mt_srand($i * 104729 + 7);
        $first = $pick(REAL_FIRST_NAMES);
        $last = $pick(REAL_LAST_NAMES);
        $sep = $pick(['', '_', '.']);
        $tail = mt_rand(1, 100) <= 50 ? (string) mt_rand(1, 99) : '';

        return $first . $sep . $last . $tail;
    }

    $style = mt_rand(1, 4);
    $handle = match ($style) {
        1 => $pick($chessAdjs) . '_' . $pick($chessNouns),
        2 => $pick($chessNouns) . (string) mt_rand(1, 99),
        3 => strtoupper(substr($pick($chessNouns), 0, 1)) . substr($pick($chessNouns), 1) . $pick($chessAdjs),
        default => $pick($chessNouns) . (string) (1985 + mt_rand(0, 25)),
    };

    if (mt_rand(1, 100) <= 60) {
        $handle .= (string) mt_rand(1, 999);
    }

    return $handle;
}

/** Skewed sample across [900, 2400], biased toward the middle (avg of 3 uniforms). */
function skewedBotRating(): int
{
    $u = ((mt_rand() / mt_getrandmax()) + (mt_rand() / mt_getrandmax()) + (mt_rand() / mt_getrandmax())) / 3.0;

    return (int) round(900 + 1500 * $u);
}

function clampBotRating(int $r): int
{
    return max(900, min(2400, $r));
}

// Uniqueness guard: the word pool is finite, so two indices could in theory
// produce the same handle. Track every name already in use — both pre-existing
// bot rows (any earlier run, any --count) and names picked earlier in *this*
// run — and deterministically disambiguate a collision by appending the index.
// This never touches an existing account (those are skipped before a name is
// even generated) and stays 100% reproducible: a fresh index's handle depends
// only on that index plus the fixed set of names that came before it.
$usedNames = [];
foreach (App::db()->raw("SELECT name FROM user WHERE role = 'bot'") as $row) {
    $usedNames[$row['name']] = true;
}

// --- Seed loop ------------------------------------------------------------
$now = date('Y-m-d H:i:s');
$created = 0;
$skipped = 0;
$titledCreated = 0;

for ($i = 1; $i <= $count; $i++) {
    $email = sprintf('bot%03d@%s', $i, BOT_DOMAIN);

    // Idempotency: skip if this seeded bot already exists.
    if (User::firstWhere('email', '=', $email) instanceof User) {
        $skipped++;
        continue;
    }

    mt_srand($i * 15485863 + 3);
    $handle = makeBotHandle($i, $chessAdjs, $chessNouns);
    while (isset($usedNames[$handle])) {
        $handle .= (string) $i;
    }
    $usedNames[$handle] = true;

    $title = titleForIndex($i);

    mt_srand($i * 32452867 + 11);
    if ($title !== null) {
        [$lo, $hi] = TITLE_RATING_BANDS[$title];
        $base = mt_rand($lo, $hi);
    } else {
        $base = skewedBotRating();
    }

    $user = new User();
    $user->name = $handle;
    $user->email = $email;
    // Unusable password: a random hash of random bytes, never recorded
    // anywhere. No login/signup path can ever produce a match.
    $user->password = password_hash(bin2hex(random_bytes(32)), PASSWORD_DEFAULT);
    $user->role = 'bot';
    $user->active = true;
    $user->title = $title;

    foreach (BOT_CATEGORIES as $cat) {
        $rating = clampBotRating($base + mt_rand(-100, 100));

        // Skill rating only — games/RD/rated_at start FRESH. seed_bot_history.php
        // is what earns these down to a real, reconciled games_<cat> + RD once it
        // has actually self-played + persisted the history.
        $user->{'rating_' . $cat} = $rating;
        $user->{'rd_' . $cat} = Glicko2Service::START_RD;
        $user->{'vol_' . $cat} = Glicko2Service::START_VOL;
        $user->{'games_' . $cat} = 0;
        $user->{'rated_at_' . $cat} = null;
    }
    // duck/crazyhouse/antichess are left at User's own fresh defaults
    // (1500 / RD 350 / 0 games) — see BOT_CATEGORIES docblock above.

    if (!$user->save()) {
        fwrite(STDERR, "Failed to save bot '$handle' ($email)\n");
        continue;
    }

    // Backdate created_at so the account predates any history
    // seed_bot_history.php later backfills for it ("Member since" must read
    // BEFORE the games, not the day the profile bug was noticed). Deterministic
    // per index (like the rest of this script) so re-running with the same
    // --count never shifts an existing bot's date — 180..730 days back.
    mt_srand($i * 67867967 + 23);
    $daysAgo = mt_rand(180, 730);
    $createdAt = date('Y-m-d H:i:s', strtotime($now) - $daysAgo * 86400);
    App::db()->exec('UPDATE user SET created_at = ? WHERE id = ?', [$createdAt, $user->id]);

    $created++;
    if ($title !== null) {
        $titledCreated++;
    }
}

fwrite(STDOUT, "created: $created  skipped (already existed): $skipped  titled: $titledCreated\n");
fwrite(STDOUT, "Bot accounts marked role='bot', email @" . BOT_DOMAIN . ", skill ratings ~900-2400 across "
    . implode(', ', BOT_CATEGORIES) . " (games/RD start fresh — run seed_bot_history.php to back them "
    . "with real games). duck/crazyhouse/antichess stay at User's fresh defaults.\n");
fwrite(STDOUT, "Delete with: php scripts/seed_bot_accounts.php --delete\n");
