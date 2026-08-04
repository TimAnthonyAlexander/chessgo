<?php

namespace App\Services\Tutor;

use App\Models\User;
use BaseApi\App;

/**
 * Turns a weakness into something to do about it.
 *
 * This is the reason the feature exists. Every comparable product — Lichess
 * Tutor, Chess.com Insights, Aimchess — measures a player and then stops, and
 * the loudest complaint on Lichess's own tracker (open and unassigned since
 * February 2026) is "unsure how to move forward after reviewing the results".
 * So the rule here is: every weakness card carries EXACTLY ONE button, and
 * that button opens something specific to this player. A card with four links
 * is a card with no recommendation, and a button that opens the ordinary
 * puzzle page is worse than no button at all.
 *
 * Two of these drills can't be built by anyone else, because they're made out
 * of the player's own games: the positions they were winning and threw away,
 * and the ones they were lost in and gave up on.
 */
class TutorDrillBuilder
{
    public function __construct(
        private readonly TutorThemeProfile $themeProfile,
        private readonly TutorMetrics $metrics,
    ) {}

    /**
     * Win probability at which a position counts as won / lost, and the level
     * it has to fall to before the advantage counts as thrown away.
     *
     * These mirror TutorMetrics::WINNING_PROB exactly, so the positions a
     * drill offers are the same ones the metric counted. If the metric says
     * you failed to convert eleven games, the drill must contain those eleven
     * games and not a different set.
     */
    private const float WINNING_PROB = TutorMetrics::WINNING_PROB;

    private const float LOSING_PROB = TutorMetrics::LOSING_PROB;

    /** Win probability below which a won position has been given away. */
    private const float THROWN_PROB = 55.0;

    /** Most positions to offer per drill. */
    private const int MAX_POSITIONS = 12;

    /**
     * Which puzzle themes address which weakness. Themes are the real tags
     * from the imported Lichess puzzle set (see the `puzzle_theme` table), not
     * invented ones — a drill that filters on a theme with no puzzles behind
     * it is a dead button.
     *
     * @var array<string, list<string>>
     */
    private const array THEME_MAP = [
        'awareness' => ['hangingPiece', 'fork', 'pin', 'skewer', 'discoveredAttack', 'trappedPiece'],
        'accuracy' => ['crushing', 'advantage', 'defensiveMove', 'quietMove'],
        'conversion' => ['crushing', 'advantage', 'endgame'],
        'resourcefulness' => ['defensiveMove', 'quietMove', 'stalemate'],
    ];

    /** @var array<string, list<string>> */
    private const array PHASE_THEME_MAP = [
        'endgame' => ['endgame', 'rookEndgame', 'pawnEndgame', 'queenEndgame', 'knightEndgame', 'bishopEndgame'],
        'opening' => ['opening'],
        'middlegame' => ['middlegame', 'kingsideAttack', 'queensideAttack'],
    ];

    /**
     * One drill per ranked weakness, in the same order.
     *
     * @param list<array<string, mixed>> $weaknesses
     * @param list<array<string, mixed>> $games normalized games (see TutorGameReader)
     * @return list<array<string, mixed>>
     */
    public function forCategory(array $weaknesses, array $games, User $user): array
    {
        $drills = [];

        foreach ($weaknesses as $weakness) {
            $drill = $this->forWeakness($weakness, $games, $user);
            if ($drill !== null) {
                $drills[] = $drill;
            }
        }

        return $drills;
    }

