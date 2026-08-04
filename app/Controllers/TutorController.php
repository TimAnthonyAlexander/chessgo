<?php

namespace App\Controllers;

use App\Jobs\TutorReportJob;
use App\Models\Game;
use App\Models\TutorReport;
use App\Models\User;
use App\Services\Tutor\TutorBuildService;
use BaseApi\Controllers\Controller;
use BaseApi\Http\JsonResponse;

/**
 * The Tutor report shelf: list what you've got, ask for a new one.
 *
 * GET  /tutor/reports  → your reports, newest first, plus whether you can
 *                        request another and (if not) exactly why.
 * POST /tutor/reports  → queue a build. Returns the queued row immediately.
 *
 * JSON, not HTML. Lichess built theirs as server-rendered pages, which is why
 * Tutor cannot exist in their mobile app at all; ours is an API first and the
 * web page is just its first client.
 */
class TutorController extends Controller
{
    /** Requested window: '1m' | '3m' | '6m' | '12m'. */
    public string $range = '6m';

    /** How many reports a user may build per day. */
    private const int DAILY_LIMIT = 3;

    /** @var array<string, string> */
    private const array RANGES = [
        '1m' => '-1 month',
        '3m' => '-3 months',
        '6m' => '-6 months',
        '12m' => '-12 months',
    ];

    public function __construct(private readonly TutorBuildService $builder) {}

    public function get(): JsonResponse
    {
        $user = $this->currentUser();
        if (!$user instanceof User) {
            return JsonResponse::unauthorized('Sign in to use Tutor.');
        }

        $reports = TutorReport::query()
            ->where('user_id', '=', $user->id)
            ->orderByDesc('created_at')
            ->limit(50)
            ->get();

        $rows = array_map(fn(TutorReport $r): array => $r->summaryRow(), $reports);

        return JsonResponse::ok([
            'reports' => $rows,
            'eligibility' => $this->eligibility($user, $reports),
            'ranges' => array_keys(self::RANGES),
            'minGames' => TutorBuildService::MIN_GAMES,
        ]);
    }

    public function post(): JsonResponse
    {
        $user = $this->currentUser();
        if (!$user instanceof User) {
            return JsonResponse::unauthorized('Sign in to use Tutor.');
        }

        $this->validate(['range' => 'string']);

        $range = isset(self::RANGES[$this->range]) ? $this->range : '6m';

        $existing = TutorReport::query()
            ->where('user_id', '=', $user->id)
            ->orderByDesc('created_at')
            ->limit(50)
            ->get();

        $eligibility = $this->eligibility($user, $existing);
        if (!$eligibility['canRequest']) {
            return JsonResponse::badRequest($eligibility['reason'] ?? 'You cannot request a report right now.');
        }

        $report = new TutorReport();
        $report->user_id = $user->id;
        $report->range_label = $range;
        $report->range_from = date('Y-m-d H:i:s', strtotime(self::RANGES[$range]));
        $report->range_to = date('Y-m-d H:i:s');
        $report->status = 'queued';
        $report->save();

        dispatch(new TutorReportJob($report->id));

        return JsonResponse::created(['report' => $report->summaryRow()]);
    }

    /**
     * Whether a new report is worth building, and if not, a reason a human can
     * act on.
     *
     * A bare cooldown timer with no explanation is one of the loudest
     * complaints about Lichess's version — people hit a dead button and could
     * not tell whether it was broken, rate-limited, or pointless. So this
     * always answers in terms of what the user can DO: play more games, or
     * come back tomorrow.
     *
     * @param list<TutorReport> $reports
     * @return array{canRequest: bool, reason: string|null, newGames: int, usedToday: int, dailyLimit: int}
     */
    private function eligibility(User $user, array $reports): array
    {
        $dailyLimit = self::DAILY_LIMIT;
        $since = date('Y-m-d H:i:s', strtotime('-24 hours'));

        $usedToday = 0;
        $pending = false;
        $last = null;

        foreach ($reports as $report) {
            if (($report->created_at ?? '') >= $since) {
                $usedToday++;
            }

            if (in_array($report->status, ['queued', 'building'], true)) {
                $pending = true;
            }

            if ($last === null && in_array($report->status, ['ready', 'insufficient'], true)) {
                $last = $report;
            }
        }

        $base = ['newGames' => 0, 'usedToday' => $usedToday, 'dailyLimit' => $dailyLimit];

        if ($pending) {
            return $base + ['canRequest' => false, 'reason' => 'A report is already being built. It will be ready shortly.'];
        }

        if ($usedToday >= $dailyLimit) {
            return $base + ['canRequest' => false, 'reason' => sprintf(
                'You have built %d reports today. You can build another tomorrow.',
                $usedToday,
            )];
        }

        // Nothing new to say is a better reason to withhold a report than a
        // timer, and it tells the player what to do about it.
        $newGames = $last === null ? $this->gameCount($user, null) : $this->gameCount($user, $last->created_at);

        $base['newGames'] = $newGames;

        if ($last !== null && $newGames < 5) {
            return $base + ['canRequest' => false, 'reason' => sprintf(
                'No new games since your last report%s. Play a few more and come back.',
                $newGames > 0 ? sprintf(' (%d so far)', $newGames) : '',
            )];
        }

        if ($last === null && $newGames < TutorBuildService::MIN_GAMES) {
            return $base + ['canRequest' => false, 'reason' => sprintf(
                'Tutor needs at least %d games in one time control. You have %d.',
                TutorBuildService::MIN_GAMES,
                $newGames,
            )];
        }

        return $base + ['canRequest' => true, 'reason' => null];
    }

    private function gameCount(User $user, ?string $since): int
    {
        $query = Game::query()->whereGroup(function ($g) use ($user): void {
            $g->where('white_user_id', '=', $user->id)->orWhere('black_user_id', '=', $user->id);
        });

        if ($since !== null && $since !== '') {
            $query->where('created_at', '>', $since);
        }

        return $query->count();
    }

    private function currentUser(): ?User
    {
        $u = $this->request->user ?? null;
        if (!is_array($u) || empty($u['id'])) {
            return null;
        }

        $found = User::find((string) $u['id']);

        return $found instanceof User ? $found : null;
    }
}
