<?php

namespace App\Services;

use App\Models\Game;
use RuntimeException;

/**
 * Computes (and caches) a full-game analysis for a finished live Game: per-ply
 * engine evaluation, the engine's best move, and a blunder/mistake/inaccuracy
 * judgment for every played move. The engine (gomachine) owns all chess + search;
 * this service only orchestrates the call and turns side-to-move-relative evals
 * into White-relative ones plus centipawn-loss judgments.
 *
 * The result is cached on the Game (immutable once finished) keyed by VERSION, so
 * the expensive engine pass runs at most once per game per analysis version.
 */
class GameAnalysisService
{
    /** Bump when the payload shape or judgment thresholds change (invalidates cache). */
    private const VERSION = 1;

    // Centipawn-loss thresholds for judging a move (from the mover's perspective).
    private const BLUNDER = 300;
    private const MISTAKE = 150;
    private const INACCURACY = 75;

    /** Sentinel centipawn magnitude representing a forced mate (sign = who mates). */
    private const MATE_CP = 100_000;

    /** Per-move cp loss is capped at this for the accuracy/ACPL aggregate. */
    private const ACPL_CAP = 1000;

    private const START_FEN = 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1';

    public function __construct(private readonly GomachineClient $engine)
    {
    }

    /**
     * Return the analysis payload for a game, computing + caching it on first call.
     *
     * @return array<string, mixed>
     */
    public function analyze(Game $game): array
    {
        $cached = $game->getAnalysis();
        if ($cached !== null && ($cached['version'] ?? null) === self::VERSION) {
            return $cached;
        }

        $moves = array_map('strval', $game->getMoves());
        $sans = array_map('strval', $game->getSans());

        $res = $this->engine->analyzeGame($moves);
        $positions = is_array($res['positions'] ?? null) ? $res['positions'] : [];
        if ($positions === []) {
            throw new RuntimeException('engine returned no positions');
        }

        $payload = $this->build($game, $moves, $sans, $positions);

        $game->setAnalysis($payload);
        $game->save();

        return $payload;
    }

    /**
     * @param list<string> $moves
     * @param list<string> $sans
     * @param list<array<string, mixed>> $positions
     * @return array<string, mixed>
     */
    private function build(Game $game, array $moves, array $sans, array $positions): array
    {
        $moveCount = count($moves);
        $plies = [];

        foreach ($positions as $k => $p) {
            $stm = (($p['sideToMove'] ?? 'w') === 'b') ? 'b' : 'w';

            $node = [
                'ply' => $k,
                'fen' => (string) ($p['fen'] ?? ''),
                'sideToMove' => $stm,
                'evalWhite' => $this->whiteEval($p, $stm, $game->result),
                'bestUci' => $this->stringOrNull($p['bestmove'] ?? null),
                'bestSan' => $this->stringOrNull($p['bestSan'] ?? null),
            ];

            // The move actually played FROM this position (none for the final one).
            if ($k < $moveCount) {
                $uci = $moves[$k];
                $san = $sans[$k] ?? $uci;
                $cpLoss = $this->cpLoss($positions, $k);
                $isBest = $node['bestUci'] !== null && $uci === $node['bestUci'];
                $node['move'] = [
                    'uci' => $uci,
                    'san' => $san,
                    'color' => $stm,
                    'cpLoss' => $cpLoss,
                    'isBest' => $isBest,
                    'judgment' => $this->judge($cpLoss, $isBest),
                ];
            }

            $plies[] = $node;
        }

        return [
            'version' => self::VERSION,
            'hubGameId' => $game->hub_game_id,
            'result' => $game->result,
            'reason' => $game->reason,
            'pool' => $game->pool,
            'rated' => $game->rated,
            'whiteName' => $game->white_name,
            'blackName' => $game->black_name,
            'whiteIsBot' => $game->white_is_bot,
            'blackIsBot' => $game->black_is_bot,
            'startFen' => (string) ($positions[0]['fen'] ?? self::START_FEN),
            'plies' => $plies,
            'summary' => $this->summary($plies),
        ];
    }

    /**
     * Centipawn loss of the move played at position $k (from the mover's view):
     * best achievable here minus what the played move actually yielded.
     *
     * @param list<array<string, mixed>> $positions
     */
    private function cpLoss(array $positions, int $k): int
    {
        $cur = $positions[$k] ?? null;
        $next = $positions[$k + 1] ?? null;
        if (!is_array($cur) || !is_array($next)) {
            return 0;
        }

        // Best line from the current position, mover-relative (engine eval already is).
        $bestMover = $this->toCp($cur['eval'] ?? null);

        // What the played move yielded: the next position's eval is the OPPONENT's
        // (they are to move), so negate to get it back to the mover's perspective.
        if (($next['terminal'] ?? false) === true) {
            if (($next['checkmate'] ?? false) === true) {
                $playedMover = self::MATE_CP; // the mover delivered mate — never a loss
            } else {
                $playedMover = 0; // stalemate: a draw from here
            }
        } else {
            $playedMover = -$this->toCp($next['eval'] ?? null);
        }

        $loss = $bestMover - $playedMover;

        return $loss > 0 ? $loss : 0;
    }

