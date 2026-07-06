<?php

namespace App\Services;

use App\Models\User;

/**
 * "The Flame" — the single source of truth for the daily-activity streak.
 *
 * A day is "qualifying" when the user does chess activity that UTC day (solving a
 * puzzle OR playing a rated game). Consecutive qualifying days grow the streak; a
 * missed day resets it to 1 — UNLESS the user still holds a freeze token, which
 * auto-covers a single missed day (a gap of exactly two days). UTC days keep the
 * roll consistent with how the daily puzzle is keyed (gmdate).
 *
 * The roll logic lives ONLY here and is called from the two qualifying-action
 * hooks (PuzzleController on a solve, GameResultController on a rated persist).
 */
class StreakService
{
    /**
     * Record a qualifying action for $user "today" (UTC) and roll the streak
     * forward, persisting the result. Idempotent within a day: repeated actions on
     * the same UTC day are a no-op (the streak only ticks once per day).
     *
     *  - last active today            → no-op (already counted)
     *  - last active yesterday        → increment
     *  - gap of 2 days + freeze token → consume freeze, increment (streak survives)
     *  - otherwise (a real miss)      → reset to 1
     *
     * Always keeps longest_streak up to date.
     */
    public function recordActivity(User $user): void
    {
        $today = gmdate('Y-m-d');
        $last = $user->last_active_date;

        if ($last !== null && $last !== '') {
            $gap = $this->dayGap($last, $today);
            if ($gap <= 0) {
                return; // already active today (or a clock skew) — nothing to roll
            }

            if ($gap === 1) {
                $user->current_streak = $user->current_streak + 1;
            } elseif ($gap === 2 && $user->freeze_tokens > 0) {
                $user->freeze_tokens = $user->freeze_tokens - 1;
                $user->current_streak = $user->current_streak + 1;
            } else {
                $user->current_streak = 1;
            }
        } else {
            $user->current_streak = 1;
        }

        $user->last_active_date = $today;
        if ($user->current_streak > $user->longest_streak) {
            $user->longest_streak = $user->current_streak;
        }

        $user->save();
    }

    /**
     * The streak as it should be DISPLAYED right now. The stored current_streak
     * only rolls on a qualifying action, so a user who has been away still carries
     * a stale value until their next action resets it — this computes the live view
     * without mutating anything.
     *
     * @return array{current:int, activeToday:bool}
     */
    public function view(User $user): array
    {
        $today = gmdate('Y-m-d');
        $last = $user->last_active_date;

        if ($last === null || $last === '') {
            return ['current' => 0, 'activeToday' => false];
        }

        $gap = $this->dayGap($last, $today);
        if ($gap <= 0) {
            return ['current' => $user->current_streak, 'activeToday' => true];
        }

        // Still alive if today is the day after the last action, or a freeze token
        // could still cover a single missed day when the next action lands.
        if ($gap === 1 || ($gap === 2 && $user->freeze_tokens > 0)) {
            return ['current' => $user->current_streak, 'activeToday' => false];
        }

        return ['current' => 0, 'activeToday' => false];
    }

    /**
     * Whole-day gap between two 'YYYY-MM-DD' UTC dates ($to - $from). Returns a
     * large sentinel on unparseable input so callers treat it as a broken streak.
     */
    private function dayGap(string $from, string $to): int
    {
        $a = strtotime($from . ' UTC');
        $b = strtotime($to . ' UTC');
        if ($a === false || $b === false) {
            return PHP_INT_MAX;
        }

        return (int) round(($b - $a) / 86400.0);
    }
}
