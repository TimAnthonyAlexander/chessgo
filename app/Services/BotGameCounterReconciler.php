<?php

namespace App\Services;

use App\Models\Game;
use App\Models\User;

/**
 * One-off / re-runnable fix for the games_<category> drift on seeded bot
 * accounts (role='bot'). Bot sides deliberately never go through
 * GameResultController's Elo path (see resolveAccount()), so before the
 * accompanying persist-path fix, a bot's own games_<category> counters never
 * moved while it kept playing arena games — leaving the profile's per-category
 * "N games" tile behind the account's actual `game` rows.
 *
 * This recomputes each bot's counters directly from its own `game` rows (a
 * rated game in a category is exactly what bumps that counter going forward),
 * so a reconciled profile matches its history immediately. Idempotent: a
 * counter already equal to its true count is left untouched, so re-running
 * this after the persist-path fix is a no-op.
 *
 * Scope is intentionally narrow: only `user` rows with role==='bot' are ever
 * read or written. A real (human) account's games_<category> counters are
 * never touched here — the task explicitly rules out silently rewriting a
 * real player's stats (their counters may legitimately include history that
 * predates the `game` table's current contents).
 */
class BotGameCounterReconciler
{
    /** Every Game.category value this platform tracks a per-category counter for. */
    private const CATEGORIES = ['bullet', 'blitz', 'rapid', 'classical', 'chess960', 'duck', 'crazyhouse', 'antichess'];

    /**
     * @return list<array{id: string, name: string, changed: bool, before: array<string, int>, after: array<string, int>}>
     */
    public function reconcile(): array
    {
        $report = [];

        $bots = User::query()->where('role', '=', 'bot')->get();
        foreach ($bots as $bot) {
            $report[] = $this->reconcileOne($bot);
        }

        return $report;
    }

    /**
     * @return array{id: string, name: string, changed: bool, before: array<string, int>, after: array<string, int>}
     */
    private function reconcileOne(User $bot): array
    {
        $before = [];
        $after = [];
        $changed = false;

        foreach (self::CATEGORIES as $category) {
            $before[$category] = (int) $bot->{'games_' . $category};
            $actual = $this->actualGameCount($bot->id, $category);
            $after[$category] = $actual;
            if ($actual !== $before[$category]) {
                $bot->{'games_' . $category} = $actual;
                $changed = true;
            }
        }

        if ($changed) {
            $bot->save();
        }

        return [
            'id' => $bot->id,
            'name' => $bot->name,
            'changed' => $changed,
            'before' => $before,
            'after' => $after,
        ];
    }

    /**
     * Count of rated Game rows for this account in this category — the same
     * condition GameResultController::writeRating()/bumpGamesCounter() bump
     * the counter under, so the reconciled value matches what the live path
     * produces going forward.
     */
    private function actualGameCount(string $userId, string $category): int
    {
        return Game::query()
            ->whereGroup(function ($g) use ($userId): void {
                $g->where('white_user_id', '=', $userId)->orWhere('black_user_id', '=', $userId);
            })
            ->where('category', '=', $category)
            ->where('rated', '=', true)
            ->count();
    }
}
