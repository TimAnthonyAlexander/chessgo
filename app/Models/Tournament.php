<?php

namespace App\Models;

use BaseApi\App;
use BaseApi\Models\BaseModel;
use App\Services\Glicko2Service;

/**
 * An Arena-style tournament (Lichess "arena"). The realtime hub polls
 * {@see \App\Controllers\ArenaInternalController} for currently-running
 * arenas (it drives matchmaking/pairing for them); this model + the
 * `tournament`/`tournament_player` tables are the durable source of truth,
 * owned by BaseAPI.
 *
 * `status` is normally 'scheduled' -> 'running' -> 'finished', but nothing
 * flips it on a timer, and (as of 2026-07-31) **nothing writes it on a GET
 * either** — {@see self::isRunning()} / {@see self::isFinished()} derive the
 * true state from `starts_at` + `duration_minutes`, and
 * {@see self::reconcileStatus()} refreshes `$this->status` from that
 * derivation **in memory only** so every response is correct regardless of
 * what's stored. The stored `status` column is just a best-effort cache for
 * cheaply pre-filtering candidates (see ArenaInternalController); it's kept
 * approximately fresh by {@see self::reconcileAllStatuses()}, a single
 * set-based UPDATE pair run periodically from the tournament scheduler
 * (scripts/schedule_tournaments.php), never per-row and never on a read.
 */
class Tournament extends BaseModel
{
    public string $name = '';

    /** 'standard' | 'chess960' | 'duck' | 'crazyhouse' | 'antichess'. */
    public string $variant = 'standard';

    /** Time-control pool, e.g. "3+0". */
    public string $pool = '';

    /** ISO datetime string (UTC) the arena starts. */
    public string $starts_at = '';

    public int $duration_minutes = 30;

    public bool $rated = true;

    /** 'scheduled' | 'running' | 'finished' — derived, see class docblock. */
    public string $status = 'scheduled';

    /** Account id of the admin who created it. */
    public string $created_by = '';

    /**
     * Idempotency key for a scheduled occurrence, e.g.
     * "hourly-bullet-2026-08-01T14:00:00Z" (see {@see \App\Services\TournamentSchedule}
     * and scripts/schedule_tournaments.php). Null for hand-created tournaments.
     * Unique so a re-run of the scheduler can never double-insert the same slot.
     */
    public ?string $schedule_key = null;

    /** Rota this occurrence belongs to ('hourly', 'variant-hourly', 'daily',
     *  'weekly', 'titled-tuesday', 'monthly', …), or null for hand-created ones. */
    public ?string $series = null;

    /** Entry restriction: the joiner's rating (in this tournament's own
     *  category, see TournamentJoinController) must be >= this, or null for none. */
    public ?int $min_rating = null;

    /** Entry restriction: the joiner's rating (in this tournament's own
     *  category) must be <= this, or null for none. */
    public ?int $max_rating = null;

    /** Entry restriction: only accounts with a real title (see User::TITLES,
     *  displayTitle()) may join when true. */
    public bool $titled_only = false;

    /**
     * @var array<int|string, mixed>
     */
    public static array $indexes = [
        ['status'],
        ['starts_at'],
        ['schedule_key', 'type' => 'unique'],
    ];

    public function startsAtTimestamp(): int
    {
        $ts = strtotime($this->starts_at);

        return $ts !== false ? $ts : 0;
    }

    public function endsAtTimestamp(): int
    {
        return $this->startsAtTimestamp() + ($this->duration_minutes * 60);
    }

    public function endsAtMs(): int
    {
        return $this->endsAtTimestamp() * 1000;
    }

    /** True from `starts_at` up to (not including) the end of the arena. */
    public function isRunning(): bool
    {
        $now = time();

        return $now >= $this->startsAtTimestamp() && $now < $this->endsAtTimestamp();
    }

    public function isFinished(): bool
    {
        return time() >= $this->endsAtTimestamp();
    }

    /**
     * The Glicko-2 rating category a joiner is judged against for this
     * tournament's `min_rating`/`max_rating` restrictions. Mirrors
     * GameResultController::post()'s category derivation: Duck/Crazyhouse/
     * Antichess are each their own isolated pool regardless of clock; Standard
     * and Chess960 fall back to the duration-derived time-control category.
     */
    public function ratingCategory(Glicko2Service $glicko): string
    {
        return match ($this->variant) {
            'duck' => 'duck',
            'crazyhouse' => 'crazyhouse',
            'antichess' => 'antichess',
            default => $glicko->categoryForPool($this->pool),
        };
    }

    /** Pure computation of the true status from wall-clock time. No I/O. */
    public function effectiveStatus(): string
    {
        return $this->isFinished() ? 'finished' : ($this->isRunning() ? 'running' : 'scheduled');
    }

    /**
     * Refresh `$this->status` from wall-clock time — **in memory only, never
     * a write**. Call on every read (list/show/join) so the response is
     * always correct even though the stored column may be stale. Cheap: one
     * strtotime, no query.
     */
    public function reconcileStatus(): void
    {
        $this->status = $this->effectiveStatus();
    }

    /**
     * Set-based reconciliation of the stored `status` column for every row at
     * once — two UPDATEs total, not a read+save per row, so cost doesn't
     * scale with table size. This is the ONLY place `status` is persisted
     * from a derived value; it exists solely to keep the stored column a
     * reasonably fresh cache (used by ArenaInternalController to shrink its
     * candidate set) and is meant to be called from the periodic scheduler
     * run (scripts/schedule_tournaments.php), never from a request path.
     *
     * @return int total rows changed across both UPDATEs
     */
    public static function reconcileAllStatuses(): int
    {
        $db = App::db();
        $table = static::table();

        $toRunning = $db->exec(
            "UPDATE `{$table}`
                SET status = 'running'
              WHERE status = 'scheduled'
                AND starts_at <= UTC_TIMESTAMP()
                AND DATE_ADD(starts_at, INTERVAL duration_minutes MINUTE) > UTC_TIMESTAMP()"
        );

        $toFinished = $db->exec(
            "UPDATE `{$table}`
                SET status = 'finished'
              WHERE status IN ('scheduled', 'running')
                AND DATE_ADD(starts_at, INTERVAL duration_minutes MINUTE) <= UTC_TIMESTAMP()"
        );

        return $toRunning + $toFinished;
    }
}
