<?php

namespace App\Controllers;

use BaseApi\Controllers\Controller;
use BaseApi\Http\JsonResponse;
use App\Controllers\Concerns\AdminGuard;
use App\Models\User;
use App\Models\UserFlag;
use App\Models\FlaggedUser;

/**
 * Admin anti-cheat review surface (SPEC §Anti-cheat). The detection side only
 * ever FLAGS — this is where a human decides. Admin-gated via {@see AdminGuard}.
 *
 *   GET  /admin/flags                         → list flagged users
 *                                               (?status= filter, ?sort=/?dir=/?page=)
 *   GET  /admin/flags/{userId}                → one user's rollup + recent flag events
 *   POST /admin/flags/{userId}                → set the verdict: { status, ban? }
 *   POST /admin/flags/{userId}/events/{eventId} → mark one event: { reviewed:bool }
 *
 * On the verdict POST, `status` is the admin's call ('open'|'reviewing'|
 * 'cleared'|'banned'); `ban:true` (or status 'banned') also deactivates the
 * account (User.active=false), which LoginController then refuses. Passing
 * `ban:false` EXPLICITLY reinstates a previously banned account (active=true).
 * Nothing here is automatic — a flag never bans on its own.
 */
class AdminFlagsController extends Controller
{
    use AdminGuard;

    /** Bound from path {userId} (empty on the list route). */
    public string $userId = '';

    /** Bound from path {eventId} — set only on the per-event review route. */
    public string $eventId = '';

    /** GET: ?status= filter. POST: the new verdict. */
    public string $status = '';

    /** GET list: ?sort= (total_flags|top_severity|last_flagged_at) / ?dir= / ?page=. */
    public string $sort = 'last_flagged_at';

    public string $dir = 'desc';

    public int $page = 1;

    /** POST verdict: also deactivate the account. */
    public bool $ban = false;

    /** POST per-event review: the new reviewed state for the event. */
    public bool $reviewed = false;

    /** Admin verdict vocabulary (shared with the dashboard's by_status buckets). */
    public const STATUSES = ['open', 'reviewing', 'cleared', 'banned'];

    /** Sort keys accepted on the list route. */
    private const SORTS = ['total_flags', 'top_severity', 'last_flagged_at'];

    /** Severity → rank, low→high, for the in-PHP severity ordering. */
    private const SEVERITY_RANK = ['low' => 0, 'medium' => 1, 'high' => 2];

    /** Flagged users per page on the list route. */
    private const PER_PAGE = 50;

    /** How many recent flag events to embed in the detail view. */
    private const RECENT_EVENTS = 50;

    public function get(): JsonResponse
    {
        if ($denied = $this->requireAdmin($this->request)) {
            return $denied;
        }

        return $this->userId !== '' ? $this->detail($this->userId) : $this->list();
    }

    public function post(): JsonResponse
    {
        if ($denied = $this->requireAdmin($this->request)) {
            return $denied;
        }
        if ($this->userId === '') {
            return JsonResponse::badRequest('userId is required');
        }

        // POST /admin/flags/{userId}/events/{eventId} → per-event review.
        if ($this->eventId !== '') {
            return $this->reviewEvent();
        }

        // POST /admin/flags/{userId} → the account-level verdict.
        return $this->verdict();
    }

    private function verdict(): JsonResponse
    {
        $row = FlaggedUser::firstWhere('user_id', '=', $this->userId);
        if (!$row instanceof FlaggedUser) {
            return JsonResponse::error('no flags for that user', 404);
        }

        $newStatus = $this->status !== '' ? $this->status : $row->status;
        if (!in_array($newStatus, self::STATUSES, true)) {
            return JsonResponse::badRequest('invalid status');
        }

        // Was `ban` present in the body at all? Absent ban leaves the account's
        // active flag untouched; an explicit `ban:false` reinstates it.
        $banProvided = array_key_exists('ban', $this->request->body ?? []);

        // An explicit `ban` flag WINS over the status-derived ban — otherwise a
        // reinstate (`ban:false`, no status) reads the row's current 'banned'
        // status and re-bans itself. Only fall back to the status when `ban`
        // wasn't sent (e.g. setting status:'banned' also deactivates).
        $shouldBan = $banProvided ? ($this->ban === true) : ($newStatus === 'banned');
        if ($shouldBan) {
            $newStatus = 'banned';
        } elseif ($newStatus === 'banned') {
            // Not banning, but the (fallback) status is still 'banned' — an
            // explicit reinstate with no new status. Move it off 'banned'.
            $newStatus = 'cleared';
        }
        $reinstated = !$shouldBan && $banProvided && $this->ban === false;

        if ($shouldBan || $reinstated) {
            $user = User::find($this->userId);
            if ($user instanceof User) {
                $user->active = !$shouldBan; // ban → inactive, reinstate → active
                $user->save();
            }
        }

        $row->status = $newStatus;
        $row->save();

        return JsonResponse::ok([
            'user_id' => $row->user_id,
            'status' => $row->status,
            'banned' => $shouldBan,
            'reinstated' => $reinstated,
        ]);
    }

