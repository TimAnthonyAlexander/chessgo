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
 *   php scripts/seed_bot_accounts.php [--count=40]
 *   php scripts/seed_bot_accounts.php --delete
 */

use BaseApi\App;
use App\Models\User;

require_once __DIR__ . '/../vendor/autoload.php';

App::boot(dirname(__DIR__));

const BOT_DOMAIN = 'bot.local';

/** Every Glicko-2 category a bot needs a plausible rating in. */
const BOT_CATEGORIES = ['bullet', 'blitz', 'rapid', 'classical', 'puzzle', 'duck', 'crazyhouse', 'antichess'];

/**
 * Fixed title assignment: 8 of the pool (by 1-based index, evenly spread so
 * they aren't clustered at the front) get a real title. Ratings for these
 * indices are drawn from a title-appropriate high band, not the general
 * spread, so a titled_only tournament's field looks credible.
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
$count = 40;
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

// --- Handle generation (mirrors seed_leaderboard_users.php's style, so bot
// names read exactly like the hub's existing fake matchmaking-bot names) ---
$faker = \Faker\Factory::create();

$chessAdjs = [
    'sharp', 'positional', 'tactical', 'drawish', 'sound', 'dubious', 'romantic',
    'hypermodern', 'prophylactic', 'greedy', 'solid', 'speculative', 'quiet',
];
$chessNouns = [
    'knight', 'bishop', 'rook', 'pawn', 'queen', 'king', 'fork', 'pin', 'skewer',
    'gambit', 'endgame', 'zugzwang', 'fianchetto', 'passer', 'tempo', 'zwischenzug',
    'outpost', 'battery', 'discovery', 'sac', 'windmill', 'trap',
];

/** Deterministic handle for index $i — same input always yields the same name. */
function makeBotHandle(int $i, \Faker\Generator $faker, array $chessAdjs, array $chessNouns): string
{
    mt_srand($i * 7919 + 42);
    $pick = static fn(array $a): string => $a[array_rand($a)];

    // ~30% plausible real-ish display names, the rest chess handles — same mix
    // the hub's fakeUsername() and seed_leaderboard_users.php already use.
    if (mt_rand(1, 100) <= 30) {
        mt_srand($i * 104729 + 7);
        $first = strtolower($faker->firstName());
        $last = strtolower($faker->lastName());
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
    $handle = makeBotHandle($i, $faker, $chessAdjs, $chessNouns);

    $title = TITLED_SLOTS[$i] ?? null;

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

        $games = mt_rand(20, 400);
        $rd = 85.0 - ($games / 400.0) * 40.0 + mt_rand(-30, 30) / 10.0; // ~45..85, non-provisional
        $rd = max(45.0, min(85.0, $rd));
        $vol = mt_rand(550, 650) / 10000.0;

        $user->{'rating_' . $cat} = $rating;
        $user->{'rd_' . $cat} = round($rd, 4);
        $user->{'vol_' . $cat} = round($vol, 5);
        $user->{'games_' . $cat} = $games;
        $user->{'rated_at_' . $cat} = $now;
    }

    if (!$user->save()) {
        fwrite(STDERR, "Failed to save bot '$handle' ($email)\n");
        continue;
    }

    $created++;
    if ($title !== null) {
        $titledCreated++;
    }
}

fwrite(STDOUT, "created: $created  skipped (already existed): $skipped  titled: $titledCreated\n");
fwrite(STDOUT, "Bot accounts marked role='bot', email @" . BOT_DOMAIN . ", ratings ~900-2400 across "
    . implode(', ', BOT_CATEGORIES) . ".\n");
fwrite(STDOUT, "Delete with: php scripts/seed_bot_accounts.php --delete\n");
