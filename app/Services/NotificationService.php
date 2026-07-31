<?php

namespace App\Services;

use App\Models\Notification;

/**
 * Writes in-app notifications for the friends + challenges flows. One place
 * so every producer (FriendController, ChallengeController, ...) shapes
 * payloads the same way. Keep payloads small and self-describing: who did
 * what, and the id the client needs to act on it (never a full model dump).
 */
class NotificationService
{
    /**
     * @param array<string, mixed> $payload
     */
    public function push(string $userId, string $type, array $payload): void
    {
        if ($userId === '' || $type === '') {
            return;
        }

        $notification = new Notification();
        $notification->user_id = $userId;
        $notification->type = $type;
        $notification->setPayload($payload);
        $notification->save();
    }
}
