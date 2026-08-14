<?php

namespace App\Services\Tutor;

use App\Services\EngineEval;

/**
 * The metric definitions. This is the single source of truth for what every
 * Tutor number MEANS, and it is deliberately the only place either corpus is
 * measured.
 *
 * Two very different producers feed this class:
 *   1. A user's own games, evaluated by zugzwang via /analyze-game.
 *   2. The public Lichess database dump, which ships %eval annotations.
 * They must be measured identically or the peer comparison is meaningless —
 * so both are normalized into the same per-ply shape (see perGame()) and run
 * through this one implementation. Nothing here calls an engine, touches the
 * database, or knows where its input came from.
 *
 * ON CP-LOSS. A move's cost is the eval DELTA across it — the position before
 * versus the position after, from the mover's point of view — not "best move
 * versus played move". That choice is deliberate: a delta needs only per-
 * position evals, which both corpora have, whereas a best-move comparison
 * needs a principal variation, which the Lichess dump does not carry. Defining
 * it this way makes the two corpora directly comparable, and reduces the
 * engine difference between them to a question of scale rather than a
 * difference in kind. See docs/tasks/open/tutor.md.
 *
 * Note this differs slightly from GameAnalysisService::cpLoss(), which does
 * compare against the best achievable line. That service drives the per-game
 * analysis board, where "you missed this specific better move" is the point.
 * Here the point is comparability across two corpora, so the definitions
 * differ on purpose rather than by accident.
 */
class TutorMetrics
{
    /** Mate scores are folded to a large finite centipawn value, as elsewhere. */
    public const int MATE_CP = 100_000;

    /** A single move can't contribute more than this to ACPL. Without a cap,
     *  one catastrophic blunder in one game dominates a whole rating band. */
    public const int CP_LOSS_CAP = 1000;

    /** Evals beyond this are clamped before the delta is taken. Past roughly a
     *  queen, further "improvement" is not a measure of move quality — it's
     *  noise in a decided position, and it would otherwise swamp the average. */
    public const int EVAL_CLAMP = 1500;

    /** An opponent move losing at least this much is an opportunity you were
     *  handed. Matches GameAnalysisService's MISTAKE threshold. */
    public const int OPPORTUNITY_CP = 150;

    /** Your reply counts as "punished" if it costs at most this. */
    public const int PUNISH_CP = 50;

    /**
     * How many zugzwang centipawns equal one Stockfish centipawn.
     *
     * MEASURED, not assumed: scripts/calibrate_tutor_evals.php replays the same
     * games through both and fits a slope through the origin. At 100ms it came
     * out at 2.81 with a Pearson correlation of 0.969 over ~6,300 paired
     * positions — the two engines agree almost perfectly on WHICH positions are
     * better and disagree substantially on what to call the number.
     *
     * Everything Tutor stores is in zugzwang's native scale, so a Tutor
     * accuracy figure and the analysis board's accuracy figure for the same
     * game never disagree on screen. Corpus evals are multiplied INTO this
     * scale on the way in (see the `evalScale` input), and divided back out
     * only inside winProbability(), whose published fit is defined on
     * Stockfish's scale.
     *
     * Re-fit this whenever the engine's eval scale changes; the calibration
     * script writes storage/tutor-calibration.json and TutorCalibration reads it.
     */
    public const float SF_SCALE = 2.8137;

    /**
     * Win probability at which a position counts as won / lost, for the
     * conversion and resourcefulness triggers. This is Lichess's definition,
     * and it is deliberately NOT a centipawn threshold: a probability is
     * invariant to the engine's eval scale, so these two metrics cannot be
     * silently re-broken by an engine change the way a raw cp cutoff would be.
     */
    public const float WINNING_PROB = 66.0;

    public const float LOSING_PROB = 34.0;

    /** Triggers are ignored before this ply, so an opening trap the engine
     *  briefly loves doesn't count as "a winning position you failed to
     *  convert". */
    public const int TRIGGER_MIN_PLY = 12;

