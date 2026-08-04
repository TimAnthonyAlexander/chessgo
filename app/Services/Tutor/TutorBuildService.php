<?php

namespace App\Services\Tutor;

use App\Models\Game;
use App\Models\TutorReport;
use App\Models\TutorBaseline;
use App\Models\User;
use App\Services\GameAnalysisService;
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
 *
 * The engine work a build may do is bounded for the report as a whole
 * (ANALYSIS_BUDGET), split across the player's categories in proportion to
 * how much they play each one, with a floor under every one of them. Games
 * that are already analyzed are measured for free and never draw on that
 * budget — see allocateAnalysisBudget() and sample().
 */
class TutorBuildService
{
    /**
     * Games one report may send to the ENGINE, across every category combined.
     *
     * This is a budget, not a cap, and the distinction is the whole point. The
     * old ANALYSIS_CAP was 150 games PER CATEGORY, so a player active in
     * bullet, blitz, rapid and classical could ask for 600 analyses in one
     * build. That was survivable only while every finished rated game was
     * eagerly precomputed. It no longer is: games with a bot on either side
     * are not precomputed any more (GameResultController::shouldEagerlyAnalyze()),
     * and those are ~91% of rated games on prod, so a bot-heavy player's first
     * report now analyzes most of its sample on demand.
     *
     * The arithmetic, at 3-6 seconds per game analyzed:
     *
     *   old, per category:  4 x 150 = 600 games  =>  30-60 minutes
     *   new, total:               150 games      =>   7.5-15 minutes
     *
     * and 150 is the WORST case — a player with 150+ never-analyzed games
     * spread across their categories. Anything already analyzed is served from
     * game.analysis and costs no engine time at all, so it does not draw on
     * this budget (see sample()). A player whose games are all cached still
     * gets every one of them measured; the budget only bounds the fresh work.
     *
     * Two real measurements on the same account (63 bullet + 20 blitz games,
     * 12-month window, local dev box), because 3-6s is the WARM number and the
     * gap matters when reading the arithmetic above:
     *
     *   first build:  15 fresh + 68 cached  =>  314s   (~21s per fresh game)
     *   rebuild:       0 fresh + 83 cached  =>    0.2s (2.4ms per cached game)
     *
     * The rebuild is the important one: it is the same report, byte for byte,
     * for free. It confirms the thing this budget is built on — a cached game
     * costs a JSON decode, so charging it against the budget would be charging
     * for nothing.
     *
     * The 21s was per-position movetime x plies with a cold eval cache (a
     * 2000-rated bullet player's games run 60-100 plies) — and it was measured
     * while the build analyzed games strictly one at a time. It no longer does:
     * warmAnalyses() below sends the whole sample through
     * GameAnalysisService::analyzeMany(), which keeps `engine.analysis_concurrency`
     * (3) full-game analyses in flight instead of one, because the engine has
     * six independent search groups and a serial caller leaves five idle. The
     * same 83-fresh-game cold build measured 864s serial and 332s concurrent
     * (2.6x), same report either way; the numbers are in
     * docs/tasks/open/tutor.md. Per-position movetime is not a lever — the
     * engine clamps /analyze-game to a 100ms floor.
     *
     * So do not "fix" a slow build by quietly shrinking this number until the
     * sample stops meaning anything, and do not raise the concurrency to soak
     * up the whole pool either: live play leases from the same six groups, and
     * at 6 a bot move waits seconds.
     *
     * 150 rather than a rounder 100: below ~30 fresh games a category's numbers
     * start moving on single games, and with the per-category floor below, 150
     * is the smallest total that still leaves a meaningful proportional share
     * after four floors are paid. Higher than 150 buys precision the peer
     * comparison cannot use — the baselines' own cells are the noisier side of
     * that comparison — at a wall clock that starts competing with live play
     * for the engine's search pool, which it must never win.
     *
     * Deliberately a bound on ENGINE work, not on games measured: the report
     * still says "based on 140 of your 380 blitz games" via capHit, and a
     * cached game makes that number bigger for free.
     */
    public const int ANALYSIS_BUDGET = 150;

    /**
     * Fresh analyses every qualifying category gets before the rest of the
     * budget is split proportionally.
     *
     * Without a floor, one dominant category eats the budget and a category
     * the player plays occasionally is measured on whatever happened to be
     * cached — possibly nothing. That is worse than not reporting on it,
     * because the report would still print a verdict.
     *
     * It equals MIN_GAMES on purpose: MIN_GAMES is the point at which we are
     * willing to say anything about a category at all, so the floor is exactly
     * enough engine time to measure that minimum from scratch. Four categories
     * at 20 is 80 of the 150, leaving 70 to distribute by how much the player
     * actually plays each one. A category never gets more floor than it needs
     * (a category with 3 uncached games draws 3), and if the floors ever
     * exceeded the budget they are scaled down rather than overrunning it.
     */
    public const int ANALYSIS_FLOOR = 20;

