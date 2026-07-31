<?php

namespace App\Models;

use BaseApi\Models\BaseModel;

/**
 * An Arena-style tournament (Lichess "arena"). The realtime hub polls
 * {@see \App\Controllers\ArenaInternalController} for currently-running
 * arenas (it drives matchmaking/pairing for them); this model + the
 * `tournament`/`tournament_player` tables are the durable source of truth,
 * owned by BaseAPI.
 *
 * `status` is normally 'scheduled' -> 'running' -> 'finished', but nothing
 * flips it on a timer. Instead {@see self::running()} / {@see self::finished()}
 * derive the true state from `starts_at` + `duration_minutes`, and
 * {@see self::reconcileStatus()} writes that derived state back onto
 * `status` at request time (called wherever a tournament is read or listed).
 * That keeps `status` correct without a cron.
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
     * @var array<int|string, mixed>
     */
    public static array $indexes = [
        ['status'],
        ['starts_at'],
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
     * Recompute `status` from wall-clock time and persist it if it changed.
     * Cheap (one strtotime + maybe one save); call whenever a tournament is
     * read so `status` is never stale without needing a cron.
     */
    public function reconcileStatus(): void
    {
        $derived = $this->isFinished() ? 'finished' : ($this->isRunning() ? 'running' : 'scheduled');
        if ($derived !== $this->status) {
            $this->status = $derived;
            $this->save();
        }
    }
}
