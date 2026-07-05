<?php

namespace App\Models;

use BaseApi\Models\BaseModel;

/**
 * One anti-cheat flag EVENT — an append-only audit row raised by AnticheatService
 * when a user trips a detection signal (SPEC §Anti-cheat). Flags are advisory:
 * they never auto-ban. An admin reviews the FlaggedUser rollup, drills into these
 * events, and decides. See AnticheatService.
 *
 * `category` is the signal that fired (e.g. 'analysis_during_game'). `severity`
 * is a coarse triage hint ('low'|'medium'|'high'). `meta` is JSON-shaped context
 * (endpoint, analyzed FEN, live board FEN, exact-match flag) stored in a TEXT
 * column — the BaseAPI array-cast footgun means array properties don't encode on
 * write, so we round-trip JSON via the accessors below (mirrors Game::moves).
 */
class UserFlag extends BaseModel
{
    /** Account the flag is against. */
    public string $user_id = '';

    /** Detection signal that fired, e.g. 'analysis_during_game'. */
    public string $category = '';

    /** Coarse triage severity: 'low' | 'medium' | 'high'. */
    public string $severity = 'medium';

    /** Human-readable one-line reason shown in the admin queue. */
    public string $detail = '';

    /** JSON-shaped context (endpoint, fens, matched). Use getMeta/setMeta. */
    public ?string $meta = null;

    /** Set true once an admin has actioned this specific event. */
    public bool $reviewed = false;

    /**
     * @var array<string, string>
     */
    public static array $indexes = [
        'user_id' => 'index',
        'category' => 'index',
    ];

    /**
     * @var array<string, array<string, mixed>>
     */
    public static array $columns = [
        'meta' => ['type' => 'TEXT', 'nullable' => true],
    ];

    /** @return array<string, mixed> Decoded context, or [] if absent. */
    public function getMeta(): array
    {
        if ($this->meta === null || $this->meta === '') {
            return [];
        }
        $decoded = json_decode($this->meta, true);

        return is_array($decoded) ? $decoded : [];
    }

    /** @param array<string, mixed> $meta */
    public function setMeta(array $meta): void
    {
        $this->meta = json_encode($meta);
    }
}