    /** A category needs this many games in the window to say anything. */
    public const int MIN_GAMES = 20;

    /**
     * A DIMENSION comparison — one opening, one phase, one piece — needs at
     * least this many of the player's OWN games behind it before it is shown
     * at all. This is separate from, and much stricter in spirit than,
     * MIN_GAMES: MIN_GAMES gates whether a whole CATEGORY (e.g. blitz) is
     * worth reporting on; this gates whether one SLICE within an
     * already-qualifying category is. A player can easily have 60 qualifying
     * blitz games and have played the Caro-Kann only once or twice.
     *
     * The importance formula's sqrt(sample * weight) term already discounts a
     * thin sample when RANKING comparisons, but it does not stop a thin
     * sample from being PRINTED — and a report that renders "much worse at
     * the Caro-Kann Defense, n=1" has already done the damage, because a
     * reader remembers the verdict, not the sample size printed beside it.
     * This is exactly the failure named in docs/tasks/open/tutor.md's "How
     * this goes wrong" section: "a confident number from twelve games... the
     * real defence is the minimum-games gate."
     *
     * 4 is the floor because it is the smallest sample where a result stops
     * being explainable by a single fluke: with 1-3 games, one bad pairing or
     * one time-scramble loss can single-handedly produce "much worse" on its
     * own; at 4 you need at least two separate below-average results to reach
     * the same verdict, which is a much weaker claim to make about noise.
     * Openings are the dimension this matters most for (a player might see a
     * given opening only a handful of times per window even in a category
     * with plenty of games), so the floor is picked for openings and applied
     * uniformly to phase/piece too, where samples are typically far larger
     * anyway (phases and pieces occur on nearly every move of every game).
     *
     * Sample semantics: for every dimension key the sample counted here is
     * GAMES, not moves — see TutorMetrics::aggregate(), which counts one
     * entry per perGame() call regardless of dimension (opening, phase, and
     * piece dimensions are each emitted at most once per game). `weight` is
     * the move/game-outcome weight used for importance ranking, and is NOT
     * what this gate reads.
     */
    public const int MIN_DIMENSION_GAMES = 4;

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
        // Used only to warm the sample's analyses concurrently before the
        // reader runs — the reader still owns every read of them.
        private readonly GameAnalysisService $analysis,
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
        $skipped = 0;
        $capHit = false;

        // Two passes: the engine budget is a property of the WHOLE report, so
        // every qualifying category has to be known before any of them is
        // measured.
        $eligible = [];

        foreach (self::CATEGORIES as $category) {
            $games = $this->gamesFor($report, $category);
            $considered += count($games);

            if (count($games) < self::MIN_GAMES) {
                if ($games !== []) {
                    $insufficient[$category] = ['games' => count($games), 'need' => self::MIN_GAMES];
                }

                continue;
            }

            $eligible[$category] = $games;
        }

        $allocation = self::allocateAnalysisBudget($this->demandFor($eligible));

        $sampledByCategory = [];
        foreach ($eligible as $category => $games) {
            $sampled = $this->sample($games, $allocation[$category] ?? 0);
            if (count($sampled) < count($games)) {
                $capHit = true;
            }

            $sampledByCategory[$category] = $sampled;
        }

        // Read BEFORE any engine work: both the warm pass and the reader store
        // the analysis they compute back on the row, so afterwards every game
        // looks cached. This is also what the allocator's `uncached` counts, so
        // `analyzed` and the budget stay the same measure.
        $hadAnalysis = [];
        foreach ($sampledByCategory as $sampled) {
            foreach ($sampled as $game) {
                $hadAnalysis[$game->id] = self::isAnalyzed($game);
            }
        }

        $this->warmAnalyses($sampledByCategory);

