<?php

namespace App\Controllers;

use BaseApi\Controllers\Controller;
use BaseApi\Http\JsonResponse;
use App\Models\User;
use App\Models\UserFlag;
use App\Models\FlaggedUser;

/**
 * Admin anti-cheat review surface (SPEC §Anti-cheat). The detection side only
 * ever FLAGS — this is where a human decides. Admin-gated (role === 'admin'),
 * exactly like EngineMatchController.
 *
 *   GET  /admin/flags            → list flagged users (?status= to filter)
 *   GET  /admin/flags/{userId}   → one user's rollup + recent flag events
 *   POST /admin/flags/{userId}   → set the verdict: { status, ban? }
 *
 * On POST, `status` is the admin's verdict ('open'|'reviewing'|'cleared'|
 * 'banned'); `ban:true` (or status 'banned') also deactivates the account
 * (User.active=false), which LoginController then refuses. Nothing here is
 * automatic — a flag never bans on its own.
 */
class AdminFlagsController extends Controller
{
    /** Bound from path {userId} (empty on the list route). */
    public string $userId = '';

    /** GET: ?status= filter. POST: the new verdict. */
    public string $status = '';

    /** POST: also deactivate the account. */
    public bool $ban = false;

    private const STATUSES = ['open', 'reviewing', 'cleared', 'banned'];

    /** How many recent flag events to embed in the detail view. */
    private const RECENT_EVENTS = 50;

    public function get(): JsonResponse
    {
        if (!$this->isAdmin()) {
            return JsonResponse::error('admin only', 403);
        }

        return $this->userId !== '' ? $this->detail($this->userId) : $this->list();
    }

    public function post(): JsonResponse
    {
        if (!$this->isAdmin()) {
            return JsonResponse::error('admin only', 403);
        }
        if ($this->userId === '') {
            return JsonResponse::badRequest('userId is required');
        }

        $row = FlaggedUser::firstWhere('user_id', '=', $this->userId);
        if (!$row instanceof FlaggedUser) {
            return JsonResponse::error('no flags for that user', 404);
        }

        $newStatus = $this->status !== '' ? $this->status : $row->status;
        if (!in_array($newStatus, self::STATUSES, true)) {
            return JsonResponse::badRequest('invalid status');
        }

        $shouldBan = $this->ban || $newStatus === 'banned';
        if ($shouldBan) {
            $newStatus = 'banned';
            $user = User::find($this->userId);
            if ($user instanceof User) {
                $user->active = false;
                $user->save();
            }
        }

        $row->status = $newStatus;
        $row->save();

        return JsonResponse::ok(['user_id' => $row->user_id, 'status' => $row->status, 'banned' => $shouldBan]);
    }

    /** @return JsonResponse */
    private function list(): JsonResponse
    {
        $q = FlaggedUser::query();
        if ($this->status !== '' && in_array($this->status, self::STATUSES, true)) {
            $q = $q->where('status', '=', $this->status);
        }

        // Most recently flagged first — the freshest suspicion sits at the top.
        $rows = $q->orderByDesc('last_flagged_at')->limit(200)->get();

        $out = array_map(static fn (FlaggedUser $f): array => [
            'user_id' => $f->user_id,
            'user_name' => $f->user_name,
            'total_flags' => $f->total_flags,
            'counts' => $f->getCounts(),
            'status' => $f->status,
            'top_severity' => $f->top_severity,
            'last_category' => $f->last_category,
            'first_flagged_at' => $f->first_flagged_at,
            'last_flagged_at' => $f->last_flagged_at,
        ], $rows);

        return JsonResponse::ok(['flagged' => $out]);
    }

    private function detail(string $userId): JsonResponse
    {
        $row = FlaggedUser::firstWhere('user_id', '=', $userId);
        if (!$row instanceof FlaggedUser) {
            return JsonResponse::error('no flags for that user', 404);
        }

        $events = UserFlag::query()
            ->where('user_id', '=', $userId)
            ->orderByDesc('created_at')
            ->limit(self::RECENT_EVENTS)
            ->get();

        $eventRows = array_map(static fn (UserFlag $e): array => [
            'id' => $e->id,
            'category' => $e->category,
            'severity' => $e->severity,
            'detail' => $e->detail,
            'meta' => $e->getMeta(),
            'reviewed' => $e->reviewed,
            'created_at' => $e->created_at,
        ], $events);

        return JsonResponse::ok([
            'user_id' => $row->user_id,
            'user_name' => $row->user_name,
            'total_flags' => $row->total_flags,
            'counts' => $row->getCounts(),
            'status' => $row->status,
            'top_severity' => $row->top_severity,
            'first_flagged_at' => $row->first_flagged_at,
            'last_flagged_at' => $row->last_flagged_at,
            'events' => $eventRows,
        ]);
    }

    private function isAdmin(): bool
    {
        $user = $this->request->user;

        return is_array($user) && ($user['role'] ?? '') === 'admin';
    }
}
