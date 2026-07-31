<?php

namespace App\Models;

use BaseApi\Models\BaseModel;

/**
 * A persistent, user-to-user challenge: "play me a game", sent to a specific
 * account and sitting in their notifications/challenge inbox until accepted,
 * declined, cancelled, or it expires. This is distinct from the realtime
 * hub's existing ephemeral 6-char code link (anyone with the link can join) —
 * this one is bound to a specific opponent from creation.
 *
 * `status`: 'pending' | 'accepted' | 'declined' | 'cancelled'.
 * `color`: 'w' | 'b' | 'random' (the CHALLENGER's requested color).
 * `pool`: e.g. "5+0" (base minutes + increment seconds), same shape the hub
 * uses (see gomachine/internal/hub/protocol.go) and validated against the
 * same bounds (base 0..180 min, inc 0..180 sec, not both zero).
 * `fen`: null = standard start position. Custom positions are never rated
 * (ChallengeController forces rated=false whenever fen is set).
 * `code`: the hub's 6-char join code, minted on accept
 * (HubClient::createServerChallenge) — null until then.
 */
class Challenge extends BaseModel
{
    /** The account that sent the challenge. */
    public string $challenger_id = '';

    /** The account the challenge was sent to. */
    public string $opponent_id = '';

    /** Time control, e.g. "5+0" (base minutes + increment seconds). */
    public string $pool = '5+0';

    /** The challenger's requested color: 'w' | 'b' | 'random'. */
    public string $color = 'random';

    /** Whether the resulting game affects Elo. Forced false when `fen` is set. */
    public bool $rated = true;

    /** 'standard' | 'chess960' | 'duck' | 'crazyhouse' | 'antichess'. */
    public string $variant = 'standard';

    /** Custom starting position, or null for the standard start. */
    public ?string $fen = null;

    /** 'pending' | 'accepted' | 'declined' | 'cancelled'. */
    public string $status = 'pending';

    /** The hub's 6-char join code, set on accept. Null until then. */
    public ?string $code = null;

    /** Pending challenges expire 24h after creation. */
    public ?string $expires_at = null;

    /**
     * @var array<int|string, mixed>
     */
    public static array $indexes = [
        'challenger_id' => 'index',
        ['opponent_id', 'status'],
    ];
}
