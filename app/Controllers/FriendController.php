<?php

namespace App\Controllers;

use BaseApi\Controllers\Controller;
use BaseApi\Http\JsonResponse;
use App\Models\FriendLink;
use App\Models\User;
use App\Services\HubClient;
use App\Services\NotificationService;

/**
 * Friends list + friend requests (SPEC: friends/notifications/challenges).
 *
 *   GET    /friends          accepted friends: linkId, userId, name, title, best rating, online
 *   POST   /friends          { name } — send a request (or auto-accept a mutual one)
 *   DELETE /friends/{id}      unfriend, or cancel your own outgoing request — {id}
 *                             is the FriendLink row id (GET /friends' `linkId`),
 *                             never the friend's own user id.
 *
 * The incoming/outgoing pending lists live on the sibling
 * {@see FriendRequestsController} (GET /friends/requests); accept/decline
 * live on {@see FriendAcceptController} / {@see FriendDeclineController}.
 *
 * A FriendLink row is keyed (requester_id, addressee_id) — see the model for
 * why re-requesting after a decline updates the row in place instead of
 * inserting a duplicate.
 */
class FriendController extends Controller
{
    /** Time-control categories considered for the "best rating" tile. */
    private const RATING_CATEGORIES = ['bullet', 'blitz', 'rapid', 'classical'];

    /** Bound from path {id} on DELETE only. */
    public string $id = '';

    public string $name = '';

    public function __construct(
        private readonly NotificationService $notifications,
        private readonly HubClient $hub,
    ) {
    }

    public function get(): JsonResponse
    {
        $me = $this->authedUserId();
        if ($me === null) {
            return JsonResponse::unauthorized();
        }

        $links = FriendLink::query()
            ->where('status', '=', 'accepted')
            ->whereGroup(function ($g) use ($me): void {
                $g->where('requester_id', '=', $me)->orWhere('addressee_id', '=', $me);
            })
            ->get();

        // Map friend user id => FriendLink row id. DELETE /friends/{id} expects
        // the LINK id (not the friend's user id), so the row below must carry
        // both, unambiguously named — see FriendRow in frontend/src/api/client.ts.
        $linkIdByFriendId = [];
        $friendIds = [];
        foreach ($links as $link) {
            $fid = $link->requester_id === $me ? $link->addressee_id : $link->requester_id;
            $linkIdByFriendId[$fid] = $link->id;
            $friendIds[] = $fid;
        }
        $friendIds = array_values(array_unique($friendIds));

        if ($friendIds === []) {
            return JsonResponse::ok(['friends' => []]);
        }

        $users = User::query()->whereIn('id', $friendIds)->get();
        $online = $this->hub->onlineSubs($friendIds);

        $byId = [];
        foreach ($users as $u) {
            $byId[$u->id] = $u;
        }

        $friends = [];
        foreach ($friendIds as $fid) {
            $u = $byId[$fid] ?? null;
            if (!$u instanceof User) {
                continue;
            }
            $best = $this->bestRating($u);
            $friends[] = [
                'linkId' => $linkIdByFriendId[$fid] ?? '',
                'userId' => $u->id,
                'name' => $u->name,
                'title' => $this->titleOf($u),
                'rating' => $best['rating'],
                'ratingCategory' => $best['category'],
                'online' => in_array($u->id, $online, true),
            ];
        }

        return JsonResponse::ok(['friends' => $friends]);
    }

    public function post(): JsonResponse
    {
        $me = $this->authedUserId();
        if ($me === null) {
            return JsonResponse::unauthorized();
        }

        $this->validate([
            'name' => 'required|string|max:100',
        ]);

        $target = User::firstWhere('name', '=', $this->name);
        if (!$target instanceof User) {
            return JsonResponse::notFound('user not found');
        }
        if ($target->id === $me) {
            return JsonResponse::badRequest('cannot friend yourself');
        }

        // Already friends (accepted), in either direction.
        $existingAccepted = FriendLink::query()
            ->where('status', '=', 'accepted')
            ->whereGroup(function ($g) use ($me, $target): void {
                $g->whereGroup(function ($g2) use ($me, $target): void {
                    $g2->where('requester_id', '=', $me)->where('addressee_id', '=', $target->id);
                })->orWhereGroup(function ($g2) use ($me, $target): void {
                    $g2->where('requester_id', '=', $target->id)->where('addressee_id', '=', $me);
                });
            })
            ->first();
        if ($existingAccepted instanceof FriendLink) {
            return JsonResponse::error('already friends', 409);
        }

        // A reverse pending request already exists (they requested me) — accept
        // it instead of creating a duplicate (mutual-request auto-accept).
        $reversePending = FriendLink::query()
            ->where('requester_id', '=', $target->id)
            ->where('addressee_id', '=', $me)
            ->where('status', '=', 'pending')
            ->first();
        if ($reversePending instanceof FriendLink) {
            $reversePending->status = 'accepted';
            $reversePending->save();
            $this->notifications->push($target->id, 'friend_accepted', [
                'userId' => $me,
            ]);

            return JsonResponse::ok(['status' => 'accepted']);
        }

        // My own existing row toward them: pending is a no-op resend, declined
        // is re-opened in place (never a duplicate row — see model docblock).
        $mine = FriendLink::query()
            ->where('requester_id', '=', $me)
            ->where('addressee_id', '=', $target->id)
            ->first();
        if ($mine instanceof FriendLink) {
            if ($mine->status === 'pending') {
                return JsonResponse::ok(['status' => 'pending']);
            }
            $mine->status = 'pending';
            $mine->save();
            $this->notifications->push($target->id, 'friend_request', [
                'userId' => $me,
            ]);

            return JsonResponse::created(['status' => 'pending']);
        }

        $link = new FriendLink();
        $link->requester_id = $me;
        $link->addressee_id = $target->id;
        $link->status = 'pending';
        $link->save();

        $this->notifications->push($target->id, 'friend_request', [
            'userId' => $me,
        ]);

        return JsonResponse::created(['status' => 'pending']);
    }

    public function delete(): JsonResponse
    {
        $me = $this->authedUserId();
        if ($me === null) {
            return JsonResponse::unauthorized();
        }

        $link = FriendLink::find($this->id);
        if (!$link instanceof FriendLink) {
            return JsonResponse::notFound('not found');
        }
        if ($link->requester_id !== $me && $link->addressee_id !== $me) {
            return JsonResponse::forbidden();
        }

        $link->delete();

        return JsonResponse::ok(['deleted' => true]);
    }

    private function authedUserId(): ?string
    {
        $user = $this->request->user;
        $id = $user['id'] ?? null;

        return is_string($id) && $id !== '' ? $id : null;
    }

    /** Read User::$title defensively — another agent is adding the column. */
    private function titleOf(User $user): ?string
    {
        if (method_exists($user, 'displayTitle')) {
            return $user->displayTitle();
        }

        return property_exists($user, 'title') ? $user->title : null;
    }

    /**
     * The rating category the account has played the most games in (ties
     * broken toward 'blitz'), for the friends-list rating tile.
     *
     * @return array{category: string, rating: int}
     */
    private function bestRating(User $user): array
    {
        $best = ['category' => 'blitz', 'rating' => $user->rating_blitz];
        $bestGames = -1;
        foreach (self::RATING_CATEGORIES as $cat) {
            $games = (int) $user->{'games_' . $cat};
            if ($games > $bestGames) {
                $bestGames = $games;
                $best = ['category' => $cat, 'rating' => (int) $user->{'rating_' . $cat}];
            }
        }

        return $best;
    }
}
