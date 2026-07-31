<?php

namespace App\Controllers;

use BaseApi\Controllers\Controller;
use BaseApi\Http\JsonResponse;
use App\Models\Challenge;
use App\Models\User;
use App\Services\NotificationService;

/**
 * Persistent, user-to-user challenges — distinct from the hub's existing
 * ephemeral 6-char code link (anyone with the link can join); this one is
 * bound to a specific opponent from creation and lives in their inbox until
 * accepted/declined/cancelled/expired.
 *
 *   POST   /challenges          { name, pool, color, rated, variant, fen? }
 *   GET    /challenges          → { incoming: [...], outgoing: [...] } (pending, non-expired)
 *   DELETE /challenges/{id}     challenger cancels
 *
 * Accept/decline live on {@see ChallengeAcceptController} /
 * {@see ChallengeDeclineController}.
 */
class ChallengeController extends Controller
{
    /** Pending challenges expire after this long. */
    private const TTL_SECONDS = 86400;

    private const VARIANTS = ['standard', 'chess960', 'duck', 'crazyhouse', 'antichess'];

    /** Bound from path {id} on DELETE only. */
    public string $id = '';

    public string $name = '';

    public string $pool = '5+0';

    public string $color = 'random';

    public bool $rated = true;

    public string $variant = 'standard';

    public string $fen = '';

    public function __construct(
        private readonly NotificationService $notifications,
    ) {
    }

    public function post(): JsonResponse
    {
        $me = $this->authedUserId();
        if ($me === null) {
            return JsonResponse::unauthorized();
        }

        $this->validate([
            'name' => 'required|string|max:100',
            'pool' => 'required|string',
            'color' => 'in:w,b,random',
            'rated' => 'boolean',
            'variant' => 'in:' . implode(',', self::VARIANTS),
            'fen' => 'string',
        ]);

        if (!self::validPool($this->pool)) {
            return JsonResponse::badRequest('invalid pool');
        }

        $target = User::firstWhere('name', '=', $this->name);
        if (!$target instanceof User) {
            return JsonResponse::notFound('user not found');
        }
        if ($target->id === $me) {
            return JsonResponse::badRequest('cannot challenge yourself');
        }

        $fen = trim($this->fen) !== '' ? trim($this->fen) : null;
        // Custom starting positions never affect ratings.
        $rated = $fen !== null ? false : $this->rated;

        $challenge = new Challenge();
        $challenge->challenger_id = $me;
        $challenge->opponent_id = $target->id;
        $challenge->pool = $this->pool;
        $challenge->color = $this->color !== '' ? $this->color : 'random';
        $challenge->rated = $rated;
        $challenge->variant = $this->variant !== '' ? $this->variant : 'standard';
        $challenge->fen = $fen;
        $challenge->status = 'pending';
        $challenge->expires_at = gmdate('Y-m-d H:i:s', time() + self::TTL_SECONDS);
        $challenge->save();

        $this->notifications->push($target->id, 'challenge', [
            'challengeId' => $challenge->id,
            'userId' => $me,
            'pool' => $challenge->pool,
            'variant' => $challenge->variant,
        ]);

        return JsonResponse::created(['id' => $challenge->id]);
    }

    public function get(): JsonResponse
    {
        $me = $this->authedUserId();
        if ($me === null) {
            return JsonResponse::unauthorized();
        }

        $now = gmdate('Y-m-d H:i:s');

        $incoming = Challenge::query()
            ->where('opponent_id', '=', $me)
            ->where('status', '=', 'pending')
            ->where('expires_at', '>', $now)
            ->orderByDesc('created_at')
            ->get();

        $outgoing = Challenge::query()
            ->where('challenger_id', '=', $me)
            ->where('status', '=', 'pending')
            ->where('expires_at', '>', $now)
            ->orderByDesc('created_at')
            ->get();

        $otherIds = array_values(array_unique(array_merge(
            array_map(static fn (Challenge $c): string => $c->challenger_id, $incoming),
            array_map(static fn (Challenge $c): string => $c->opponent_id, $outgoing),
        )));

        $byId = [];
        if ($otherIds !== []) {
            foreach (User::query()->whereIn('id', $otherIds)->get() as $u) {
                $byId[$u->id] = $u;
            }
        }

        $shapeIncoming = static function (Challenge $c) use ($byId): array {
            $u = $byId[$c->challenger_id] ?? null;

            return self::row($c, $c->challenger_id, $u);
        };
        $shapeOutgoing = static function (Challenge $c) use ($byId): array {
            $u = $byId[$c->opponent_id] ?? null;

            return self::row($c, $c->opponent_id, $u);
        };

        return JsonResponse::ok([
            'incoming' => array_map($shapeIncoming, $incoming),
            'outgoing' => array_map($shapeOutgoing, $outgoing),
        ]);
    }

    public function delete(): JsonResponse
    {
        $me = $this->authedUserId();
        if ($me === null) {
            return JsonResponse::unauthorized();
        }

        $challenge = Challenge::find($this->id);
        if (!$challenge instanceof Challenge) {
            return JsonResponse::notFound('not found');
        }
        if ($challenge->challenger_id !== $me) {
            return JsonResponse::forbidden();
        }
        if ($challenge->status !== 'pending') {
            return JsonResponse::badRequest('challenge is not pending');
        }

        $challenge->status = 'cancelled';
        $challenge->save();

        return JsonResponse::ok(['status' => 'cancelled']);
    }

    /**
     * @return array<string, mixed>
     */
    private static function row(Challenge $c, string $otherId, ?User $u): array
    {
        return [
            'id' => $c->id,
            'userId' => $otherId,
            'name' => $u instanceof User ? $u->name : null,
            'rating' => $u instanceof User ? $u->rating_blitz : null,
            'pool' => $c->pool,
            'color' => $c->color,
            'rated' => $c->rated,
            'variant' => $c->variant,
            'fen' => $c->fen,
            'expiresAt' => $c->expires_at,
            'createdAt' => $c->created_at,
        ];
    }

    /**
     * `pool` must parse as base+increment with base 0..180 minutes and inc
     * 0..180 seconds, not both zero — the same bounds the hub enforces (see
     * gomachine/internal/hub/protocol.go).
     */
    public static function validPool(string $pool): bool
    {
        if (preg_match('/^(\d+)\+(\d+)$/', $pool, $m) !== 1) {
            return false;
        }
        $base = (int) $m[1];
        $inc = (int) $m[2];

        return $base >= 0 && $base <= 180 && $inc >= 0 && $inc <= 180 && ($base > 0 || $inc > 0);
    }

    private function authedUserId(): ?string
    {
        $user = $this->request->user;
        $id = $user['id'] ?? null;

        return is_string($id) && $id !== '' ? $id : null;
    }
}
