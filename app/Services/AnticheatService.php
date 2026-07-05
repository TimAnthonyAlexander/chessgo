<?php

namespace App\Services;

use Throwable;
use BaseApi\Logger;
use App\Models\Game;
use App\Models\User;
use App\Models\UserFlag;
use App\Models\FlaggedUser;

/**
 * Anti-cheat harness (SPEC §Anti-cheat). Detection signals call in here to raise
 * a flag; nothing here ever bans. Every flag writes an append-only UserFlag event
 * AND upserts the per-user FlaggedUser rollup an admin reviews. Autobans are
 * deliberately out of scope — statistics establish suspicion, a human decides
 * (the Lichess/Regan model: flag → human review, never model → ban).
 *
 * Signals implemented (all share the same flag()/rollup plumbing):
 *   - analysis_during_game     : engine-analysis endpoint hit while in a live game (real-time).
 *   - rating_velocity          : provisional-phase / over-performance blowouts (on game finish, cheap).
 *   - move_time_anomaly        : robotically uniform think-times (on game finish, cheap).
 *   - engine_correlation       : low ACPL + high top-1 match vs rating band (out-of-band scan, engine).
 *   - accuracy_rating_mismatch : accuracy far above the player's rating band (out-of-band scan, engine).
 *
 * Two design invariants from the research (Lichess/Chess.com/Regan):
 *   1. Never auto-ban — only flag. Per-game noise is huge, so flags are meant to
 *      ACCUMULATE in the rollup; a sustained pattern is what an admin acts on.
 *   2. A flag must NEVER break or delay the flagged request, nor tip the user off.
 *      Every public method swallows its own errors.
 */
class AnticheatService
{
    /** Engine-analysis endpoint called while the caller is in a live game. */
    public const CAT_ANALYSIS_DURING_GAME = 'analysis_during_game';

    /** Implausible rating gain / provisional-phase over-performance. */
    public const CAT_RATING_VELOCITY = 'rating_velocity';

    /** Robotically uniform / difficulty-uncorrelated move times. */
    public const CAT_MOVE_TIME_ANOMALY = 'move_time_anomaly';

    /** Low ACPL + high engine top-1 match for the player's rating band. */
    public const CAT_ENGINE_CORRELATION = 'engine_correlation';

    /** Game accuracy far above what the player's rating predicts. */
    public const CAT_ACCURACY_RATING_MISMATCH = 'accuracy_rating_mismatch';

    /** Severity ranking, low→high, for FlaggedUser::top_severity. */
    private const SEVERITY_RANK = ['low' => 0, 'medium' => 1, 'high' => 2];

    public function __construct(
        private readonly HubClient $hub,
        private readonly Logger $logger,
        private readonly GameAnalysisService $analysis,
    ) {
    }

    // ── Signal 1: analysis during a live game (real-time) ──────────────────────

    /**
     * A user hitting an engine-analysis endpoint (AnalyzeController /
     * SfAnalyzeController) WHILE they have a live game is using the site's own
     * engine on a game in progress — a strong tell.
     *
     * No-op for anonymous callers and admins. When the analyzed board IS the
     * user's live board it escalates to 'high' (near-zero false positive); merely
     * being in *a* game while analyzing is 'medium'.
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
            $this->logger->error('anticheat checkAnalysisDuringGame failed: ' . $e->getMessage());
        }
    }

    // ── On game finish: the CHEAP signals (no engine calls) ────────────────────

    /**
     * Post-game review for the two cheap signals — rating_velocity and
     * move_time_anomaly. Called inline from GameResultController (best-effort;
     * never fails the persist). The expensive engine pass runs out-of-band via
     * {@see scanEngineCorrelation()} / scripts/anticheat_scan.php.
     */
    public function reviewFinishedGame(Game $game, ?User $white, ?User $black): void
    {
        try {
            $this->reviewSide($game, $white, 'w');
            $this->reviewSide($game, $black, 'b');
        } catch (Throwable $e) {
            $this->logger->error('anticheat reviewFinishedGame failed: ' . $e->getMessage());
        }
    }

