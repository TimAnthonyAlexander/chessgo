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
 * STATS_PADDING (.env) optionally inflates players-online by a base that drifts
 * ±~18% over time so a quiet lobby still looks alive; games-in-play is shown as a
 * believable minority of that (always under half). 0 / unset = real counts only.
 *
 * The filler is a smooth, deterministic function of the wall clock (summed sines)
 * — NOT random per request. So every visitor sees the same number at a given
 * moment (consistent cross-browser / cross-session) and consecutive reloads barely
 * change it; it only drifts over minutes. No stored state needed.
 */
class StatsController extends Controller
{
    public function __construct(private readonly HubClient $hub)
    {
    }

    public function get(): JsonResponse
    {
        $stats = $this->hub->stats();

        $base = (int)($_ENV['STATS_PADDING'] ?? 0);
        if ($base > 0) {
            $t = (float) time();

            // Slowly-drifting filler: summed sines (periods ~1.5/7/30 min) give an
            // organic wiggle. Same for everyone at time t; ~constant across a reload.
            $playerWave = (sin($t / 1800.0) + 0.5 * sin($t / 420.0) + 0.3 * sin($t / 95.0)) / 1.8;
            $players = $stats['playersOnline'] + (int) round($base * (1.0 + 0.18 * $playerWave));

            // Games: a believable minority of who's online, on its own slow phase so
            // it isn't perfectly correlated — and hard-capped strictly below half.
            $ratio = 0.38 + 0.06 * sin($t / 900.0 + 1.7); // ~0.32–0.44
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
}