    /** Fewer non-pawn, non-king pieces than this on the board = endgame. */
    public const int ENDGAME_PIECES = 7;

    /** Plies before this are the opening, unless material says otherwise. */
    public const int OPENING_PLIES = 20;

    /** A move played with less than this share of the initial clock left
     *  counts as played under time pressure. */
    public const float TIME_PRESSURE_FRACTION = 0.10;

    /**
     * How many zugzwang centipawns of ACPL gap equal one full grade of ACPL,
     * i.e. the ACPL analogue of the accuracy metric's 25-percentage-point
     * scale (see METRICS below for why percent metrics use 25).
     *
     * Accuracy and ACPL are the same underlying quantity viewed through
     * accuracyFromAcpl()'s exponential fit, `acc(a) = 103.1668*e^(-0.004354a)
     * - 3.1669`, so the ACPL scale isn't a free choice — it's whatever ACPL
     * gap maps to a 25-point accuracy gap at a typical peer-band ACPL.
     *
     * Typical ACPL: the measured median of `mean` across all plain `acpl`
     * baseline cells (`tutor_baseline`, dimension='') is ~119 (156 cells,
     * range 44.7-160.9, median of the two central values 118.04/119.89).
     * Call it a0 = 118.
     *
     * At a0, acc(118) = 58.55. The additive constant (-3.1669) cancels in any
     * difference of acc() at two points, so only the exponential matters:
     *   acc(a0) - acc(a0+d) = 103.1668*e^(-0.004354*a0) * (1 - e^(-0.004354*d))
     * Solving acc(a0-d) = acc(a0) + 25 (how much ACPL has to DROP from a
     * typical value to gain 25 accuracy points) gives d = ln((A0+25)/A0) /
     * 0.004354, where A0 = acc(a0)+3.1669 = 61.72. That's d = ln(86.72/61.72)
     * / 0.004354 = 0.3401 / 0.004354 ≈ 78.1 cp.
     *
     * Note the curve is convex, so this is NOT symmetric: gaining 25 points by
     * lowering ACPL from 118 takes ~78cp, but losing 25 points by raising it
     * takes ~119cp (the same absolute cp move matters less once ACPL is
     * already high). A single scale constant has to serve both directions, so
     * one of the two has to be picked; ~78cp (rounds to 80) is used because it
     * is the tighter of the two — it does not require an implausibly large cp
     * swing to reach a full grade, which is the whole point of widening this
     * scale from the old, far-too-tight 25cp (56% of real rows clamped).
     */
    public const float ACPL_SCALE_CP = 80.0;

