<?php

namespace App\Models;

use BaseApi\Models\BaseModel;

/**
 * A friend relationship between two accounts, requester → addressee. One row
 * per direction of the *initial* request — accepting/declining flips `status`
 * on the same row rather than creating a second one. See routes/api.php
 * ("Friends, notifications, challenges" block) for the full contract.
 *
 * `status`: 'pending' | 'accepted' | 'declined'.
 *
 * The (requester_id, addressee_id) pair is unique so a race can't insert two
 * rows for the same direction; re-requesting after a decline UPDATEs the
 * existing row back to 'pending' instead of inserting a duplicate (see
 * FriendController::post()). A mutual pending pair (A→B and B→A both pending)
 * is resolved by auto-accepting the reverse row rather than ever existing at
 * rest.
 */
class FriendLink extends BaseModel
{
    /** The account that sent the request. */
    public string $requester_id = '';

    /** The account the request was sent to. */
    public string $addressee_id = '';

    /** 'pending' | 'accepted' | 'declined'. */
    public string $status = 'pending';

    /**
     * @var array<int|string, mixed>
     */
    public static array $indexes = [
        ['requester_id', 'addressee_id', 'type' => 'unique'],
        ['addressee_id', 'status'],
    ];
}
