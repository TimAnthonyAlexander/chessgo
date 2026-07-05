<?php

namespace App\Services;

use Throwable;
use BaseApi\Logger;
use App\Models\UserFlag;
use App\Models\FlaggedUser;

/**
 * Anti-cheat harness (SPEC §Anti-cheat). Detection signals call in here to raise
 * a flag; nothing here ever bans. Every flag writes an append-only UserFlag event
 * AND upserts the per-user FlaggedUser rollup an admin reviews. Autobans are
 * deliberately out of scope — statistics establish suspicion, a human decides
 * (the Lichess/Regan model: flag → human review, never model → ban).
 *
 * Category catalogue (only the first is wired today; the rest are the researched
 * roadmap — see docs/open_tasks — and share this same flag()/rollup plumbing):
 *   - analysis_during_game : engine-analysis endpoint hit while in a live game.
 *   - engine_correlation   : per-user top-1 match / ACPL vs rating band.
 *   - move_time_anomaly    : low-variance / difficulty-uncorrelated think times.
 *   - rating_velocity      : implausible rating gain / provisional blowouts.
 *
 * The one hard rule: a flag must NEVER break or delay the flagged request, and
 * must never tip the user off. Callers invoke this fire-and-forget; every public
 * method swallows its own errors.
 */
class AnticheatService
{
    /** Engine-analysis endpoint called while the caller is in a live game. */
    public const CAT_ANALYSIS_DURING_GAME = 'analysis_during_game';

    /** Severity ranking, low→high, for FlaggedUser::top_severity. */
    private const SEVERITY_RANK = ['low' => 0, 'medium' => 1, 'high' => 2];

    public function __construct(
        private readonly HubClient $hub,
        private readonly Logger $logger,
    ) {
    }

    /**
     * The requested signal: a user hitting an engine-analysis endpoint
     * (AnalyzeController / SfAnalyzeController) WHILE they have a live game is
     * using the site's own engine on a game in progress — a strong tell.
     *
     * No-op for anonymous callers (no account to flag) and admins. When the
     * analyzed board IS the user's live board it escalates to 'high' (near-zero
     * false positive); merely being in *a* game while analyzing is 'medium'.
     *
     * @param array<string, mixed>|null $user Resolved account (jsonSerialize shape), or null if anonymous.
     */
    public function checkAnalysisDuringGame(?array $user, string $analyzedFen, string $endpoint): void
    {
        try {
            if (!is_array($user) || empty($user['id'])) {
                return; // anonymous — nothing to flag
            }
            if (($user['role'] ?? '') === 'admin') {
                return; // admins run the eval bar / arrows legitimately
            }

            $userId = (string) $user['id'];
            $probe = $this->hub->livePlayer($userId);
            if (!($probe['live'] ?? false)) {
                return; // not in a live game — legitimate analysis-board use
            }

            $exact = $this->boardsMatch($analyzedFen, (string) ($probe['fen'] ?? ''));
            $this->flag(
                $userId,
                (string) ($user['name'] ?? ''),
                self::CAT_ANALYSIS_DURING_GAME,
                $exact ? 'high' : 'medium',
                $exact
                    ? sprintf('Called %s on the exact position of their live game', $endpoint)
                    : sprintf('Called %s while in a live game', $endpoint),
                [
                    'endpoint' => $endpoint,
                    'analyzed_fen' => $analyzedFen,
                    'live_fen' => (string) ($probe['fen'] ?? ''),
                    'exact_match' => $exact,
                ],
            );
        } catch (Throwable $e) {
            // Must never surface to the caller or tip off the user.
            $this->logger->error('anticheat checkAnalysisDuringGame failed: ' . $e->getMessage());
        }
    }

    /**
     * Record one flag event and fold it into the user's rollup. Public so future
     * signals reuse the exact same write path. Best-effort: on any failure it
     * logs and returns (a lost flag never breaks the request that triggered it).
     *
     * @param array<string, mixed> $meta JSON-shaped context for the audit trail.
     */
    public function flag(
        string $userId,
        string $userName,
        string $category,
        string $severity,
        string $detail,
        array $meta = [],
    ): void {
        try {
            if ($userId === '') {
                return;
            }
            $severity = isset(self::SEVERITY_RANK[$severity]) ? $severity : 'medium';

            $event = new UserFlag();
            $event->user_id = $userId;
            $event->category = $category;
            $event->severity = $severity;
            $event->detail = $detail;
            $event->setMeta($meta);
            $event->save();

            $this->rollup($userId, $userName, $category, $severity);
        } catch (Throwable $e) {
            $this->logger->error('anticheat flag failed: ' . $e->getMessage());
        }
    }

    /**
     * Upsert the FlaggedUser summary: bump the total, the per-category count, the
     * running max severity, and the last-seen stamps. First flag creates the row
     * with status 'open' (awaiting admin review).
     */
    private function rollup(string $userId, string $userName, string $category, string $severity): void
    {
        $now = date('c');
        $row = FlaggedUser::firstWhere('user_id', '=', $userId);

        if (!$row instanceof FlaggedUser) {
            $row = new FlaggedUser();
            $row->user_id = $userId;
            $row->status = 'open';
            $row->first_flagged_at = $now;
            $row->top_severity = 'low';
            $row->total_flags = 0;
        }

        // Keep the denormalized name fresh (cheap; helps the admin list).
        if ($userName !== '') {
            $row->user_name = $userName;
        }

        $counts = $row->getCounts();
        $counts[$category] = (int) ($counts[$category] ?? 0) + 1;
        $row->setCounts($counts);

        $row->total_flags += 1;
        $row->last_category = $category;
        $row->last_flagged_at = $now;

        if (self::SEVERITY_RANK[$severity] > (self::SEVERITY_RANK[$row->top_severity] ?? 0)) {
            $row->top_severity = $severity;
        }

        $row->save();
    }

    /**
     * True when two FENs describe the same position to move — piece placement
     * plus side to move (the first two FEN fields). Castling/ep/clocks are
     * ignored: analyzing the identical board with the same side on move is the
     * tell, and clock counters routinely differ between the client's FEN and the
     * hub's. An empty/garbage FEN never matches.
     */
    private function boardsMatch(string $a, string $b): bool
    {
        $ka = $this->boardKey($a);
        $kb = $this->boardKey($b);

        return $ka !== '' && $ka === $kb;
    }

    /** Placement + active-color key ("<placement> <stm>"), or '' if malformed. */
    private function boardKey(string $fen): string
    {
        $parts = preg_split('/\s+/', trim($fen));
        if (!is_array($parts) || count($parts) < 2 || $parts[0] === '') {
            return '';
        }

        $stm = strtolower($parts[1]);
        if ($stm !== 'w' && $stm !== 'b') {
            return '';
        }

        return $parts[0] . ' ' . $stm;
    }
}