    private function reviewSide(Game $game, ?User $user, string $side): void
    {
        if (!$user instanceof User) {
            return; // anonymous / bot side — nothing to flag
        }
        $isBot = $side === 'w' ? $game->white_is_bot : $game->black_is_bot;
        if ($isBot) {
            return;
        }

        $this->checkRatingVelocity($game, $user, $side);
        $this->checkMoveTimeAnomaly($game, $user, $side);
    }

    /**
     * rating_velocity: winning against materially stronger opposition — especially
     * while the rating is still provisional (RD > 110) — is the classic
     * smurf/engine pattern. One game is weak evidence, so these are low/medium and
     * meant to accumulate in the rollup.
     */
    private function checkRatingVelocity(Game $game, User $user, string $side): void
    {
        if (!$game->rated) {
            return;
        }
        $won = ($side === 'w' && $game->result === '1-0') || ($side === 'b' && $game->result === '0-1');
        if (!$won) {
            return;
        }

        $cat = $game->category;
        if (!in_array($cat, ['bullet', 'blitz', 'rapid', 'classical', 'duck'], true)) {
            return;
        }

        $before = (int) ($side === 'w' ? $game->white_rating_before : $game->black_rating_before);
        $oppBefore = (int) ($side === 'w' ? $game->black_rating_before : $game->white_rating_before);
        if ($before <= 0 || $oppBefore <= 0) {
            return;
        }

        $gap = $oppBefore - $before; // how much stronger the beaten opponent was
        $provisional = (float) $user->{'rd_' . $cat} > 110.0;

        // Thresholds: a provisional account beating a clearly stronger opponent is
        // more suspicious than an established one doing the same.
        if ($provisional && $gap >= 150) {
            $this->flag(
                (string) $user->id,
                (string) $user->name,
                self::CAT_RATING_VELOCITY,
                $gap >= 350 ? 'medium' : 'low',
                sprintf('Provisional %s account (rating %d) beat a +%d opponent', $cat, $before, $gap),
                ['category' => $cat, 'rating_before' => $before, 'opp_rating' => $oppBefore, 'gap' => $gap, 'provisional' => true, 'game_id' => $game->hub_game_id],
            );
        } elseif (!$provisional && $gap >= 400) {
            $this->flag(
                (string) $user->id,
                (string) $user->name,
                self::CAT_RATING_VELOCITY,
                'low',
                sprintf('%s account (rating %d) beat a +%d opponent', $cat, $before, $gap),
                ['category' => $cat, 'rating_before' => $before, 'opp_rating' => $oppBefore, 'gap' => $gap, 'provisional' => false, 'game_id' => $game->hub_game_id],
            );
        }
    }

    /**
     * move_time_anomaly: engine users tend to spend near-uniform time per move,
     * where humans spend more on hard positions and less on obvious ones. Low
     * coefficient of variation over a decent sample of multi-second moves is a
     * (weak, corroborating) tell — kept at low/medium and gated to avoid firing on
     * legitimately fast/uniform bullet play.
     */
    private function checkMoveTimeAnomaly(Game $game, User $user, string $side): void
    {
        $times = $game->getMoveTimes();
        if ($times === []) {
            return; // pre-capture game / not recorded
        }

        // The side's own moves: white plays plies 0,2,4…; black plays 1,3,5…. Drop
        // the opening move (often a premove / book blitz — not a think).
        $own = [];
        $start = $side === 'w' ? 0 : 1;
        for ($i = $start; $i < count($times); $i += 2) {
            $own[] = (int) $times[$i];
        }
        if (count($own) > 1) {
            array_shift($own);
        }
        if (count($own) < 15) {
            return; // too few moves for the statistic to mean anything
        }

        $mean = array_sum($own) / count($own);
        if ($mean < 1000.0) {
            return; // fast play (bullet / premoving) — timing signal is unreliable here
        }

        $variance = 0.0;
        foreach ($own as $t) {
            $variance += ($t - $mean) ** 2;
        }
        $variance /= count($own);
        $cv = sqrt($variance) / $mean; // coefficient of variation

        if ($cv < 0.35) {
            $this->flag(
                (string) $user->id,
                (string) $user->name,
                self::CAT_MOVE_TIME_ANOMALY,
                $cv < 0.20 ? 'medium' : 'low',
                sprintf('Uniform move times over %d moves (CV %.2f, mean %dms)', count($own), $cv, (int) round($mean)),
                ['moves' => count($own), 'cv' => round($cv, 3), 'mean_ms' => (int) round($mean), 'game_id' => $game->hub_game_id],
            );
        }
    }

