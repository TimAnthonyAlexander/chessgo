<?php

namespace App\Controllers;

use BaseApi\Controllers\Controller;
use BaseApi\Http\JsonResponse;
use App\Controllers\Concerns\AdminGuard;
use App\Models\User;
use App\Models\Game;
use App\Models\FlaggedUser;

/**
 * Admin user directory (Wave 1). Admin-gated via {@see AdminGuard}.
 *
 *   GET /admin/users        → filtered, sorted, paginated list (25/page)
 *   GET /admin/users/{id}   → one account (full, password-stripped) + flag rollup
 *                             + recent games
 *
 * The list is deliberately N+1-free: it pages the accounts in one query, then
 * pulls every FlaggedUser rollup for that page's ids in a single whereIn and
 * merges in memory. Passwords are never emitted — the detail view serializes the
 * User via its own jsonSerialize() (which strips the hash), and the list builds
 * an explicit row.
 */
class AdminUsersController extends Controller
{
    use AdminGuard;

    private const PER_PAGE = 25;

    /** Columns a caller may sort by (anything else falls back to created_at). */
    private const SORTS = [
        'created_at',
        'name',
        'rating_bullet',
        'rating_blitz',
        'rating_rapid',
        'rating_classical',
    ];

    /** Bound from path {id} on the detail route (empty on the list route). */
    public string $id = '';

    /** ?q= LIKE match on name OR email. */
    public string $q = '';

    /** ?page= (1-based). */
    public int $page = 1;

    /** ?sort= (whitelisted) / ?dir= (asc|desc). */
    public string $sort = 'created_at';

    public string $dir = 'desc';

    /** ?role= (user|admin) / ?status= (active|banned). */
    public string $role = '';

    public string $status = '';

    public function get(): JsonResponse
    {
        if ($denied = $this->requireAdmin($this->request)) {
            return $denied;
        }

        return $this->id !== '' ? $this->show($this->id) : $this->list();
    }

    private function list(): JsonResponse
    {
        $sort = in_array($this->sort, self::SORTS, true) ? $this->sort : 'created_at';
        $dir = strtolower($this->dir) === 'asc' ? 'asc' : 'desc';

        $query = User::query();

        $q = trim($this->q);
        if ($q !== '') {
            $like = '%' . $q . '%';
            $query->whereGroup(function ($g) use ($like): void {
                $g->where('name', 'LIKE', $like)->orWhere('email', 'LIKE', $like);
            });
        }

        if ($this->role === 'user' || $this->role === 'admin') {
            $query->where('role', '=', $this->role);
        }

        if ($this->status === 'active') {
            $query->where('active', '=', true);
        } elseif ($this->status === 'banned') {
            $query->where('active', '=', false);
        }

        $paged = $query
            ->orderBy($sort, $dir)
            ->paginate(max(1, $this->page), self::PER_PAGE, self::PER_PAGE, withTotal: true);

        /** @var list<User> $users */
        $users = $paged->data;

        // One rollup query for the whole page (no N+1) → merge in memory.
        $ids = array_map(static fn (User $u): string => (string) $u->id, $users);
        $flagMap = [];
        if ($ids !== []) {
            foreach (FlaggedUser::query()->whereIn('user_id', $ids)->get() as $f) {
                $flagMap[$f->user_id] = $f;
            }
        }

        $rows = array_map(function (User $u) use ($flagMap): array {
            $flag = $flagMap[(string) $u->id] ?? null;
            $flagged = $flag instanceof FlaggedUser;

            return [
                'id' => $u->id,
                'name' => $u->name,
                'title' => $u->displayTitle(),
                'email' => $u->email,
                'role' => $u->role,
                'active' => $u->active,
                'created_at' => $u->created_at,
                'rating_bullet' => $u->rating_bullet,
                'rating_blitz' => $u->rating_blitz,
                'rating_rapid' => $u->rating_rapid,
                'rating_classical' => $u->rating_classical,
                'games_bullet' => $u->games_bullet,
                'games_blitz' => $u->games_blitz,
                'games_rapid' => $u->games_rapid,
                'games_classical' => $u->games_classical,
                'flagged' => $flagged,
                'flag_status' => $flagged ? $flag->status : null,
                'total_flags' => $flagged ? $flag->total_flags : 0,
            ];
        }, $users);

        return JsonResponse::ok([
            'users' => $rows,
            'page' => $paged->page,
            'perPage' => $paged->perPage,
            'total' => $paged->total,
        ]);
    }

    private function show(string $id): JsonResponse
    {
        $user = User::find($id);
        if (!$user instanceof User) {
            return JsonResponse::notFound('user not found');
        }

        $rollup = FlaggedUser::firstWhere('user_id', '=', $id);

        $games = Game::query()
            ->whereGroup(function ($g) use ($id): void {
                $g->where('white_user_id', '=', $id)->orWhere('black_user_id', '=', $id);
            })
            ->orderByDesc('created_at')
            ->limit(20)
            ->get();

        $recent = Game::summaryRowsWithTitles($games);

        return JsonResponse::ok([
            'user' => $user->jsonSerialize(), // strips the password hash
            'flag_rollup' => $rollup instanceof FlaggedUser ? [
                'user_id' => $rollup->user_id,
                'user_name' => $rollup->user_name,
                'user_title' => $user->displayTitle(),
                'total_flags' => $rollup->total_flags,
                'counts' => $rollup->getCounts(),
                'status' => $rollup->status,
                'top_severity' => $rollup->top_severity,
                'last_category' => $rollup->last_category,
                'first_flagged_at' => $rollup->first_flagged_at,
                'last_flagged_at' => $rollup->last_flagged_at,
            ] : null,
            'recent_games' => $recent,
        ]);
    }
}
