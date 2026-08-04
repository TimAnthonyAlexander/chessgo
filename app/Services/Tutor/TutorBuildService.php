<?php

namespace App\Services\Tutor;

use App\Models\Game;
use App\Models\TutorReport;
use App\Models\TutorBaseline;
use App\Models\User;
use App\Services\NotificationService;
use BaseApi\App;
use Throwable;

/**
 * Builds one Tutor report.
 *
 * The order of operations matters and is deliberate:
 *   1. pick the games — by rule, never by what the user chose to look at
 *   2. measure them   — reusing cached analysis wherever it already exists
 *   3. compare        — against the peer band, with the tier recorded
 *   4. rank           — so the page leads with the one thing worth fixing
 *   5. collect drills — so every weakness ends in something to do
 *
 * Step 1 is the one that differs most from Lichess's. Theirs measures whatever
 * analysis happens to exist plus a hundred fresh ones, which means the sample
 * is skewed by which games the player found interesting enough to analyze —
 * their lead dev conceded this in the beta thread. Ours samples uniformly at
 * random across the window, so a player cannot bias their own report.
 */
class TutorBuildService
{
    /** Games analyzed per report per category, at most. */
    public const int ANALYSIS_CAP = 150;

    /** A category needs this many games in the window to say anything. */
    public const int MIN_GAMES = 20;

    /** How many strengths and weaknesses lead the report. */
    public const int HIGHLIGHTS = 3;

    /** Payload shape version, so a stored report can be read safely after the
     *  shape changes. */
    public const int VERSION = 1;

    /** Categories a report covers. Variants get their own sub-report or none;
     *  they are never folded into standard numbers. */
    public const array CATEGORIES = ['bullet', 'blitz', 'rapid', 'classical'];

    public function __construct(
        private readonly TutorGameReader $reader,
        private readonly TutorMetrics $metrics,
        private readonly TutorGrade $grade,
        private readonly TutorBaselineReader $baselines,
        private readonly TutorDrillBuilder $drills,
        private readonly TutorThemeProfile $themes,
        private readonly NotificationService $notifications,
    ) {}

    /**
     * Build the report in place. Never throws: a failure is recorded on the
     * row so the user sees "this didn't work" instead of a report that
     * silently never arrives.
     */
    public function build(TutorReport $report): void
    {
        $report->status = 'building';
        $report->save();

        try {
            $this->run($report);
        } catch (Throwable $e) {
            $report->status = 'failed';
            $report->error = substr($e->getMessage(), 0, 2000);
            $report->built_at = date('Y-m-d H:i:s');
            $report->save();

            error_log('[tutor] build failed for report ' . $report->id . ': ' . $e->getMessage());
        }
    }

