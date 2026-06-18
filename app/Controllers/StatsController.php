<?php

namespace App\Controllers;

use BaseApi\Controllers\Controller;
use BaseApi\Http\JsonResponse;
use App\Services\HubClient;

/**
 * Live lobby counts for the homepage (proxies the realtime hub). Public.
 *
 *   GET /stats → { playersOnline, activeGames }
 *
 * STATS_PADDING (.env) optionally inflates players-online by that base ± 20% so a
 * quiet lobby still looks alive; games-in-play is then shown as a believable
 * minority of that (always under half). 0 / unset = real counts only.
 */
class StatsController extends Controller
{
    public function __construct(private readonly HubClient $hub)
    {
    }

    public function get(): JsonResponse
    {
        $stats = $this->hub->stats();

        $padding = (int)($_ENV['STATS_PADDING'] ?? 0);
        if ($padding > 0) {
            $players = $stats['playersOnline'] + $this->jitter($padding);
            // Games read as a random 30–45% of who's online (a plausible minority),
            // never the real count if that's higher, and hard-capped below half.
            $ratio = 0.30 + (random_int(0, 1000) / 1000.0) * 0.15;
            $games = max($stats['activeGames'], (int) round($players * $ratio));
            $cap = intdiv($players, 2) - 1;
            if ($cap >= 0 && $games > $cap) {
                $games = $cap;
            }

            $stats['playersOnline'] = $players;
            $stats['activeGames'] = $games;
        }

        return JsonResponse::ok($stats);
    }

    /** A base value varied by a fresh ±20% each call (so the number drifts). */
    private function jitter(int $base): int
    {
        $factor = 0.8 + (random_int(0, 1000) / 1000.0) * 0.4; // 0.8–1.2

        return (int) round($base * $factor);
    }
}
