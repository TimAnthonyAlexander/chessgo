<?php

declare(strict_types=1);

/**
 * Promote an account to admin (Wave 1 bootstrap for the admin panel).
 *
 * The admin endpoints gate on User.role === 'admin'; this is the one-off that
 * grants it. Not schema DDL — a single row UPDATE via the model.
 *
 * Usage:
 *   php scripts/make_admin.php <email>
 *
 * Exits nonzero (with a clear message) on a missing argument or unknown email.
 * Idempotent: re-running on an already-admin account is a no-op success.
 */

use BaseApi\App;
use App\Models\User;

require_once __DIR__ . '/../vendor/autoload.php';

App::boot(dirname(__DIR__));

$email = trim((string) ($argv[1] ?? ''));
if ($email === '') {
    fwrite(STDERR, "Usage: php scripts/make_admin.php <email>\n");
    exit(1);
}

$user = User::firstWhere('email', '=', $email);
if (!$user instanceof User) {
    fwrite(STDERR, "Error: no user with email '{$email}'.\n");
    exit(1);
}

if ($user->role === 'admin') {
    fwrite(STDOUT, "{$user->name} <{$email}> is already an admin — nothing to do.\n");
    exit(0);
}

$user->role = 'admin';
if (!$user->save()) {
    fwrite(STDERR, "Error: failed to save user '{$email}'.\n");
    exit(1);
}

fwrite(STDOUT, "Promoted {$user->name} <{$email}> to admin.\n");
exit(0);