        foreach ($sampledByCategory as $category => $sampled) {
            $measured = [];
            $normalized = [];

            foreach ($sampled as $game) {
                $normal = $this->reader->read($game, $user->id);
                if ($normal === null) {
                    // The reader already logged why. Count it, so the report
                    // can say "110 of 151, 41 unreadable" instead of leaving
                    // the reader to assume the sample was capped.
                    $skipped++;

                    continue;
                }

                if (($hadAnalysis[$game->id] ?? false) === false) {
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
                count($eligible[$category]),
            );
        }

        $report->games_considered = $considered;
        $report->games_used = $used;
        $report->games_analyzed = $analyzed;
        $report->games_skipped = $skipped;
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
                'gamesConsidered' => $considered,
                'gamesUsed' => $used,
                'gamesSkipped' => $skipped,
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
            // Carried in the payload as well as on the row so a rendered
            // report can account for every game it sampled: considered, used,
            // and the ones that could not be read at all.
            'gamesConsidered' => $considered,
            'gamesUsed' => $used,
            'gamesSkipped' => $skipped,
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
            [$metric, $dimension] = $this->metrics->splitKey($composite);

            // Plain metrics are already covered by the category's MIN_GAMES
            // gate above. Dimension slices (opening/phase/piece) get their
            // own, stricter gate — see MIN_DIMENSION_GAMES's docblock.
            if (!$this->dimensionSampleGate($dimension, (int) ($mine['sample'] ?? 0))) {
                continue;
            }

            $cell = $peer['cells'][$composite] ?? null;
            if ($cell === null || ($cell['sample'] ?? 0) < TutorBaseline::MIN_SAMPLE) {
                continue;
            }

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
     * Whether a comparison has enough of the player's OWN games behind it to
     * be shown. Plain metrics (empty dimension) always pass — they were
     * already filtered by the category-level MIN_GAMES gate before
     * buildCategory() is even called. A non-empty dimension (opening, phase,
     * or piece) additionally needs MIN_DIMENSION_GAMES of the player's own
     * games, or it is dropped rather than rendered as a confident finding.
     */
    private function dimensionSampleGate(string $dimension, int $sample): bool
    {
        return $dimension === '' || $sample >= self::MIN_DIMENSION_GAMES;
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
     * What each qualifying category is asking of the report, for the
     * allocator: how much of the player's chess happens there (`total`), and
     * how many of those games would need the engine (`uncached`).
     *
     * @param array<string, list<Game>> $eligible
     * @return array<string, array{total: int, uncached: int}>
     */
    private function demandFor(array $eligible): array
    {
        $demand = [];

        foreach ($eligible as $category => $games) {
            $uncached = 0;
            foreach ($games as $game) {
                if (!self::isAnalyzed($game)) {
                    $uncached++;
                }
            }

            $demand[$category] = ['total' => count($games), 'uncached' => $uncached];
        }

        return $demand;
    }

    /**
     * Split the report's engine budget across its categories in proportion to
     * how much the player actually plays each one, with a floor under every
     * one of them.
     *
     * Pure: array in, array out, no clock and no randomness, so it can be
     * tested directly (tests/Unit/TutorBudgetAllocatorTest.php).
     *
     * The rules, in order:
     *
     *  1. If every category's fresh games fit in the budget, nobody is cut.
     *     This is the common case — most players have one or two active
     *     categories, and cached games are already excluded from `uncached`.
     *  2. Otherwise every category is paid its ANALYSIS_FLOOR first (or its
     *     whole need, if that is smaller). A category the player visits rarely
     *     gets measured rather than starved to zero by a dominant one.
     *  3. The remainder goes out one analysis at a time to whichever hungry
     *     category has the highest volume-per-analysis-so-far — the standard
     *     highest-averages (D'Hondt) split. It converges on shares
     *     proportional to `total`, it can never overshoot the budget by a
     *     rounding remainder the way a multiply-and-round split can, and it
     *     automatically re-routes what a category cannot use (a category with
     *     8 fresh games takes 8 and the rest flows elsewhere).
     *
     * Weighted by `total`, not by `uncached`: the question the split answers
     * is "where does this player's chess happen", and a category that is
     * mostly cached has not stopped being their main time control. Its own
     * `uncached` still bounds what it can take.
     *
     * Keys are optional in the signature only so a malformed entry degrades to
     * zero demand instead of a fatal; demandFor() always fills both.
     *
     * @param array<string, array{total?: int, uncached?: int}> $demand
     * @return array<string, int> Fresh analyses granted, per category.
     */
    public static function allocateAnalysisBudget(
        array $demand,
        int $budget = self::ANALYSIS_BUDGET,
        int $floor = self::ANALYSIS_FLOOR,
    ): array {
        $need = [];
        $volume = [];

        foreach ($demand as $category => $entry) {
            $need[$category] = max(0, (int) ($entry['uncached'] ?? 0));
            // max(1, ...) so a category can never have zero weight and stall
            // the loop below; a qualifying category always has games anyway.
            $volume[$category] = max(1, (int) ($entry['total'] ?? 0));
        }

        if ($need === []) {
            return [];
        }

        $budget = max(0, $budget);

        // Everything fits: no allocation to do, and nobody is capped.
        if (array_sum($need) <= $budget) {
            return $need;
        }

        // The floor can never be allowed to write a cheque the budget cannot
        // cover — with a small budget and many categories, share it evenly.
        $floor = max(0, min($floor, intdiv($budget, count($need))));

        $alloc = [];
        foreach ($need as $category => $n) {
            $alloc[$category] = min($n, $floor);
        }

        $remaining = $budget - array_sum($alloc);

        while ($remaining > 0) {
            $pick = null;
            $best = -1.0;

            foreach ($need as $category => $n) {
                if ($alloc[$category] >= $n) {
                    continue;
                }

                $quotient = $volume[$category] / ($alloc[$category] + 1);
                if ($quotient > $best) {
                    $best = $quotient;
                    $pick = $category;
                }
            }

            if ($pick === null) {
                break; // every category has all it can use
            }

            $alloc[$pick]++;
            $remaining--;
        }

        return $alloc;
    }

    /**
     * Analyze every sampled game that still needs it, CONCURRENTLY, before any
     * of them is read.
     *
     * This is the whole of the speed-up, and it is purely a matter of ordering.
     * TutorGameReader::read() asks GameAnalysisService for one game's analysis
     * and blocks until the engine answers; a build that reads 150 games in a
     * loop therefore holds exactly ONE of the engine's six search groups busy
     * and leaves five idle for 30-50 minutes. Warming the whole sample first
     * puts several of those calls in flight together, and read() then finds
     * everything cached and does no engine work at all.
     *
     * Nothing downstream changes. The warm pass and read() go through the same
     * GameAnalysisService cache check, so the reader's behaviour is identical
     * whether it was warmed or not — a warmed game is just a cache hit, exactly
     * as a game already reviewed on the analysis board is. A game the warm pass
     * could not analyze is left alone: read() retries it serially and, if that
     * fails too, logs and drops it, precisely as before.
     *
     * Failures never propagate — a report is still worth building from the
     * games that did analyze.
     *
     * @param array<string, list<Game>> $sampledByCategory
     */
    private function warmAnalyses(array $sampledByCategory): void
    {
        $games = [];
        foreach ($sampledByCategory as $sampled) {
            foreach ($sampled as $game) {
                // A game can be sampled by only one category (games carry one
                // category), but analyzeMany() dedupes by id regardless.
                $games[$game->id] = $game;
            }
        }

        if ($games === []) {
            return;
        }

        try {
            $this->analysis->analyzeMany($games);
        } catch (Throwable $e) {
            // The per-game failures are already handled inside analyzeMany();
            // this only catches a total engine outage, which read() will meet
            // again game by game and report properly.
            error_log('[tutor] concurrent analysis warm-up failed: ' . $e->getMessage());
        }
    }

    /** Does this game already carry a cached analysis? */
    private static function isAnalyzed(Game $game): bool
    {
        return ($game->analysis ?? '') !== '';
    }

    /**
     * The games to measure in one category: every game whose analysis is
     * already cached, plus a uniform random draw from the rest, up to this
     * category's share of the report's engine budget.
     *
     * The sampling rule is unchanged where it matters. Which uncached games
     * get measured is decided by a uniform random draw across the whole
     * window — NOT the most recent N, which would make a six-month report a
     * snapshot of this week, and NOT ranked by anything the player controls.
     *
     * What is new is that a cached game is free: TutorGameReader::read() reads
     * game.analysis and never touches the engine, so measuring it costs a JSON
     * decode. Charging those against the budget would spend the report's
     * engine time on games that need none, and would shrink the sample for no
     * reason. So the budget bounds only the games that need the engine.
     *
     * The honest caveat, since this is the anti-bias property in
     * docs/tasks/open/tutor.md: taking every cached game does mean a game the
     * player chose to analyze is certain to be in the sample while an uncached
     * one is only likely to be. That is a far weaker version of the bias
     * Lichess has (their sample is *mostly* what the user chose to look at),
     * it only bites at all once a category's uncached games exceed its
     * allocation, and the alternative — throwing away free measurements to
     * keep the sample perfectly uniform — buys symmetry with a smaller,
     * noisier sample. Nothing here selects FOR analyzed games; they are simply
     * never selected against.
     *
     * Returns games in the original newest-first order, so gameRows() reads
     * chronologically.
     *
     * @param list<Game> $games
     * @return list<Game>
     */
    private function sample(array $games, int $analysisBudget): array
    {
        $keep = [];
        $fresh = [];

        foreach ($games as $i => $game) {
            if (self::isAnalyzed($game)) {
                $keep[$i] = true;
            } else {
                $fresh[$i] = $game;
            }
        }

        if (count($fresh) > $analysisBudget) {
            $fresh = $analysisBudget < 1 ? [] : $this->pickAtRandom($fresh, $analysisBudget);
        }

        foreach (array_keys($fresh) as $i) {
            $keep[$i] = true;
        }

        ksort($keep);

        return array_values(array_intersect_key($games, $keep));
    }

    /**
     * A uniform random subset of $n entries, original keys preserved.
     *
     * @param array<int, Game> $games
     * @return array<int, Game>
     */
    private function pickAtRandom(array $games, int $n): array
    {
        $keys = array_rand($games, $n);
        if (!is_array($keys)) {
            $keys = [$keys];
        }

        return array_intersect_key($games, array_flip($keys));
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