    private function run(TutorReport $report): void
    {
        $user = User::find($report->user_id);
        if (!$user instanceof User) {
            throw new \RuntimeException('user not found');
        }

        $source = $this->baselines->activeSource();

        $categories = [];
        $insufficient = [];
        $considered = 0;
        $used = 0;
        $analyzed = 0;
        $capHit = false;

        foreach (self::CATEGORIES as $category) {
            $games = $this->gamesFor($report, $category);
            $considered += count($games);

            if (count($games) < self::MIN_GAMES) {
                if ($games !== []) {
                    $insufficient[$category] = ['games' => count($games), 'need' => self::MIN_GAMES];
                }

                continue;
            }

            $sampled = $this->sample($games, self::ANALYSIS_CAP);
            if (count($sampled) < count($games)) {
                $capHit = true;
            }

            $measured = [];
            $normalized = [];

            foreach ($sampled as $game) {
                $hadAnalysis = ($game->analysis ?? '') !== '';

                $normal = $this->reader->read($game, $user->id);
                if ($normal === null) {
                    continue;
                }

                if (!$hadAnalysis) {
                    $analyzed++;
                }

                $normalized[] = $normal;
                $measured[] = $this->metrics->perGame($normal);
            }

            if ($measured === []) {
                continue;
            }

            $used += count($measured);

            $categories[$category] = $this->buildCategory(
                $category,
                $user,
                $source,
                $measured,
                $normalized,
                count($games),
            );
        }

        $report->games_considered = $considered;
        $report->games_used = $used;
        $report->games_analyzed = $analyzed;
        $report->cap_hit = $capHit;

        if ($categories === []) {
            $report->status = 'insufficient';
            $report->built_at = date('Y-m-d H:i:s');
            $report->setPayload([
                'version' => self::VERSION,
                'headline' => null,
                'categories' => [],
                'insufficient' => $insufficient,
                'minGames' => self::MIN_GAMES,
            ]);
            $report->save();

            $this->notify($report, 'tutor_insufficient', [
                'reportId' => $report->id,
                'minGames' => self::MIN_GAMES,
            ]);

            return;
        }

        $payload = [
            'version' => self::VERSION,
            'baselineSource' => $source,
            // Puzzle themes are a player-level fact, not a per-category one —
            // the puzzle pool has no time control.
            'themeProfile' => $this->themes->forUser($user),
            'generatedAt' => date('c'),
            'rangeFrom' => $report->range_from,
            'rangeTo' => $report->range_to,
            'categories' => $categories,
            'insufficient' => $insufficient,
            'minGames' => self::MIN_GAMES,
        ];

        $payload['headline'] = $this->headline($categories);

        $report->setPayload($payload);
        $report->status = 'ready';
        $report->built_at = date('Y-m-d H:i:s');
        $report->save();

        $this->notify($report, 'tutor_ready', [
            'reportId' => $report->id,
            'games' => $used,
            'headline' => $payload['headline']['text'] ?? null,
        ]);
    }

    /**
     * One category's sub-report.
     *
     * @param list<array<string, mixed>> $measured
     * @param list<array<string, mixed>> $normalized
     * @return array<string, mixed>
     */
    private function buildCategory(
        string $category,
        User $user,
        string $source,
        array $measured,
        array $normalized,
        int $available,
    ): array {
        $aggregate = $this->metrics->aggregate($measured);

        // The peer band comes from the rating the player actually PLAYED AT
        // across the window, not from their rating right now. Someone who
        // gained 200 points over six months has no single current band that
        // describes those games, and comparing all of them against their
        // present strength would flatter or punish them for improving.
        $ratings = [];
        foreach ($normalized as $game) {
            if (is_numeric($game['myRating'] ?? null) && (int) $game['myRating'] > 0) {
                $ratings[] = (int) $game['myRating'];
            }
        }

        $ratingField = 'rating_' . $category;
        $currentRating = (int) ($user->{$ratingField} ?? 1500);
        $rating = $ratings === [] ? $currentRating : (int) round(array_sum($ratings) / count($ratings));

        $peer = $this->baselines->forRating($source, $category, $rating);

        $comparisons = [];
        foreach ($aggregate as $composite => $mine) {
            $cell = $peer['cells'][$composite] ?? null;
            if ($cell === null || ($cell['sample'] ?? 0) < TutorBaseline::MIN_SAMPLE) {
                continue;
            }

            [$metric, $dimension] = $this->metrics->splitKey($composite);
            $comparisons[] = $this->grade->compare($metric, $dimension, $mine, $cell);
        }

        // Only plain metrics compete for the headline. A single weak opening
        // is a real finding but it is not "the thing to fix" ahead of a broken
        // conversion rate, and letting dimensions into the ranking floods it.
        $headlinePool = array_values(array_filter(
            $comparisons,
            fn(array $c): bool => $c['dimension'] === '',
        ));

        $ranked = $this->grade->rank($headlinePool, self::HIGHLIGHTS);

        return [
            'category' => $category,
            'rating' => $rating,
            'currentRating' => $currentRating,
            'games' => count($measured),
            'gamesAvailable' => $available,
            'capHit' => count($measured) < $available,
            'peer' => [
                'tier' => $peer['tier'],
                'bandFrom' => $peer['bandFrom'],
                'bandTo' => $peer['bandTo'],
                'source' => $source,
            ],
            'metrics' => $this->presentMetrics($aggregate),
            'comparisons' => $comparisons,
            'strengths' => $ranked['strengths'],
            'weaknesses' => $ranked['weaknesses'],
            'phases' => $this->dimensionSlice($comparisons, 'phase'),
            'pieces' => $this->dimensionSlice($comparisons, 'piece'),
            'openings' => $this->openingSlice($comparisons),
            'gameRows' => $this->gameRows($normalized, $measured),
            'drills' => $this->drills->forCategory($ranked['weaknesses'], $normalized, $user),
        ];
    }

