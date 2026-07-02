<?php

declare(strict_types=1);

/**
 * Seed the LOCAL dev `user` table with realistic fake players so the
 * per-category leaderboard (GET /leaderboard?category=…) looks populated.
 *
 * LOCAL DEV ONLY. Seeded rows are marked by a recognizable email domain
 * (@seed.local) so they are trivially removable and the script is idempotent
 * (a user with the same email is skipped, so re-running never duplicates).
 *
 * Leaderboard filter satisfied (LeaderboardController):
 *   WHERE games_<cat> > 0  ORDER BY rating_<cat> DESC
 * so every seeded user gets games_<cat> > 0 in all four time controls plus
 * puzzle, and a NON-provisional RD (< Glicko2Service::PROVISIONAL_RD = 110).
 *
 * Usage:
 *   php scripts/seed_leaderboard_users.php [count]      # default 250
 *
 * Delete the seeded users later (raw DML, not DDL):
 *   php scripts/seed_leaderboard_users.php --delete
 */

use BaseApi\App;
use App\Models\User;
use App\Services\Glicko2Service;

require_once __DIR__ . '/../vendor/autoload.php';

App::boot(dirname(__DIR__));

const SEED_DOMAIN = 'seed.local';

// --- CLI args -------------------------------------------------------------
$argvRest = array_slice($argv, 1);
$deleteMode = in_array('--delete', $argvRest, true);
$count = 250;
foreach ($argvRest as $a) {
    if (ctype_digit($a)) {
        $count = (int) $a;
    }
}

// --- Delete mode: remove every seeded row ---------------------------------
if ($deleteMode) {
    $deleted = App::db()->exec(
        'DELETE FROM user WHERE email LIKE ?',
        ['%@' . SEED_DOMAIN],
    );
    fwrite(STDOUT, "Deleted seeded users (email LIKE %@" . SEED_DOMAIN . ").\n");
    exit(0);
}

// --- Handle generation ----------------------------------------------------
// Chess-flavoured handle vocabulary. Real Faker words are mixed in for variety
// so handles do not read like a fixed template.
$faker = \Faker\Factory::create();

$chessNouns = [
    'knight', 'bishop', 'rook', 'pawn', 'queen', 'king', 'fork', 'pin', 'skewer',
    'gambit', 'endgame', 'zugzwang', 'fianchetto', 'passer', 'tempo', 'zwischenzug',
    'blunder', 'patzer', 'fish', 'castle', 'promotion', 'checkmate', 'stalemate',
    'outpost', 'battery', 'discovery', 'sac', 'smother', 'windmill', 'trap',
];
$chessAdjs = [
    'sharp', 'positional', 'tactical', 'drawish', 'sound', 'dubious', 'romantic',
    'hypermodern', 'prophylactic', 'greedy', 'solid', 'speculative', 'quiet',
];
$openings = [
    'sicilian', 'najdorf', 'caro_kann', 'french', 'kingsindian', 'grunfeld',
    'nimzo', 'ruylopez', 'italian', 'catalan', 'london', 'benoni', 'slav',
    'bongcloud', 'vienna', 'scandi', 'petroff', 'englund', 'dutch', 'pirc',
];
$legends = [
    'tal', 'petrosian', 'capablanca', 'fischer', 'kasparov', 'karpov', 'carlsen',
    'morphy', 'alekhine', 'nimzowitsch', 'botvinnik', 'lasker', 'anand', 'nakamura',
];
$squares = [];
foreach (['a','b','c','d','e','f','g','h'] as $file) {
    foreach (range(1, 8) as $rank) {
        $squares[] = $file . $rank;
    }
}
$pieces = ['N', 'B', 'R', 'Q', 'K'];

/** Build one realistic chess-handle style username. */
function makeHandle(
    \Faker\Generator $faker,
    array $chessNouns,
    array $chessAdjs,
    array $openings,
    array $legends,
    array $squares,
    array $pieces,
): string {
    $pick = static fn(array $a): string => $a[array_rand($a)];
    $digits = static fn(): string => (string) mt_rand(1, 9999);

    // ~20% plausible real-ish display names, the rest chess handles.
    if (mt_rand(1, 100) <= 20) {
        $first = strtolower($faker->firstName());
        $last = strtolower($faker->lastName());
        $sep = $pick(['', '_', '.']);
        $tail = mt_rand(1, 100) <= 50 ? $digits() : '';

        return $first . $sep . $last . $tail;
    }

    $style = mt_rand(1, 10);
    $handle = match (true) {
        $style <= 3 => $pick($chessAdjs) . '_' . $pick($chessNouns),                    // sharp_gambit
        $style <= 5 => $pick($chessNouns) . $pick($squares),                            // rooke1
        $style === 6 => $pick($pieces) . 'x' . $pick($squares) . '_' . $pick($chessNouns), // Qxf7_smother
        $style === 7 => $pick($legends) . '_' . $pick(['disciple', 'fan', 'style', 'era', 'ghost']),
        $style === 8 => strtolower($faker->word()) . '_' . $pick($chessNouns),
        $style === 9 => $pick($openings) . '_' . $pick(['andy', 'enjoyer', 'main', 'diehard', 'guy']),
        default => $pick(['en_passant', 'the', 'mr', 'lil', 'big', 'sir']) . '_' . $pick($chessNouns),
    };

    // Frequently tack on digits, like real handles (patzer2200, knightfork07).
    if (mt_rand(1, 100) <= 65) {
        $handle .= (mt_rand(1, 100) <= 40) ? str_pad($digits(), 2, '0', STR_PAD_LEFT) : $digits();
    }

    return $handle;
}

