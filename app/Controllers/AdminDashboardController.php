<?php

namespace App\Controllers;

use Throwable;
use BaseApi\Controllers\Controller;
use BaseApi\Http\JsonResponse;
use App\Controllers\Concerns\AdminGuard;
use App\Models\User;
use App\Models\Game;
use App\Models\UserFlag;
use App\Models\FlaggedUser;
use App\Services\AnticheatService;
use App\Services\HubClient;

/**
 * Admin dashboard aggregate reads (Wave 1). Cheap COUNT queries over the core
 * tables plus a best-effort live-lobby probe. Admin-gated via {@see AdminGuard}.
 *
 *   GET /admin/dashboard
 *
 * Every number is a straight COUNT (no blobs loaded). The anti-cheat status /
 * category buckets are derived from the SAME constants the detection + review
 * code uses (AdminFlagsController::STATUSES, AnticheatService::CAT_*), so this
 * never drifts from the real vocabulary. The live block reuses StatsController's
 * hub approach and degrades to zeros if the hub is unreachable.
 */
class AdminDashboardController extends Controller
{
    use AdminGuard;

    public function __construct(private readonly HubClient $hub)
    {
    }

    public function get(): JsonResponse
    {
        if ($denied = $this->requireAdmin($this->request)) {
            return $denied;
        }

        return JsonResponse::ok([
            'users' => $this->users(),
            'games' => $this->games(),
            'anticheat' => $this->anticheat(),
            'live' => $this->live(),
        ]);
    }

    /** @return array<string, int> */
    private function users(): array
    {
        $sevenDaysAgo = date('Y-m-d H:i:s', strtotime('-7 days'));

        return [
            'total' => User::query()->count(),
            'admins' => User::query()->where('role', '=', 'admin')->count(),
            'active' => User::query()->where('active', '=', true)->count(),
            'banned' => User::query()->where('active', '=', false)->count(),
            'new_7d' => User::query()->where('created_at', '>=', $sevenDaysAgo)->count(),
        ];
    }

    /** @return array<string, int> */
    private function games(): array
    {
        return [
            'total' => Game::query()->count(),
            'rated' => Game::query()->where('rated', '=', true)->count(),
            'scanned' => Game::query()->where('ac_scanned', '=', true)->count(),
            'unscanned' => Game::query()->where('ac_scanned', '=', false)->count(),
        ];
    }

    /** @return array<string, mixed> */
    private function anticheat(): array
    {
        $byStatus = [];
        foreach (AdminFlagsController::STATUSES as $status) {
            $byStatus[$status] = FlaggedUser::query()->where('status', '=', $status)->count();
        }

        $byCategory = [];
        foreach (self::CATEGORIES as $category) {
            $byCategory[$category] = UserFlag::query()->where('category', '=', $category)->count();
        }

        return [
            'flagged_users_total' => FlaggedUser::query()->count(),
            'by_status' => $byStatus,
            'flag_events_total' => UserFlag::query()->count(),
            'events_by_category' => $byCategory,
        ];
    }

    /** @return array{players_online: int, active_games: int} */
    private function live(): array
    {
        try {
            $stats = $this->hub->stats();

            return [
                'players_online' => (int) ($stats['playersOnline'] ?? 0),
                'active_games' => (int) ($stats['activeGames'] ?? 0),
            ];
        } catch (Throwable) {
            return ['players_online' => 0, 'active_games' => 0];
        }
    }

    /**
     * The detection signals, in the exact CAT_* vocabulary AnticheatService
     * writes onto UserFlag.category — so the bucket keys always match the data.
     *
     * @var list<string>
     */
    private const CATEGORIES = [
        AnticheatService::CAT_ANALYSIS_DURING_GAME,
        AnticheatService::CAT_RATING_VELOCITY,
        AnticheatService::CAT_MOVE_TIME_ANOMALY,
        AnticheatService::CAT_ENGINE_CORRELATION,
        AnticheatService::CAT_ACCURACY_RATING_MISMATCH,
    ];
}