    /** Mark a single flag event reviewed/unreviewed; the event must belong to {userId}. */
    private function reviewEvent(): JsonResponse
    {
        $event = UserFlag::find($this->eventId);
        if (!$event instanceof UserFlag || $event->user_id !== $this->userId) {
            return JsonResponse::error('flag event not found for that user', 404);
        }

        $event->reviewed = $this->reviewed;
        $event->save();

        return JsonResponse::ok([
            'id' => $event->id,
            'user_id' => $event->user_id,
            'reviewed' => $event->reviewed,
        ]);
    }

    private function list(): JsonResponse
    {
        $sort = in_array($this->sort, self::SORTS, true) ? $this->sort : 'last_flagged_at';
        $dir = strtolower($this->dir) === 'asc' ? 'asc' : 'desc';

        $q = FlaggedUser::query();
        if ($this->status !== '' && in_array($this->status, self::STATUSES, true)) {
            $q = $q->where('status', '=', $this->status);
        }

        // total_flags orders in the DB (severity is only a page-local tie-break,
        // applied in PHP below). top_severity has no numeric column, so the DB
        // orders by recency and PHP re-orders the page by severity rank. Default
        // is last_flagged_at desc — the freshest suspicion at the top (unchanged).
        if ($sort === 'total_flags') {
            $q = $q->orderBy('total_flags', $dir)->orderByDesc('last_flagged_at');
        } else {
            $q = $q->orderBy('last_flagged_at', $dir);
        }

        $paged = $q->paginate(max(1, $this->page), self::PER_PAGE, self::PER_PAGE, withTotal: true);

        /** @var list<FlaggedUser> $rows */
        $rows = $paged->data;

        // Page-local severity ordering (no suspicion-score column exists): map
        // top_severity low/med/high → 0/1/2 and refine the page in memory.
        if ($sort === 'total_flags' || $sort === 'top_severity') {
            usort($rows, function (FlaggedUser $a, FlaggedUser $b) use ($sort): int {
                $rankA = self::SEVERITY_RANK[$a->top_severity] ?? 0;
                $rankB = self::SEVERITY_RANK[$b->top_severity] ?? 0;
                if ($sort === 'total_flags') {
                    return [$b->total_flags, $rankB] <=> [$a->total_flags, $rankA];
                }

                return [$rankB, strtotime((string) $b->last_flagged_at)]
                    <=> [$rankA, strtotime((string) $a->last_flagged_at)];
            });
            if ($dir === 'asc') {
                $rows = array_reverse($rows);
            }
        }

        $titles = User::titleMapFor(array_map(static fn (FlaggedUser $f): string => $f->user_id, $rows));

        $out = array_map(static fn (FlaggedUser $f): array => [
            'user_id' => $f->user_id,
            'user_name' => $f->user_name,
            'user_title' => $titles[$f->user_id] ?? null,
            'total_flags' => $f->total_flags,
            'counts' => $f->getCounts(),
            'status' => $f->status,
            'top_severity' => $f->top_severity,
            'last_category' => $f->last_category,
            'first_flagged_at' => $f->first_flagged_at,
            'last_flagged_at' => $f->last_flagged_at,
        ], $rows);

        return JsonResponse::ok([
            'flagged' => $out,
            'page' => $paged->page,
            'perPage' => $paged->perPage,
            'total' => $paged->total,
        ]);
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

        $title = User::titleMapFor([$row->user_id])[$row->user_id] ?? null;

        return JsonResponse::ok([
            'user_id' => $row->user_id,
            'user_name' => $row->user_name,
            'user_title' => $title,
            'total_flags' => $row->total_flags,
            'counts' => $row->getCounts(),
            'status' => $row->status,
            'top_severity' => $row->top_severity,
            'first_flagged_at' => $row->first_flagged_at,
            'last_flagged_at' => $row->last_flagged_at,
            'events' => $eventRows,
        ]);
    }
}