    /**
     * @param array<string, mixed> $weakness
     * @param list<array<string, mixed>> $games
     * @return array<string, mixed>|null
     */
    public function forWeakness(array $weakness, array $games, User $user): ?array
    {
        $metric = (string) ($weakness['metric'] ?? '');
        $dimension = (string) ($weakness['dimension'] ?? '');

        // An opening you score badly in — drill the opening itself, from the
        // side you actually played it. 'opening:w:Sicilian Defense'.
        if (str_starts_with($dimension, 'opening:')) {
            $rest = substr($dimension, strlen('opening:'));
            $colour = substr($rest, 0, 1);
            $name = substr($rest, 2);

            if (!in_array($colour, ['w', 'b'], true) || $name === '') {
                return null;
            }

            return [
                'kind' => 'opening',
                'metric' => $metric,
                'dimension' => $dimension,
                'label' => 'Drill this opening',
                'title' => sprintf('Play %s as %s against the bot', $name, $colour === 'w' ? 'White' : 'Black'),
                'blurb' => 'Repeat the opening until the plans are automatic, from your side of it.',
                'opening' => $name,
                'color' => $colour,
            ];
        }

        if (str_starts_with($dimension, 'phase:')) {
            $phase = substr($dimension, strlen('phase:'));
            $themes = self::PHASE_THEME_MAP[$phase] ?? [];

            if ($phase === 'endgame') {
                // Endgames get both: puzzles, and the actual endgames the
                // player mishandled.
                $positions = $this->phasePositions($games, 'endgame');

                return [
                    'kind' => 'puzzles',
                    'metric' => $metric,
                    'dimension' => $dimension,
                    'label' => 'Drill endgames',
                    'title' => 'Endgame puzzles at your level',
                    'blurb' => 'Technique you can practise directly, plus the endgames from your own games below.',
                    'themes' => $this->availableThemes($themes),
                    'positions' => $positions,
                ];
            }

            if ($themes !== []) {
                return [
                    'kind' => 'puzzles',
                    'metric' => $metric,
                    'dimension' => $dimension,
                    'label' => 'Drill these',
                    'title' => ucfirst($phase) . ' puzzles at your level',
                    'blurb' => 'Positions that turn on the thing you are losing points to.',
                    'themes' => $this->availableThemes($themes),
                ];
            }
        }

        return match ($metric) {
            'conversion' => $this->replayDrill(
                $games,
                'won',
                'Replay your wins that got away',
                'You reached these positions winning and did not win them. Play them again, against the bot.',
                $metric,
            ),
            'resourcefulness' => $this->replayDrill(
                $games,
                'lost',
                'Replay your lost causes',
                'You were losing here and the game ended. Play them out — some of these are savable.',
                $metric,
            ),
            'flagging_loss', 'time_pressure' => $this->timeDrill($games, $metric),
            'awareness', 'accuracy' => [
                'kind' => 'puzzles',
                'metric' => $metric,
                'dimension' => '',
                'label' => 'Drill these',
                'title' => 'Puzzles on the patterns you are missing',
                'blurb' => 'Filtered to the themes you lose the most to, at your puzzle rating.',
                'themes' => $this->availableThemes($this->themesFor($metric, $user)),
            ],
            default => null,
        };
    }

    /**
     * Positions from the player's own games where a decisive advantage was
     * thrown away, or where they were lost and the game ended.
     *
     * @param list<array<string, mixed>> $games
     * @return array<string, mixed>|null
     */
    private function replayDrill(array $games, string $mode, string $label, string $blurb, string $metric): ?array
    {
        $positions = [];

        foreach ($games as $game) {
            $color = ($game['color'] ?? 'w') === 'b' ? 'b' : 'w';
            $score = $this->scoreFor((string) ($game['result'] ?? ''), $color);
            if ($score === null) {
                continue;
            }

            // Only games that actually went wrong in the relevant way.
            if ($mode === 'won' && $score >= 1.0) {
                continue;
            }

            if ($mode === 'lost' && $score > 0.0) {
                continue;
            }

            $found = $mode === 'won'
                ? $this->throwAwayPoint($game, $color)
                : $this->lostPoint($game, $color);

            if ($found !== null) {
                $positions[] = $found;
            }
        }

        if ($positions === []) {
            return null;
        }

        // Biggest swings first — the most instructive, and the most memorable.
        usort($positions, fn(array $a, array $b): int => $b['swing'] <=> $a['swing']);

        return [
            'kind' => 'replay',
            'metric' => $metric,
            'dimension' => '',
            'label' => $label,
            'title' => $label,
            'blurb' => $blurb,
            'positions' => array_slice($positions, 0, self::MAX_POSITIONS),
        ];
    }