    /**
     * Every metric, with the three facts the grader needs: which direction is
     * good, whether it's a game-level outcome or a move-level average, and the
     * difference that counts as a full grade of 1.0.
     *
     * `level` drives the importance weighting — a game-level outcome is worth
     * far more than a move-level average, because outcomes are what actually
     * move rating and move-level averages are noisy.
     *
     * `scale` provenance (docs/tasks/open/tutor.md, "Grading and ranking"):
     * the design doc specifies a percentage-point gap / 25 and a rating gap /
     * 150. Every percent-unit metric below uses 25 and `performance` uses 150,
     * matching the spec exactly. `acpl` (unit cp) is not in the spec, since
     * the spec only covers percent and rating metrics — it is derived from
     * the accuracy curve instead of invented; see ACPL_SCALE_CP above for the
     * arithmetic. Before this change these were much tighter ad hoc numbers
     * (8/15/10/12/etc.), which is why 46.3% of real comparison rows clamped to
     * exactly +-1 and read "much better/worse" regardless of true gap size.
     *
     * @var array<string, array{label: string, higherIsBetter: bool, level: string, scale: float, unit: string}>
     */
    public const array METRICS = [
        'accuracy' => [
            'label' => 'Accuracy',
            'higherIsBetter' => true,
            'level' => 'move',
            'scale' => 25.0,
            'unit' => 'percent',
        ],
        'acpl' => [
            'label' => 'Average centipawn loss',
            'higherIsBetter' => false,
            'level' => 'move',
            'scale' => self::ACPL_SCALE_CP,
            'unit' => 'cp',
        ],
        'awareness' => [
            'label' => 'Tactical awareness',
            'higherIsBetter' => true,
            'level' => 'move',
            'scale' => 25.0,
            'unit' => 'percent',
        ],
        'conversion' => [
            'label' => 'Conversion',
            'higherIsBetter' => true,
            'level' => 'game',
            'scale' => 25.0,
            'unit' => 'percent',
        ],
        'resourcefulness' => [
            'label' => 'Resourcefulness',
            'higherIsBetter' => true,
            'level' => 'game',
            'scale' => 25.0,
            'unit' => 'percent',
        ],
        'flagging_loss' => [
            'label' => 'Losses on time',
            'higherIsBetter' => false,
            'level' => 'game',
            'scale' => 25.0,
            'unit' => 'percent',
        ],
        'time_pressure' => [
            'label' => 'Moves in time trouble',
            'higherIsBetter' => false,
            'level' => 'move',
            'scale' => 25.0,
            'unit' => 'percent',
        ],
        // Lichess tracks clock behaviour twice, for good reason: how you spend
        // time in general, and how much you had left specifically in the games
        // you lost. They answer different questions and a player can be fine on
        // one and bad on the other.
        'global_clock' => [
            'label' => 'Clock remaining',
            'higherIsBetter' => true,
            'level' => 'move',
            'scale' => 25.0,
            'unit' => 'percent',
        ],
        'clock_when_losing' => [
            'label' => 'Clock left when you lost',
            'higherIsBetter' => true,
            'level' => 'game',
            'scale' => 25.0,
            'unit' => 'percent',
        ],
        'win_rate' => [
            'label' => 'Score',
            'higherIsBetter' => true,
            'level' => 'game',
            'scale' => 25.0,
            'unit' => 'percent',
        ],
        // Rating performance against the field actually faced. Graded on a
        // 150-point scale, matching the rating-difference scale Lichess uses.
        'performance' => [
            'label' => 'Performance rating',
            'higherIsBetter' => true,
            'level' => 'game',
            'scale' => 150.0,
            'unit' => 'rating',
        ],
    ];

    /** Importance weights by level — a game outcome outranks a move average. */
    public const array LEVEL_WEIGHT = ['game' => 35, 'move' => 1];

