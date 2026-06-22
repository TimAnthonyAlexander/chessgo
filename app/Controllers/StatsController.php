<?php

namespace App\Controllers;

use BaseApi\App;
use BaseApi\Controllers\Controller;
use BaseApi\Http\JsonResponse;
use App\Services\HubClient;

/**
 * Live lobby counts for the homepage (proxies the realtime hub). Public.
 *
 *   GET /stats → { playersOnline, activeGames }
 *
 * STATS_PADDING (.env) is the daytime PEAK filler added to players-online; it rides
 * a 24h diurnal curve so the lobby looks busy in the evening and quiet overnight,
 * plus a short ±~18% wiggle so it feels alive minute-to-minute. Games-in-play is
 * shown as a believable minority of that (always under half). 0 / unset = real
 * counts only.
 *
 * Diurnal shape:
 *   - STATS_PEAK_UTC   (hour 0–23, default 18) — the UTC time-of-day of the peak.
 *     At this hour the filler reaches its full STATS_PADDING base.
 *   - STATS_TROUGH_FRAC (0–1, default 0.35) — the fraction of the base reached at
 *     the opposite end of the day (~12h from the peak). A raised-cosine gradient
 *     runs smoothly between trough and peak across the 24h.
 *
 * The filler is a smooth, DETERMINISTIC function of the wall clock (the diurnal
 * cosine + summed sines) — NOT random per request. So every visitor sees the same
 * number at a given moment (consistent cross-browser / cross-session) and
 * consecutive reloads barely change it; it only drifts over minutes / the day.
 * No stored state needed — reloads never reveal the trick.
 */
class StatsController extends Controller
{
    public function __construct(private readonly HubClient $hub)
    {
    }

    public function get(): JsonResponse
    {
        $stats = $this->hub->stats();

        $base = (int) (App::config('gomachine.stats_padding') ?? 0);
        if ($base > 0) {
            $t = (float) time();

            // Diurnal curve: raised cosine over the UTC day, peaking at STATS_PEAK_UTC
            // and bottoming out ~12h opposite at STATS_TROUGH_FRAC of the base. Smooth
            // gradient throughout, same for everyone at time t.
            $peakUtc = (float) (App::config('gomachine.stats_peak_utc') ?? 18.0);
            $trough = max(0.0, min(1.0, (float) (App::config('gomachine.stats_trough_frac') ?? 0.35)));
            $hourOfDay = fmod($t / 3600.0, 24.0);
            // cos = +1 at the peak hour, -1 twelve hours away → shape in [0,1].
            $shape = 0.5 + 0.5 * cos(2 * M_PI * ($hourOfDay - $peakUtc) / 24.0);
            $diurnal = $trough + (1.0 - $trough) * $shape; // [trough .. 1]

            // Slowly-drifting wiggle: summed sines (periods ~1.5/7/30 min) give an
            // organic minute-to-minute variance. Same for everyone at time t; barely
            // moves across a reload.
            $playerWave = (sin($t / 1800.0) + 0.5 * sin($t / 420.0) + 0.3 * sin($t / 95.0)) / 1.8;
            $players = $stats['playersOnline'] + (int) round($base * $diurnal * (1.0 + 0.18 * $playerWave));

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