    /**
     * The move where a won game stopped being won.
     *
     * @param array<string, mixed> $game
     * @return array<string, mixed>|null
     */
    private function throwAwayPoint(array $game, string $color): ?array
    {
        $plies = is_array($game['plies'] ?? null) ? $game['plies'] : [];
        $mine = $color === 'w' ? 0 : 1;

        $peak = null;
        $peakIndex = null;

        for ($i = 0; $i < count($plies) - 1; $i++) {
            $eval = $this->moverEval($plies[$i]['evalWhite'] ?? null, $color);
            if ($eval === null) {
                continue;
            }

            $prob = $this->metrics->winProbability($eval);

            if ($i % 2 === $mine && $prob >= self::WINNING_PROB && ($peak === null || $eval > $peak)) {
                $peak = $eval;
                $peakIndex = $i;
            }

            // Once we've been winning, the first drop past the threshold is
            // the moment worth replaying.
            if ($peak !== null && $prob <= self::THROWN_PROB && $peakIndex !== null && $i > $peakIndex) {
                return $this->positionAt($game, $peakIndex, $peak - $eval, $color);
            }
        }

        return null;
    }

    /**
     * The moment a game became lost — the position to try to save.
     *
     * @param array<string, mixed> $game
     * @return array<string, mixed>|null
     */
    private function lostPoint(array $game, string $color): ?array
    {
        $plies = is_array($game['plies'] ?? null) ? $game['plies'] : [];
        $mine = $color === 'w' ? 0 : 1;

        for ($i = TutorMetrics::TRIGGER_MIN_PLY; $i < count($plies) - 1; $i++) {
            if ($i % 2 !== $mine) {
                continue;
            }

            $eval = $this->moverEval($plies[$i]['evalWhite'] ?? null, $color);
            if ($eval !== null && $this->metrics->winProbability($eval) <= self::LOSING_PROB) {
                return $this->positionAt($game, $i, abs($eval), $color);
            }
        }

        return null;
    }

    /**
     * @param array<string, mixed> $game
     * @return array<string, mixed>|null
     */
    private function positionAt(array $game, int $index, float $swing, string $color): ?array
    {
        $ply = $game['plies'][$index] ?? null;
        if (!is_array($ply) || ($ply['fen'] ?? '') === '') {
            return null;
        }

        return [
            'fen' => (string) $ply['fen'],
            'gameId' => (string) ($game['hubGameId'] ?? $game['id'] ?? ''),
            'ply' => $index,
            'color' => $color,
            'san' => $ply['san'] ?? null,
            'swing' => (int) round($swing),
            'playedAt' => $game['playedAt'] ?? null,
        ];
    }

    /**
     * Endgame positions the player actually reached, for the endgame drill.
     *
     * @param list<array<string, mixed>> $games
     * @return list<array<string, mixed>>
     */
    private function phasePositions(array $games, string $phase): array
    {
        $out = [];

        foreach ($games as $game) {
            $color = ($game['color'] ?? 'w') === 'b' ? 'b' : 'w';
            $plies = is_array($game['plies'] ?? null) ? $game['plies'] : [];
            $mine = $color === 'w' ? 0 : 1;

            $worst = null;
            $worstIndex = null;

            for ($i = 1; $i < count($plies) - 1; $i++) {
                if ($i % 2 !== $mine) {
                    continue;
                }

                if ($this->metrics->phaseOf($i, (int) ($plies[$i]['npPieces'] ?? 14)) !== $phase) {
                    continue;
                }

                $before = $this->moverEval($plies[$i]['evalWhite'] ?? null, $color);
                $after = $this->moverEval($plies[$i + 1]['evalWhite'] ?? null, $color);
                if ($before === null || $after === null) {
                    continue;
                }

                $loss = $before - $after;
                if ($loss > 100 && ($worst === null || $loss > $worst)) {
                    $worst = $loss;
                    $worstIndex = $i;
                }
            }

            if ($worstIndex !== null && $worst !== null) {
                $position = $this->positionAt($game, $worstIndex, $worst, $color);
                if ($position !== null) {
                    $out[] = $position;
                }
            }
        }

        usort($out, fn(array $a, array $b): int => $b['swing'] <=> $a['swing']);

        return array_slice($out, 0, self::MAX_POSITIONS);
    }