    /**
     * Measure one game from one player's point of view.
     *
     * $game is the normalized shape both producers emit:
     *   color        'w'|'b'          — whose report this is
     *   result       '1-0'|'0-1'|'1/2-1/2'
     *   reason       'timeout'|'resign'|'checkmate'|... ('' if unknown)
     *   opening      opening family name, or ''
     *   baseMs       initial clock in ms, or null when unknown/untimed
     *   plies        list, one entry per POSITION, in order. Entry i describes
     *                the position before move i, and carries the move played
     *                from it. The final position carries no move.
     *                  evalWhite  ['type'=>'cp'|'mate','value'=>int] or null
     *                  san        move played, or null on the last entry
     *                  piece      'P'|'N'|'B'|'R'|'Q'|'K' or null
     *                  npPieces   non-pawn non-king piece count in this position
     *                  clockMs    mover's clock remaining AFTER the move, or null
     *
     * Returns per-metric contributions rather than final numbers, so many
     * games can be folded together by aggregate() with correct weighting.
     *
     * @param array<string, mixed> $game
     * @return array{metrics: array<string, array{value: float, weight: float}>, dimensions: array<string, array{value: float, weight: float}>, moves: int}
     */
    public function perGame(array $game): array
    {
        $color = ($game['color'] ?? 'w') === 'b' ? 'b' : 'w';
        $plies = is_array($game['plies'] ?? null) ? $game['plies'] : [];
        $mine = $color === 'w' ? 0 : 1;

        // Multiplier that brings this game's evals onto zugzwang's scale.
        // 1.0 for our own games (already native); SF_SCALE for the Lichess
        // corpus. Without it, ACPL from the two corpora would differ by ~2.8x
        // for reasons that have nothing to do with how anybody played.
        $evalScale = isset($game['evalScale']) && is_numeric($game['evalScale'])
            ? (float) $game['evalScale']
            : 1.0;

        $lossSum = 0.0;
        $moveCount = 0;
        $phaseLoss = [];
        $phaseCount = [];
        $pieceLoss = [];
        $pieceCount = [];

        $opportunities = 0;
        $punished = 0;

        $sawWinning = false;
        $sawLost = false;

        $pressureMoves = 0;
        $clockPercentSum = 0.0;
        $clockPercentCount = 0;
        $lastClockPercent = null;
        $baseMs = isset($game['baseMs']) && is_numeric($game['baseMs']) ? (float) $game['baseMs'] : null;

        $count = count($plies);

        for ($i = 0; $i < $count - 1; $i++) {
            $before = $plies[$i];
            $after = $plies[$i + 1];

            // The start position is treated as carrying no eval, in EVERY
            // corpus. The Lichess dump annotates evals after each move, so it
            // has nothing for the initial position, while /analyze-game does.
            // Left alone that would count White's first move in one corpus and
            // not the other, biasing White's ACPL between the two. The rule is
            // enforced here rather than in the producers so it cannot drift.
            if ($i === 0) {
                continue;
            }

            // A TABLEBASE verdict is not an evaluation, so no metric defined on
            // this class may be computed across one. Syzygy says "won", not "won
            // by this much": the number attached to it is a wire convention
            // ({@see EngineEval}), and differencing it against a real eval would
            // manufacture a cp loss out of a change of units. Both plies are
            // checked because the metric is a DELTA — one tablebase endpoint is
            // enough to poison it.
            //
            // Corpus-symmetric, like the $i === 0 rule above: the Lichess dump's
            // %eval annotations carry no tablebase verdicts at all, so this skips
            // nothing there and cannot bias the comparison.
            if (EngineEval::isTb($before['evalWhite'] ?? null) || EngineEval::isTb($after['evalWhite'] ?? null)) {
                continue;
            }

            $evalBefore = $this->moverEval($before['evalWhite'] ?? null, $i % 2 === 0 ? 'w' : 'b', $evalScale);
            $evalAfter = $this->moverEval($after['evalWhite'] ?? null, $i % 2 === 0 ? 'w' : 'b', $evalScale);

            if ($evalBefore === null || $evalAfter === null) {
                continue;
            }

            // Both evals are from the POV of whoever moved at ply i, so the
            // drop is directly this move's cost.
            $loss = min(self::CP_LOSS_CAP, max(0.0, $evalBefore - $evalAfter));

            $isMine = $i % 2 === $mine;

            if ($isMine) {
                $lossSum += $loss;
                $moveCount++;

                $phase = $this->phaseOf($i, (int) ($before['npPieces'] ?? 14));
                $phaseLoss[$phase] = ($phaseLoss[$phase] ?? 0.0) + $loss;
                $phaseCount[$phase] = ($phaseCount[$phase] ?? 0) + 1;

                $piece = is_string($before['piece'] ?? null) ? $before['piece'] : null;
                if ($piece !== null && $piece !== '') {
                    $pieceLoss[$piece] = ($pieceLoss[$piece] ?? 0.0) + $loss;
                    $pieceCount[$piece] = ($pieceCount[$piece] ?? 0) + 1;
                }

                if ($baseMs !== null && $baseMs > 0 && isset($before['clockMs']) && is_numeric($before['clockMs'])) {
                    $percent = 100.0 * (float) $before['clockMs'] / $baseMs;
                    $clockPercentSum += $percent;
                    $clockPercentCount++;
                    $lastClockPercent = $percent;

                    if ((float) $before['clockMs'] < $baseMs * self::TIME_PRESSURE_FRACTION) {
                        $pressureMoves++;
                    }
                }

                // My position, my point of view: did the game pass through a
                // decisively won or decisively lost state? Judged on win
                // PROBABILITY, not centipawns, so the trigger means the same
                // thing regardless of which engine produced the eval.
                if ($i >= self::TRIGGER_MIN_PLY) {
                    $prob = $this->winProbability($evalBefore);

                    if ($prob >= self::WINNING_PROB) {
                        $sawWinning = true;
                    }

                    if ($prob <= self::LOSING_PROB) {
                        $sawLost = true;
                    }
                }
            } elseif ($loss >= self::OPPORTUNITY_CP && $i + 1 < $count - 1) {
                // The opponent just handed me something. Did I take it?
                $replyBefore = $this->moverEval($plies[$i + 1]['evalWhite'] ?? null, $color, $evalScale);
                $replyAfter = $this->moverEval($plies[$i + 2]['evalWhite'] ?? null, $color, $evalScale);

                if ($replyBefore !== null && $replyAfter !== null) {
                    $opportunities++;
                    if (max(0.0, $replyBefore - $replyAfter) <= self::PUNISH_CP) {
                        $punished++;
                    }
                }
            }
        }

        $score = $this->scoreFor((string) ($game['result'] ?? ''), $color);

        $metrics = [];
        $dimensions = [];

        if ($moveCount > 0) {
            $acpl = $lossSum / $moveCount;
            $metrics['acpl'] = ['value' => $acpl, 'weight' => (float) $moveCount];
            $metrics['accuracy'] = ['value' => $this->accuracyFromAcpl($acpl), 'weight' => (float) $moveCount];

            foreach ($phaseCount as $phase => $n) {
                $dimensions['accuracy@phase:' . $phase] = [
                    'value' => $this->accuracyFromAcpl($phaseLoss[$phase] / $n),
                    'weight' => (float) $n,
                ];
            }

            foreach ($pieceCount as $piece => $n) {
                $dimensions['acpl@piece:' . $piece] = [
                    'value' => $pieceLoss[$piece] / $n,
                    'weight' => (float) $n,
                ];
            }

            if ($baseMs !== null && $baseMs > 0 && $clockPercentCount > 0) {
                $metrics['time_pressure'] = [
                    'value' => 100.0 * $pressureMoves / $moveCount,
                    'weight' => (float) $moveCount,
                ];

                $metrics['global_clock'] = [
                    'value' => $clockPercentSum / $clockPercentCount,
                    'weight' => (float) $clockPercentCount,
                ];
            }
        }

        if ($opportunities > 0) {
            $metrics['awareness'] = [
                'value' => 100.0 * $punished / $opportunities,
                'weight' => (float) $opportunities,
            ];
        }

        if ($score !== null) {
            $metrics['win_rate'] = ['value' => 100.0 * $score, 'weight' => 1.0];

            // Per-game performance rating: the opponent's rating, plus the
            // standard +/-400 for a win or loss. Averaged over games this is
            // the usual performance-rating approximation, and it needs no
            // engine — only who you played and how it went.
            $oppRating = $this->opponentRating($game, $color);
            if ($oppRating !== null) {
                $metrics['performance'] = [
                    'value' => $oppRating + 400.0 * (2.0 * $score - 1.0),
                    'weight' => 1.0,
                ];
            }

            if ($sawWinning) {
                $metrics['conversion'] = ['value' => $score >= 1.0 ? 100.0 : 0.0, 'weight' => 1.0];
            }

            if ($sawLost) {
                $metrics['resourcefulness'] = ['value' => $score > 0.0 ? 100.0 : 0.0, 'weight' => 1.0];
            }

            if ($score <= 0.0) {
                $lostOnTime = str_contains(strtolower((string) ($game['reason'] ?? '')), 'time');
                $metrics['flagging_loss'] = ['value' => $lostOnTime ? 100.0 : 0.0, 'weight' => 1.0];

                if ($lastClockPercent !== null) {
                    $metrics['clock_when_losing'] = ['value' => $lastClockPercent, 'weight' => 1.0];
                }
            }

            // Openings are split BY COLOUR. The same opening is a different
            // problem from each side — you choose it as White and you are
            // answering it as Black — and merging them hides exactly the thing
            // a repertoire fix depends on.
            $opening = trim((string) ($game['opening'] ?? ''));
            if ($opening !== '') {
                $key = 'opening:' . $color . ':' . $opening;
                $dimensions['win_rate@' . $key] = ['value' => 100.0 * $score, 'weight' => 1.0];

                if ($moveCount > 0) {
                    $dimensions['accuracy@' . $key] = [
                        'value' => $this->accuracyFromAcpl($lossSum / $moveCount),
                        'weight' => (float) $moveCount,
                    ];
                }
            }
        }

        return ['metrics' => $metrics, 'dimensions' => $dimensions, 'moves' => $moveCount];
    }