    /**
     * Convert a side-to-move-relative eval object {type, value} into a centipawn
     * scalar (still mover-relative). Mate is mapped onto a large magnitude scaled
     * by distance so a faster mate scores higher.
     *
     * @param mixed $eval
     */
    private function toCp(mixed $eval): int
    {
        if (!is_array($eval)) {
            return 0;
        }
        $value = (int) ($eval['value'] ?? 0);
        if (($eval['type'] ?? 'cp') === 'mate') {
            return $value >= 0 ? self::MATE_CP - $value : -self::MATE_CP - $value;
        }

        return $value;
    }

    /**
     * White-relative eval for the bar at a position. Terminal positions (no legal
     * move) are synthesized from the game result so the bar fills to the winner.
     *
     * @param array<string, mixed> $p
     * @return array{type: string, white: int}
     */
    private function whiteEval(array $p, string $stm, string $result): array
    {
        $eval = $p['eval'] ?? null;
        if (is_array($eval)) {
            $value = (int) ($eval['value'] ?? 0);
            $white = $stm === 'w' ? $value : -$value;

            return ['type' => ($eval['type'] ?? 'cp') === 'mate' ? 'mate' : 'cp', 'white' => $white];
        }

        // Terminal: derive from the final result.
        return match ($result) {
            '1-0' => ['type' => 'mate', 'white' => 1],
            '0-1' => ['type' => 'mate', 'white' => -1],
            default => ['type' => 'cp', 'white' => 0],
        };
    }

    private function judge(int $cpLoss, bool $isBest): string
    {
        if ($isBest) {
            return 'best';
        }
        if ($cpLoss >= self::BLUNDER) {
            return 'blunder';
        }
        if ($cpLoss >= self::MISTAKE) {
            return 'mistake';
        }
        if ($cpLoss >= self::INACCURACY) {
            return 'inaccuracy';
        }

        return 'good';
    }

    /**
     * Per-color aggregates: counts by judgment, average centipawn loss, and an
     * accuracy% derived from ACPL (a smooth, Lichess-like approximation).
     *
     * @param list<array<string, mixed>> $plies
     * @return array<string, mixed>
     */
    private function summary(array $plies): array
    {
        $acc = [
            'w' => ['best' => 0, 'good' => 0, 'inaccuracy' => 0, 'mistake' => 0, 'blunder' => 0, 'lossSum' => 0, 'moves' => 0],
            'b' => ['best' => 0, 'good' => 0, 'inaccuracy' => 0, 'mistake' => 0, 'blunder' => 0, 'lossSum' => 0, 'moves' => 0],
        ];

        foreach ($plies as $node) {
            $move = $node['move'] ?? null;
            if (!is_array($move)) {
                continue;
            }
            $c = $move['color'] === 'b' ? 'b' : 'w';
            $j = (string) $move['judgment'];
            if (isset($acc[$c][$j])) {
                $acc[$c][$j]++;
            }
            $acc[$c]['moves']++;
            $acc[$c]['lossSum'] += min((int) $move['cpLoss'], self::ACPL_CAP);
        }

        $out = [];
        foreach (['w', 'b'] as $c) {
            $moves = $acc[$c]['moves'];
            $acpl = $moves > 0 ? (int) round($acc[$c]['lossSum'] / $moves) : 0;
            $out[$c] = [
                'best' => $acc[$c]['best'],
                'good' => $acc[$c]['good'],
                'inaccuracy' => $acc[$c]['inaccuracy'],
                'mistake' => $acc[$c]['mistake'],
                'blunder' => $acc[$c]['blunder'],
                'acpl' => $acpl,
                'accuracy' => $this->accuracy($acpl),
            ];
        }

        return $out;
    }

    /** ACPL → accuracy% (exponential fit, clamped 0..100). */
    private function accuracy(int $acpl): float
    {
        $a = 103.1668 * exp(-0.04354 * ($acpl / 10.0)) - 3.1669;

        return round(max(0.0, min(100.0, $a)), 1);
    }

    private function stringOrNull(mixed $v): ?string
    {
        return is_string($v) && $v !== '' ? $v : null;
    }
}
