<?php

namespace App\Models;

use Override;
use BaseApi\Models\BaseModel;

/**
 * One Tutor report: a player's report card over a date range.
 *
 * A report is a discrete artifact the user REQUESTS, not a live dashboard —
 * you press a button, a job builds it, a notification says it's ready, and the
 * row is kept forever so the trend view can read two of them side by side.
 * Deleting old reports deletes the trend feature, so we never overwrite.
 *
 * The row doubles as the job record: `status` walks queued → building →
 * ready|insufficient|failed, so a build that dies leaves a report saying so
 * rather than vanishing. There is no separate queue table.
 *
 * As everywhere in this codebase, the computed payload is JSON in a `?string`
 * TEXT column with explicit accessors — an `array`-typed property decodes on
 * read but does NOT encode on write (it becomes the string "Array").
 * See app/Models/BotGame.php for the same pattern.
 */
class TutorReport extends BaseModel
{
    /** Owner. Reports are private to their user (admins excepted). */
    public string $user_id = '';

    /** Window start/end as 'Y-m-d H:i:s'. */
    public string $range_from = '';

    public string $range_to = '';

    /** Which preset produced the window: '1m' | '3m' | '6m' | '12m'. */
    public string $range_label = '6m';

    /**
     * queued     — requested, waiting for the worker
     * building   — worker has it
     * ready      — payload is populated
     * insufficient — not enough games in any category to say anything honest
     * failed     — the build threw; `error` says what
     */
    public string $status = 'queued';

    /** Games in the window that were eligible (before sampling). */
    public int $games_considered = 0;

    /** Games actually measured and folded into the metrics. */
    public int $games_used = 0;

    /**
     * Games this build had to send to the engine (the rest were already
     * analyzed, and cost nothing). This is the one that costs wall clock, and
     * the one TutorBuildService::ANALYSIS_BUDGET bounds for the whole report —
     * `games_used` can be several times larger when a player's games are
     * mostly cached.
     */
    public int $games_analyzed = 0;

    /**
     * Games that were sampled but could not be measured — the engine call
     * failed, the analysis wouldn't store, or the game was too short. Without
     * this the report silently claims to have considered games it never read
     * (TutorGameReader::read() returns null and the game just vanishes), and
     * `games_considered - games_used` reads as a cap effect rather than a
     * failure.
     */
    public int $games_skipped = 0;

    /** True when some category had more eligible games than the build could
     *  measure, so it sampled. The report says so on screen — "based on 140 of
     *  your 380 blitz games". */
    public bool $cap_hit = false;

    /** The computed report. JSON text; use getPayload()/setPayload(). */
    public ?string $payload = null;

    /** Failure detail when status='failed', else null. */
    public ?string $error = null;

    /** When the build finished ('Y-m-d H:i:s'), or null while pending. */
    public ?string $built_at = null;

    /**
     * @var array<string, mixed>
     */
    public static array $columns = [
        // MEDIUMTEXT for the same reason game.analysis is: the payload grows
        // with the player's games (a gameRow per measured game per category,
        // plus comparisons and drills), so it has no 64KB bound either.
        'payload' => ['type' => 'MEDIUMTEXT', 'nullable' => true],
        'error' => ['type' => 'TEXT', 'nullable' => true],
    ];

    /**
     * (user_id, created_at) drives both the report list and the "has anything
     * changed since your last report" rate-limit check. (status) lets the
     * worker find queued rows without scanning.
     *
     * @var array<int|string, mixed>
     */
    public static array $indexes = [
        ['user_id', 'created_at'],
        ['status'],
    ];

    /**
     * @return array<string, mixed>
     */
    public function getPayload(): array
    {
        if ($this->payload === null || $this->payload === '') {
            return [];
        }

        $decoded = json_decode($this->payload, true);

        return is_array($decoded) ? $decoded : [];
    }

    /**
     * @param array<string, mixed> $payload
     */
    public function setPayload(array $payload): void
    {
        $this->payload = json_encode($payload);
    }

    /**
     * The list row — everything /tutor needs to render the shelf of past
     * reports without decoding a full payload per row.
     *
     * @return array<string, mixed>
     */
    public function summaryRow(): array
    {
        $payload = $this->getPayload();

        return [
            'id' => $this->id,
            'status' => $this->status,
            'rangeFrom' => $this->range_from,
            'rangeTo' => $this->range_to,
            'rangeLabel' => $this->range_label,
            'gamesConsidered' => $this->games_considered,
            'gamesUsed' => $this->games_used,
            'gamesSkipped' => $this->games_skipped,
            'capHit' => $this->cap_hit,
            'builtAt' => $this->built_at,
            'createdAt' => $this->created_at ?? null,
            'error' => $this->error,
            // Cheap enough to surface on the list: the one-line headline and
            // which categories made the cut.
            'headline' => $payload['headline'] ?? null,
            'categories' => array_keys($payload['categories'] ?? []),
        ];
    }

    /**
     * @return array<string, mixed>
     */
    #[Override]
    public function jsonSerialize(): array
    {
        $data = parent::jsonSerialize();
        $data['payload'] = $this->getPayload();

        return $data;
    }
}
