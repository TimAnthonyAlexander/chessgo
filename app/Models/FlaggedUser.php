<?php

namespace App\Models;

use BaseApi\Models\BaseModel;

/**
 * A per-user anti-cheat ROLLUP — one row per flagged account, the admin queue's
 * primary table (SPEC §Anti-cheat). AnticheatService upserts this whenever it
 * raises a UserFlag: it bumps total_flags, increments the per-category count, and
 * stamps the last event. The individual UserFlag events are the audit trail; this
 * is the "who is flagged, how often, and for what" summary an admin sorts on.
 *
 * NOT an auto-ban list — `status` is the admin's verdict, defaulting to 'open'
 * (awaiting review). Only an admin ever moves it to 'cleared' or 'banned'.
 *
 * `counts` is a per-category tally map ({category: n}) stored as JSON in a TEXT
 * column and round-tripped via the accessors (BaseAPI array-cast footgun — array
 * properties don't encode on write; mirrors Game::moves).
 */
class FlaggedUser extends BaseModel
{
    /** Flagged account (unique — one rollup row per user). */
    public string $user_id = '';

    /** Denormalized account name, for the admin list without a join. */
    public string $user_name = '';

    /** Total flag events across all categories. */
    public int $total_flags = 0;

    /** Per-category counts as JSON text: {"analysis_during_game": 3, …}. Use getCounts/setCounts. */
    public ?string $counts = null;

    /** Admin verdict: 'open' (awaiting review) | 'reviewing' | 'cleared' | 'banned'. */
    public string $status = 'open';

    /** Category of the most recent flag (quick triage column). */
    public string $last_category = '';

    /** Highest severity seen so far ('low'|'medium'|'high'). */
    public string $top_severity = 'low';

    public ?string $first_flagged_at = null;

    public ?string $last_flagged_at = null;

    /**
     * @var array<string, string>
     */
    public static array $indexes = [
        'user_id' => 'unique',
        'status' => 'index',
    ];

    /**
     * first/last_flagged_at are nullable TEXT ISO datetimes (mirrors User's
     * rated_at_* columns); counts is JSON-in-TEXT.
     *
     * @var array<string, array<string, mixed>>
     */
    public static array $columns = [
        'counts' => ['type' => 'TEXT', 'nullable' => true],
        'first_flagged_at' => ['type' => 'TEXT', 'nullable' => true],
        'last_flagged_at' => ['type' => 'TEXT', 'nullable' => true],
    ];

    /** @return array<string, int> Decoded per-category counts, or [] if absent. */
    public function getCounts(): array
    {
        if ($this->counts === null || $this->counts === '') {
            return [];
        }
        $decoded = json_decode($this->counts, true);

        return is_array($decoded) ? $decoded : [];
    }

    /** @param array<string, int> $counts */
    public function setCounts(array $counts): void
    {
        $this->counts = json_encode($counts);
    }
}