    /**
     * Opening comparisons, split by the colour they were played with and
     * grouped by family. The same opening is a different problem from each
     * side — you choose it as White and you are answering it as Black — so
     * merging them hides the thing a repertoire fix depends on.
     *
     * @param list<array<string, mixed>> $comparisons
     * @return array{w: list<array<string, mixed>>, b: list<array<string, mixed>>}
     */
    private function openingSlice(array $comparisons): array
    {
        $out = ['w' => [], 'b' => []];

        foreach ($comparisons as $comparison) {
            $dimension = (string) $comparison['dimension'];
            if (!str_starts_with($dimension, 'opening:')) {
                continue;
            }

            // 'opening:w:Sicilian Defense'
            $rest = substr($dimension, strlen('opening:'));
            $colour = substr($rest, 0, 1);
            if (!isset($out[$colour]) || substr($rest, 1, 1) !== ':') {
                continue;
            }

            $comparison['name'] = substr($rest, 2);
            $comparison['color'] = $colour;
            $out[$colour][] = $comparison;
        }

        foreach ($out as $colour => $list) {
            usort($list, fn(array $a, array $b): int => $b['sample'] <=> $a['sample']);
            $out[$colour] = $list;
        }

        return $out;
    }

    /**
     * A compact row per measured game.
     *
     * This is what makes the opening drilldown and the "show me the games"
     * drills possible without re-reading and re-analyzing everything, and it
     * lets the report show its own working — a player can see exactly which
     * games produced a number rather than being asked to trust it.
     *
     * @param list<array<string, mixed>> $normalized
     * @param list<array<string, mixed>> $measured
     * @return list<array<string, mixed>>
     */
    private function gameRows(array $normalized, array $measured): array
    {
        $rows = [];

        foreach ($normalized as $i => $game) {
            $metrics = $measured[$i]['metrics'] ?? [];

            $rows[] = [
                'gameId' => (string) ($game['hubGameId'] ?? $game['id'] ?? ''),
                'playedAt' => $game['playedAt'] ?? null,
                'color' => $game['color'] ?? 'w',
                'opening' => $game['opening'] ?? '',
                'result' => $game['result'] ?? '',
                'reason' => $game['reason'] ?? '',
                'myRating' => $game['myRating'] ?? null,
                'oppRating' => $game['oppRating'] ?? null,
                'accuracy' => isset($metrics['accuracy']) ? round((float) $metrics['accuracy']['value'], 1) : null,
                'acpl' => isset($metrics['acpl']) ? round((float) $metrics['acpl']['value'], 1) : null,
                'moves' => $measured[$i]['moves'] ?? 0,
            ];
        }

        return $rows;
    }

    /**
     * Plain metrics, rounded for display, sample size attached. Every number
     * the UI shows carries its own evidence.
     *
     * @param array<string, array<string, mixed>> $aggregate
     * @return array<string, array<string, mixed>>
     */
    private function presentMetrics(array $aggregate): array
    {
        $out = [];

        foreach ($aggregate as $composite => $entry) {
            [$metric, $dimension] = $this->metrics->splitKey($composite);
            if ($dimension !== '') {
                continue;
            }

            $def = TutorMetrics::METRICS[$metric] ?? null;

            $out[$metric] = [
                'value' => round((float) $entry['value'], 2),
                'sample' => (int) $entry['sample'],
                'label' => $def['label'] ?? $metric,
                'unit' => $def['unit'] ?? 'percent',
                'higherIsBetter' => $def['higherIsBetter'] ?? true,
            ];
        }

        return $out;
    }

