<?php

namespace App\Models;

use Override;
use BaseApi\Models\BaseModel;

/**
 * A single in-app notification for one account. Written by
 * {@see \App\Services\NotificationService} from the friends + challenges
 * flows, read by NotificationController.
 *
 * `type`: 'friend_request' | 'friend_accepted' | 'challenge' |
 * 'challenge_accepted' | 'challenge_declined'.
 *
 * NOTE: BaseAPI's `array` cast decodes on read but does NOT encode on write
 * (see vendor CLAUDE.md / app/Models/BotGame.php), so `payload` is a `?string`
 * TEXT column round-tripped explicitly via getPayload/setPayload. Keep
 * payloads small and self-describing (who, what, and the id needed to act on
 * it) — this is a notification feed, not a data store.
 */
class Notification extends BaseModel
{
    /** The account this notification is for. */
    public string $user_id = '';

    /** 'friend_request' | 'friend_accepted' | 'challenge' | 'challenge_accepted' | 'challenge_declined'. */
    public string $type = '';

    /** JSON-encoded payload. Use getPayload/setPayload — never read/write directly. */
    public ?string $payload = null;

    /** Null while unread; set to the read timestamp once acknowledged. */
    public ?string $read_at = null;

    /**
     * @var array<string, array<string, mixed>>
     */
    public static array $columns = [
        'payload' => ['type' => 'TEXT', 'nullable' => true],
    ];

    /**
     * @var array<int|string, mixed>
     */
    public static array $indexes = [
        ['user_id', 'read_at'],
    ];

    /** @return array<string, mixed> */
    public function getPayload(): array
    {
        if ($this->payload === null || $this->payload === '') {
            return [];
        }
        $decoded = json_decode($this->payload, true);

        return is_array($decoded) ? $decoded : [];
    }

    /** @param array<string, mixed> $payload */
    public function setPayload(array $payload): void
    {
        $this->payload = json_encode($payload);
    }

    /**
     * Expose `payload` decoded in API output.
     *
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