    // ── Out-of-band: the EXPENSIVE engine-correlation scan ─────────────────────

    /**
     * Full engine review of one finished game — the strongest but costliest
     * signal (a whole-game engine pass). Run by scripts/anticheat_scan.php, NOT
     * inline. Ensures the cached GameAnalysisService pass exists, then for each
     * registered non-bot side compares observed ACPL / accuracy / top-1 match
     * against a rating-band expectation and flags engine_correlation and/or
     * accuracy_rating_mismatch. Marks the game scanned (idempotent).
     *
     * @return list<array<string, mixed>> the flags raised (or, in dry-run, that
     *   WOULD be raised) — each {user_id, user_name, category, severity, detail,
     *   meta}. Empty when the game is skipped or nothing tripped.
     */
    public function scanEngineCorrelation(Game $game, bool $dryRun = false): array
    {
        try {
            if ($game->ac_scanned && !$dryRun) {
                return [];
            }
            // Only standard/duck rated games with a registered human are worth the
            // engine cost; Chess960 isn't analyzable and unrated/bot games don't matter.
            if (!$game->rated || ($game->variant !== '' && $game->variant !== 'standard' && $game->variant !== 'duck')) {
                if (!$dryRun) {
                    $game->ac_scanned = true;
                    $game->save();
                }
                return [];
            }

            $payload = $this->analysis->analyze($game); // cached after first pass
            $summary = is_array($payload['summary'] ?? null) ? $payload['summary'] : [];
            $plies = is_array($payload['plies'] ?? null) ? $payload['plies'] : [];

            $whiteUser = $game->white_user_id !== null && !$game->white_is_bot ? User::find($game->white_user_id) : null;
            $blackUser = $game->black_user_id !== null && !$game->black_is_bot ? User::find($game->black_user_id) : null;

            $candidates = [];
            if ($whiteUser instanceof User) {
                $candidates = array_merge($candidates, $this->scoreSide($game, $whiteUser, 'w', $summary['w'] ?? [], $plies));
            }
            if ($blackUser instanceof User) {
                $candidates = array_merge($candidates, $this->scoreSide($game, $blackUser, 'b', $summary['b'] ?? [], $plies));
            }

            if (!$dryRun) {
                foreach ($candidates as $c) {
                    $this->flag($c['user_id'], $c['user_name'], $c['category'], $c['severity'], $c['detail'], $c['meta']);
                }
                $game->ac_scanned = true;
                $game->save();
            }

            return $candidates;
        } catch (Throwable $e) {
            $this->logger->error('anticheat scanEngineCorrelation failed for ' . $game->hub_game_id . ': ' . $e->getMessage());
            return [];
        }
    }