    /**
     * Fold many per-game results into final numbers.
     *
     * Means are weighted (a 60-move game says more about your accuracy than a
     * 12-move one), but percentiles are taken over per-GAME values unweighted,
     * because "a quarter of your games were worse than this" is a statement
     * about games, not about moves.
     *
     * @param list<array{metrics: array<string, array{value: float, weight: float}>, dimensions: array<string, array{value: float, weight: float}>, moves: int}> $perGame
     * @return array<string, array{value: float, sample: int, weight: float, p10: float, p25: float, p50: float, p75: float, p90: float, stddev: float}>
     */
    public function aggregate(array $perGame, bool $includeDimensions = true): array
    {
        /** @var array<string, list<array{value: float, weight: float}>> $buckets */
        $buckets = [];

        foreach ($perGame as $game) {
            foreach ($game['metrics'] ?? [] as $key => $entry) {
                $buckets[$key][] = $entry;
            }

            if ($includeDimensions) {
                foreach ($game['dimensions'] ?? [] as $key => $entry) {
                    $buckets[$key][] = $entry;
                }
            }
        }

        $out = [];

        foreach ($buckets as $key => $entries) {
            $weightSum = 0.0;
            $valueSum = 0.0;
            $values = [];

            foreach ($entries as $entry) {
                $weightSum += $entry['weight'];
                $valueSum += $entry['value'] * $entry['weight'];
                $values[] = $entry['value'];
            }

            if ($weightSum <= 0.0) {
                continue;
            }

            $mean = $valueSum / $weightSum;

            sort($values);
            $varianceSum = 0.0;
            foreach ($values as $value) {
                $varianceSum += ($value - $mean) ** 2;
            }

            $out[$key] = [
                'value' => $mean,
                'sample' => count($entries),
                'weight' => $weightSum,
                'p10' => $this->percentile($values, 0.10),
                'p25' => $this->percentile($values, 0.25),
                'p50' => $this->percentile($values, 0.50),
                'p75' => $this->percentile($values, 0.75),
                'p90' => $this->percentile($values, 0.90),
                'stddev' => count($values) > 1 ? sqrt($varianceSum / (count($values) - 1)) : 0.0,
            ];
        }

        return $out;
    }