    /**
     * All comparisons in one dimension family, best first.
     *
     * @param list<array<string, mixed>> $comparisons
     * @return list<array<string, mixed>>
     */
    private function dimensionSlice(array $comparisons, string $family): array
    {
        $prefix = $family . ':';

        $slice = array_values(array_filter(
            $comparisons,
            fn(array $c): bool => str_starts_with((string) $c['dimension'], $prefix),
        ));

        usort($slice, fn(array $a, array $b): int => $b['importance'] <=> $a['importance']);

        foreach ($slice as $i => $entry) {
            $slice[$i]['name'] = substr((string) $entry['dimension'], strlen($prefix));
        }

        return $slice;
    }

    /**
     * The one sentence at the top. It names the weakest thing across the
     * categories the player actually plays, weighted by how much they play
     * them — a disastrous classical conversion rate over 20 games should not
     * outrank a bad blitz habit over 300.
     *
     * @param array<string, array<string, mixed>> $categories
     * @return array<string, mixed>|null
     */
    private function headline(array $categories): ?array
    {
        $best = null;

        foreach ($categories as $category => $report) {
            $weakest = $report['weaknesses'][0] ?? null;
            if ($weakest === null) {
                continue;
            }

            // More games played in a category = more of the player's chess.
            $volume = sqrt(max(1, (int) $report['games']));
            $score = abs((float) $weakest['importance']) * $volume;

            if ($best === null || $score > $best['score']) {
                $best = [
                    'score' => $score,
                    'category' => $category,
                    'comparison' => $weakest,
                ];
            }
        }

        if ($best === null) {
            return null;
        }

        $c = $best['comparison'];

        return [
            'category' => $best['category'],
            'metric' => $c['metric'],
            'text' => sprintf(
                'Your biggest leak in %s: %s is %s than other players at your rating.',
                $best['category'],
                strtolower((string) $c['label']),
                (string) $c['wording'],
            ),
            'mine' => $c['mine'],
            'peer' => $c['peer'],
            'sample' => $c['sample'],
        ];
    }

    /**
     * Eligible games for one category, newest first.
     *
     * Filters are deliberate: finished games only, this category only (so a
     * Duck game can never leak into a blitz accuracy figure — Lichess shipped
     * exactly that bug), and standard-rules variants only, since accuracy
     * against a Crazyhouse engine means nothing next to a standard baseline.
     *
     * @return list<Game>
     */
    private function gamesFor(TutorReport $report, string $category): array
    {
        $userId = $report->user_id;

        $rows = Game::query()
            ->whereGroup(function ($g) use ($userId): void {
                $g->where('white_user_id', '=', $userId)->orWhere('black_user_id', '=', $userId);
            })
            ->where('category', '=', $category)
            ->where('created_at', '>=', $report->range_from)
            ->where('created_at', '<=', $report->range_to)
            ->orderByDesc('created_at')
            ->limit(2000)
            ->get();

        return array_values(array_filter(
            $rows,
            // Chess960 shares the time-control category with standard games,
            // so it would otherwise land in the same bucket — but it starts
            // from a shuffled position, which makes its opening dimension
            // meaningless and its early-game accuracy incomparable to a
            // standard-chess baseline. Excluded rather than silently folded in.
            fn(Game $g): bool => in_array($g->variant, ['standard', ''], true)
                && $g->result !== ''
                && $g->ply >= 10,
        ));
    }

    /**
     * Uniform random sample across the whole window.
     *
     * NOT the most recent N, and not the ones the player happened to analyze.
     * Taking the newest N would make a report a snapshot of this week rather
     * than of the window it claims to cover; taking analyzed ones reproduces
     * Lichess's selection bias.
     *
     * @param list<Game> $games
     * @return list<Game>
     */
    private function sample(array $games, int $cap): array
    {
        if (count($games) <= $cap) {
            return $games;
        }

        $keys = array_rand($games, $cap);
        if (!is_array($keys)) {
            $keys = [$keys];
        }

        $out = [];
        foreach ($keys as $key) {
            $out[] = $games[$key];
        }

        return $out;
    }

    /** @param array<string, mixed> $payload */
    private function notify(TutorReport $report, string $type, array $payload): void
    {
        try {
            $this->notifications->push($report->user_id, $type, $payload);
        } catch (Throwable $e) {
            error_log('[tutor] notification failed: ' . $e->getMessage());
        }
    }
}