    /**
     * Time trouble has no honest drill — you cannot practise not flagging in a
     * puzzle. So this points at the evidence instead of inventing an exercise.
     *
     * @param list<array<string, mixed>> $games
     * @return array<string, mixed>|null
     */
    private function timeDrill(array $games, string $metric): ?array
    {
        $ids = [];

        foreach ($games as $game) {
            $color = ($game['color'] ?? 'w') === 'b' ? 'b' : 'w';
            $score = $this->scoreFor((string) ($game['result'] ?? ''), $color);

            if ($score !== null && $score <= 0.0
                && str_contains(strtolower((string) ($game['reason'] ?? '')), 'time')) {
                $ids[] = [
                    'gameId' => (string) ($game['hubGameId'] ?? $game['id'] ?? ''),
                    'playedAt' => $game['playedAt'] ?? null,
                ];
            }
        }

        if ($ids === []) {
            return null;
        }

        return [
            'kind' => 'games',
            'metric' => $metric,
            'dimension' => '',
            'label' => 'See the games',
            'title' => 'The games the clock decided',
            'blurb' => 'There is no puzzle for this one. Look at where the time went — a faster time control, or slower opening play, is usually the fix.',
            'games' => array_slice($ids, 0, self::MAX_POSITIONS),
        ];
    }

    /**
     * The themes to drill for a metric, sharpened by the player's own puzzle
     * history when they have enough of one to be worth reading.
     *
     * @return list<string>
     */
    private function themesFor(string $metric, User $user): array
    {
        $base = self::THEME_MAP[$metric] ?? self::THEME_MAP['accuracy'];
        $failed = $this->failedThemes($user);

        if ($failed === []) {
            return $base;
        }

        // A theme the player demonstrably fails goes to the front.
        $ranked = array_values(array_filter($base, fn(string $t): bool => in_array($t, $failed, true)));
        $rest = array_values(array_filter($base, fn(string $t): bool => !in_array($t, $failed, true)));

        return array_merge($ranked, $rest);
    }

    /**
     * Themes this player demonstrably fails, from their puzzle history.
     *
     * Delegated to TutorThemeProfile so the drill and the report's own theme
     * section can never disagree about which themes are weak.
     *
     * @return list<string>
     */
    private function failedThemes(User $user): array
    {
        return $this->themeProfile->weakThemes($user);
    }

    /**
     * Keep only themes that actually have puzzles behind them, so a drill
     * button can never open an empty set.
     *
     * @param list<string> $themes
     * @return list<string>
     */
    private function availableThemes(array $themes): array
    {
        if ($themes === []) {
            return [];
        }

        try {
            $placeholders = implode(',', array_fill(0, count($themes), '?'));
            $rows = App::db()->raw(
                "SELECT theme, COUNT(*) AS n FROM puzzle_theme WHERE theme IN ({$placeholders}) GROUP BY theme HAVING n >= 50",
                $themes,
            );
        } catch (\Throwable) {
            return $themes;
        }

        $available = [];
        foreach ($rows as $row) {
            $available[] = (string) $row['theme'];
        }

        // Preserve the caller's ordering — it encodes priority.
        return array_values(array_filter($themes, fn(string $t): bool => in_array($t, $available, true)));
    }

    /** @param array{type?: string, value?: int|float}|null $evalWhite */
    private function moverEval(?array $evalWhite, string $side): ?float
    {
        if ($evalWhite === null || !isset($evalWhite['type'], $evalWhite['value'])) {
            return null;
        }

        $cp = $evalWhite['type'] === 'mate'
            ? ($evalWhite['value'] >= 0 ? 10000 : -10000)
            : (float) $evalWhite['value'];

        return $side === 'b' ? -$cp : $cp;
    }

    private function scoreFor(string $result, string $color): ?float
    {
        return match ($result) {
            '1-0' => $color === 'w' ? 1.0 : 0.0,
            '0-1' => $color === 'w' ? 0.0 : 1.0,
            '1/2-1/2' => 0.5,
            default => null,
        };
    }
}