    /**
     * Split a composite key back into its metric and dimension halves.
     * 'accuracy@phase:endgame' → ['accuracy', 'phase:endgame'].
     *
     * @return array{0: string, 1: string}
     */
    public function splitKey(string $key): array
    {
        $at = strpos($key, '@');

        return $at === false ? [$key, ''] : [substr($key, 0, $at), substr($key, $at + 1)];
    }

    /**
     * ACPL → accuracy percentage. Same exponential fit the analysis board
     * already uses (GameAnalysisService::accuracy), so a Tutor accuracy figure
     * and a per-game accuracy figure never disagree on screen.
     */
    public function accuracyFromAcpl(float $acpl): float
    {
        $a = 103.1668 * exp(-0.04354 * ($acpl / 10.0)) - 3.1669;

        return max(0.0, min(100.0, $a));
    }

    /**
     * Which phase a position belongs to. One rule, applied to both corpora —
     * material first, then move number, so a queenless position on move 8 is
     * correctly an endgame rather than an "opening".
     */
    public function phaseOf(int $ply, int $nonPawnPieces): string
    {
        if ($nonPawnPieces <= self::ENDGAME_PIECES) {
            return 'endgame';
        }

        return $ply < self::OPENING_PLIES ? 'opening' : 'middlegame';
    }