    /**
     * Score one side of an analyzed game against its rating band, returning the
     * candidate flags (so the caller can apply or preview them).
     *
     * @param array<string, mixed> $sideSummary GameAnalysisService per-color summary (acpl, accuracy…).
     * @param list<array<string, mixed>> $plies    Per-ply nodes (for the top-1 match rate).
     * @return list<array<string, mixed>>
     */
    private function scoreSide(Game $game, User $user, string $side, array $sideSummary, array $plies): array
    {
        $ownMoves = $this->countOwnMoves($plies, $side);
        if ($ownMoves < 20) {
            return []; // short game — move-quality stats are too noisy to trust
        }

        $rating = (int) $user->{'rating_' . $game->category};
        $acpl = (int) ($sideSummary['acpl'] ?? 999);
        $accuracy = (float) ($sideSummary['accuracy'] ?? 0.0);
        $t1 = $this->topOneMatchRate($plies, $side);
        $out = [];

        // engine_correlation: ACPL well below band expectation AND a high share of
        // moves matching the engine's #1. Both together (not either alone) — a
        // strong player can post low ACPL, and forced lines inflate match rate.
        $expAcpl = $this->expectedAcpl($rating);
        if ($acpl <= (int) round($expAcpl * 0.5) && $t1 >= 0.60) {
            $severe = $acpl <= (int) round($expAcpl * 0.33) && $t1 >= 0.72;
            $out[] = [
                'user_id' => (string) $user->id,
                'user_name' => (string) $user->name,
                'category' => self::CAT_ENGINE_CORRELATION,
                'severity' => $severe ? 'high' : 'medium',
                'detail' => sprintf('ACPL %d (band expects ~%d) with %d%% top-1 match over %d moves', $acpl, $expAcpl, (int) round($t1 * 100), $ownMoves),
                'meta' => ['rating' => $rating, 'acpl' => $acpl, 'expected_acpl' => $expAcpl, 't1_match' => round($t1, 3), 'own_moves' => $ownMoves, 'game_id' => $game->hub_game_id],
            ];
        }

        // accuracy_rating_mismatch: the rating-normalized headline — playing far
        // above the accuracy the player's rating predicts.
        $expAcc = $this->expectedAccuracy($rating);
        $accGap = $accuracy - $expAcc;
        if ($accGap >= 12.0) {
            $out[] = [
                'user_id' => (string) $user->id,
                'user_name' => (string) $user->name,
                'category' => self::CAT_ACCURACY_RATING_MISMATCH,
                'severity' => $accGap >= 20.0 ? 'high' : 'medium',
                'detail' => sprintf('%.1f%% accuracy vs ~%.0f%% expected for rating %d (+%.1f)', $accuracy, $expAcc, $rating, $accGap),
                'meta' => ['rating' => $rating, 'accuracy' => $accuracy, 'expected_accuracy' => $expAcc, 'gap' => round($accGap, 1), 'own_moves' => $ownMoves, 'game_id' => $game->hub_game_id],
            ];
        }

        return $out;
    }

    /** Count a side's own moves in the analyzed plies. */
    private function countOwnMoves(array $plies, string $side): int
    {
        $n = 0;
        foreach ($plies as $node) {
            $move = $node['move'] ?? null;
            if (is_array($move) && ($move['color'] ?? '') === $side) {
                $n++;
            }
        }

        return $n;
    }

    /** Share of a side's own moves that matched the engine's top-1 choice (0..1). */
    private function topOneMatchRate(array $plies, string $side): float
    {
        $moves = 0;
        $best = 0;
        foreach ($plies as $node) {
            $move = $node['move'] ?? null;
            if (!is_array($move) || ($move['color'] ?? '') !== $side) {
                continue;
            }
            $moves++;
            if (($move['isBest'] ?? false) === true) {
                $best++;
            }
        }

        return $moves > 0 ? $best / $moves : 0.0;
    }

    /**
     * Rough expected average centipawn loss for a rating band (monotonic ↓ with
     * strength; club ~50-90, strong GM ~15-25 per the ACPL research). Heuristic +
     * deliberately tunable — a human reviews every flag it helps raise.
     */
    private function expectedAcpl(int $rating): int
    {
        return match (true) {
            $rating < 1000 => 90,
            $rating < 1400 => 65,
            $rating < 1800 => 48,
            $rating < 2200 => 35,
            $rating < 2500 => 25,
            default => 18,
        };
    }

    /** Rough expected accuracy% for a rating band (monotonic ↑). Tunable. */
    private function expectedAccuracy(int $rating): float
    {
        return match (true) {
            $rating < 1000 => 55.0,
            $rating < 1400 => 65.0,
            $rating < 1800 => 72.0,
            $rating < 2200 => 78.0,
            $rating < 2500 => 84.0,
            default => 88.0,
        };
    }

    // ── Shared write path + helpers ────────────────────────────────────────────

    /**
     * Record one flag event and fold it into the user's rollup. Public so every
     * signal reuses the exact same write path. Best-effort: on any failure it logs
     * and returns (a lost flag never breaks the request that triggered it).
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
     * True when two FENs describe the same position to move — piece placement plus
     * side to move (the first two FEN fields). Castling/ep/clocks are ignored:
     * analyzing the identical board with the same side on move is the tell, and
     * clock counters routinely differ between the client's FEN and the hub's. An
     * empty/garbage FEN never matches.
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
