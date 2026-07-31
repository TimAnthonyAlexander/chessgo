<?php

namespace App\Controllers;

use BaseApi\Controllers\Controller;
use BaseApi\Http\JsonResponse;
use App\Models\FriendLink;
use App\Models\User;

/**
 *   GET /friends/requests → { incoming: [...], outgoing: [...] }
 *
 * Pending FriendLink rows where the caller is the addressee (incoming) or the
 * requester (outgoing), with the other side's name/title/rating for display.
 */
class FriendRequestsController extends Controller
{
    public function get(): JsonResponse
    {
        $user = $this->request->user;
        $me = is_string($user['id'] ?? null) ? $user['id'] : null;
        if ($me === null || $me === '') {
            return JsonResponse::unauthorized();
        }

        $incomingLinks = FriendLink::query()
            ->where('addressee_id', '=', $me)
            ->where('status', '=', 'pending')
            ->orderByDesc('created_at')
            ->get();

        $outgoingLinks = FriendLink::query()
            ->where('requester_id', '=', $me)
            ->where('status', '=', 'pending')
            ->orderByDesc('created_at')
            ->get();

        $otherIds = array_values(array_unique(array_merge(
            array_map(static fn (FriendLink $l): string => $l->requester_id, $incomingLinks),
            array_map(static fn (FriendLink $l): string => $l->addressee_id, $outgoingLinks),
        )));

        $byId = [];
        if ($otherIds !== []) {
            foreach (User::query()->whereIn('id', $otherIds)->get() as $u) {
                $byId[$u->id] = $u;
            }
        }

        $shape = static function (FriendLink $link, string $otherId) use ($byId): array {
            $u = $byId[$otherId] ?? null;

            return [
                'id' => $link->id,
                'userId' => $otherId,
                'name' => $u instanceof User ? $u->name : null,
                'title' => $u instanceof User ? $u->displayTitle() : null,
                'createdAt' => $link->created_at,
            ];
        };

        return JsonResponse::ok([
            'incoming' => array_map(
                static fn (FriendLink $l): array => $shape($l, $l->requester_id),
                $incomingLinks,
            ),
            'outgoing' => array_map(
                static fn (FriendLink $l): array => $shape($l, $l->addressee_id),
                $outgoingLinks,
            ),
        ]);
    }
}