    /**
     * The opponent's rating, however the producer happened to record it.
     *
     * Our own games carry it directly; the corpus carries both sides' ratings
     * and the colour being measured, so either shape resolves.
     *
     * @param array<string, mixed> $game
     */
    private function opponentRating(array $game, string $color): ?float
    {
        if (isset($game['oppRating']) && is_numeric($game['oppRating']) && (int) $game['oppRating'] > 0) {
            return (float) $game['oppRating'];
        }

        $key = $color === 'w' ? 'blackRating' : 'whiteRating';
        if (isset($game[$key]) && is_numeric($game[$key]) && (int) $game[$key] > 0) {
            return (float) $game[$key];
        }

        return null;
    }

    /**
     * Chance of winning from a centipawn eval, as a percentage.
     *
     * Uses the standard logistic fit published for Stockfish evals, so the
     * eval is divided back down to that scale first (see SF_SCALE). A mate
     * score saturates, which is the correct answer.
     *
     * This is what makes "a winning position" mean one thing across two
     * corpora produced by two different engines.
     */
    public function winProbability(float $cp): float
    {
        $sfCp = $cp / self::SF_SCALE;

        return 50.0 + 50.0 * (2.0 / (1.0 + exp(-0.00368208 * $sfCp)) - 1.0);
    }

    /**
     * A White-POV eval, brought onto zugzwang's scale, converted to the given
     * side's point of view, and clamped. Returns null when the position
     * carries no eval.
     *
     * @param array{type?: string, value?: int|float}|null $evalWhite
     */
    private function moverEval(?array $evalWhite, string $side, float $evalScale = 1.0): ?float
    {
        if ($evalWhite === null || !isset($evalWhite['type'], $evalWhite['value'])) {
            return null;
        }

        // A mate score is already an absolute statement — scaling it would be
        // meaningless, so only real centipawn evals are rescaled.
        $cp = $evalWhite['type'] === 'mate'
            ? ($evalWhite['value'] >= 0 ? self::MATE_CP - abs((int) $evalWhite['value']) : -(self::MATE_CP - abs((int) $evalWhite['value'])))
            : (float) $evalWhite['value'] * $evalScale;

        if ($side === 'b') {
            $cp = -$cp;
        }

        return max(-self::EVAL_CLAMP, min(self::EVAL_CLAMP, $cp));
    }

    /** 1.0 win, 0.5 draw, 0.0 loss, null if the result is unparseable. */
    private function scoreFor(string $result, string $color): ?float
    {
        return match ($result) {
            '1-0' => $color === 'w' ? 1.0 : 0.0,
            '0-1' => $color === 'w' ? 0.0 : 1.0,
            '1/2-1/2' => 0.5,
            default => null,
        };
    }

    /** @param list<float> $sorted */
    private function percentile(array $sorted, float $q): float
    {
        $n = count($sorted);
        if ($n === 0) {
            return 0.0;
        }

        if ($n === 1) {
            return $sorted[0];
        }

        $pos = $q * ($n - 1);
        $lo = (int) floor($pos);
        $hi = (int) ceil($pos);

        return $sorted[$lo] + ($sorted[$hi] - $sorted[$lo]) * ($pos - $lo);
    }
}