/**
 * Skewed rating sample: heavy bias toward the bottom of [500, 2500].
 * pow(u, 2.3) pushes most mass low; few reach 2200+.
 */
function skewedRating(): int
{
    $u = mt_rand() / mt_getrandmax();
    return 500 + (int) round(2000 * ($u ** 2.3));
}

/** Clamp a value into the rating band. */
function clampRating(int $r): int
{
    return max(500, min(2500, $r));
}

// --- Seed loop ------------------------------------------------------------
$categories = ['bullet', 'blitz', 'rapid', 'classical', 'puzzle'];
$now = date('Y-m-d H:i:s');

$created = 0;
$skipped = 0;
$seen = [];              // in-run username de-dupe
$histogram = [];         // bucket (int) => count, on the blitz rating

for ($i = 0; $created + $skipped < $count * 3 && $created < $count; $i++) {
    $handle = makeHandle($faker, $chessNouns, $chessAdjs, $openings, $legends, $squares, $pieces);

    if (isset($seen[$handle])) {
        continue;
    }
    $seen[$handle] = true;

    $email = $handle . '@' . SEED_DOMAIN;

    // Idempotency: skip if this seeded user already exists.
    if (User::firstWhere('email', '=', $email) instanceof User) {
        $skipped++;
        continue;
    }

    // Base skill per user; each category jitters ±150 around it (correlated but
    // not identical across the four time controls + puzzle).
    $base = skewedRating();

    $user = new User();
    $user->name = $handle;
    $user->email = $email;
    $user->password = password_hash(bin2hex(random_bytes(16)), PASSWORD_DEFAULT);
    $user->role = 'user';
    $user->active = true;

    $blitzRating = $base;
    foreach ($categories as $cat) {
        $rating = clampRating($base + mt_rand(-150, 150));

        // More games ↔ lower RD, roughly. 20..600 games; RD 45..85, non-provisional.
        $games = mt_rand(20, 600);
        $rd = 85.0 - ($games / 600.0) * 40.0 + mt_rand(-30, 30) / 10.0; // ~45..85
        $rd = max(45.0, min(85.0, $rd));
        $vol = mt_rand(550, 650) / 10000.0; // 0.055..0.065

        $user->{'rating_' . $cat} = $rating;
        $user->{'rd_' . $cat} = round($rd, 4);
        $user->{'vol_' . $cat} = round($vol, 5);
        $user->{'games_' . $cat} = $games;
        $user->{'rated_at_' . $cat} = $now;

        if ($cat === 'blitz') {
            $blitzRating = $rating;
        }
    }

    if (!$user->save()) {
        fwrite(STDERR, "Failed to save user '$handle'\n");
        continue;
    }

    $created++;
    $bucket = (int) (floor($blitzRating / 250) * 250);
    $histogram[$bucket] = ($histogram[$bucket] ?? 0) + 1;

    if ($created % 25 === 0) {
        fwrite(STDOUT, "\rcreated: $created  skipped: $skipped");
    }
}

// --- Summary --------------------------------------------------------------
fwrite(STDOUT, "\rcreated: $created  skipped: $skipped\n\n");
fwrite(STDOUT, "Blitz rating distribution (buckets of 250):\n");
ksort($histogram);
$maxCount = $histogram === [] ? 1 : max($histogram);
foreach ($histogram as $bucket => $n) {
    $bar = str_repeat('#', (int) round(($n / $maxCount) * 40));
    fwrite(STDOUT, sprintf("  %4d-%4d | %-40s %d\n", $bucket, $bucket + 249, $bar, $n));
}
fwrite(STDOUT, "\nProvisional RD threshold: " . Glicko2Service::PROVISIONAL_RD
    . " (all seeded RD in 45..85 → non-provisional, games>0 → visible on board).\n");
fwrite(STDOUT, "Done.\n");
