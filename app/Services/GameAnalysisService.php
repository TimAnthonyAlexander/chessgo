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
    private const VERSION = 4;

    // Centipawn-loss thresholds for judging a move (from the mover's perspective).
    private const BLUNDER = 300;
    private const MISTAKE = 150;
    private const INACCURACY = 75;

    /** Sentinel centipawn magnitude representing a forced mate (sign = who mates). */
    private const MATE_CP = 100_000;

    /** Per-move cp loss is capped at this for the accuracy/ACPL aggregate. */
    private const ACPL_CAP = 1000;

    private const START_FEN = 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1';

    public function __construct(private readonly EngineSelector $engine)
    {
    }

    /**
     * Return the analysis payload for a game, computing + caching it on first call.
     *
     * @return array<string, mixed>
     */
    public function analyze(Game $game): array
    {
        // Duck Chess has its own full-game analyzer (composite "<piece>:<duck>"
        // moves + a dedicated duck engine endpoint); route it there.
        if ($game->variant === 'duck') {
            return $this->analyzeDuck($game);
        }

        // Antichess (Losing Chess) is analyzable too — plain UCI moves through its
        // own dedicated engine endpoint (no pockets, no duck square).
        if ($game->variant === 'antichess') {
            return $this->analyzeAntichess($game);
        }

        // The standard full-game analyzer replays the moves through the standard
        // engine and streams standard evals. Chess960 and Crazyhouse moves would
        // replay from the wrong start / rules (silently wrong or illegal), so
        // those stay unsupported — rather than 502, return an explicit
        // "unsupported" payload the client renders as a friendly notice.
        if ($game->variant !== '' && $game->variant !== 'standard') {
            return $this->unsupported($game);
        }

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

        $payload = $this->build($this->gameMeta($game), $moves, $sans, $positions);

        $game->setAnalysis($payload);
        $game->save();

        return $payload;
    }

    /**
     * Return the Duck Chess analysis payload, computing + caching it on first
     * call. Mirrors {@see analyze()} but replays the game's composite moves
     * through the duck engine's full-game endpoint; {@see build()} then turns the
     * positions into the same per-ply payload (composite moves + the per-position
     * duck square flow through opaquely).
     *
     * @return array<string, mixed>
     */
    private function analyzeDuck(Game $game): array
    {
        $cached = $game->getAnalysis();
        if ($cached !== null && ($cached['version'] ?? null) === self::VERSION) {
            return $cached;
        }

        $moves = array_map('strval', $game->getMoves());
        $sans = array_map('strval', $game->getSans());

        $res = $this->engine->duckAnalyzeGame($moves);
        $positions = is_array($res['positions'] ?? null) ? $res['positions'] : [];
        if ($positions === []) {
            throw new RuntimeException('engine returned no positions');
        }

        $payload = $this->build($this->gameMeta($game), $moves, $sans, $positions);

        $game->setAnalysis($payload);
        $game->save();

        return $payload;
    }

    /**
     * Return the Antichess (Losing Chess) analysis payload, computing + caching
     * it on first call. Mirrors {@see analyzeDuck()} but replays the game's plain
     * UCI moves through the antichess engine's full-game endpoint; {@see build()}
     * then turns the positions into the same per-ply payload. The antichess
     * engine's eval is on its own inverted-objective scale, but that's opaque
     * here — cpLoss/judgment only ever compares position k against k+1 from the
     * SAME engine, so the generic build() logic applies unchanged.
     *
     * @return array<string, mixed>
     */
    private function analyzeAntichess(Game $game): array
    {
        $cached = $game->getAnalysis();
        if ($cached !== null && ($cached['version'] ?? null) === self::VERSION) {
            return $cached;
        }

        $moves = array_map('strval', $game->getMoves());
        $sans = array_map('strval', $game->getSans());

        $res = $this->engine->antichessAnalyzeGame($moves);
        $positions = is_array($res['positions'] ?? null) ? $res['positions'] : [];
        if ($positions === []) {
            throw new RuntimeException('engine returned no positions');
        }

        $payload = $this->build($this->gameMeta($game), $moves, $sans, $positions);

        $game->setAnalysis($payload);
        $game->save();

        return $payload;
    }

    /**
     * Stateless full-game analysis for an ad-hoc move list — no persisted Game,
     * nothing cached, nothing written to the database. Powers Blunder Rewind for
     * games that have no Game row (bot games chiefly): {@see build()} produces the
     * exact same payload shape as the persisted-game path, just seeded with
     * generic metadata instead of a Game's names/result/rating. Standard rules
     * only — callers (bot games, imported PGNs) never send Chess960/Duck/
     * Crazyhouse move lists through this path.
     *
     * @param list<string> $moves UCI moves in order
     * @return array<string, mixed>
     */
    public function analyzeMoves(array $moves, ?string $startFen = null): array
    {
        $moves = array_map('strval', $moves);

        $res = $this->engine->analyzeGame($moves, $startFen);
        $positions = is_array($res['positions'] ?? null) ? $res['positions'] : [];
        if ($positions === []) {
            throw new RuntimeException('engine returned no positions');
        }

        // The engine doesn't return SAN for a raw move list — only a persisted
        // Game carries the hub's SANs. Blunder detection only reads cpLoss/
        // judgment/uci, so falling back to the UCI itself for display is fine here.
        $sans = $moves;

        $last = $positions[count($positions) - 1];
        $meta = [
            'variant' => 'standard',
            'hubGameId' => '',
            'result' => $this->deriveResult($last),
            'reason' => '',
            'pool' => '',
            'rated' => false,
            'whiteName' => 'White',
            'blackName' => 'Black',
            'whiteIsBot' => false,
            'blackIsBot' => false,
        ];

        return $this->build($meta, $moves, $sans, $positions);
    }

    /**
     * @return array<string, mixed>
     */
    private function gameMeta(Game $game): array
    {
        return [
            'variant' => $game->variant,
            'hubGameId' => $game->hub_game_id,
            'result' => $game->result,
            'reason' => $game->reason,
            'pool' => $game->pool,
            'rated' => $game->rated,
            'whiteName' => $game->white_name,
            'blackName' => $game->black_name,
            'whiteIsBot' => $game->white_is_bot,
            'blackIsBot' => $game->black_is_bot,
        ];
    }

    /**
     * Derive a "1-0"/"0-1"/"1/2-1/2" result from the final position's terminal
     * state — there's no persisted Game to read a result off for a stateless
     * move-list analysis. Callers only ever submit a finished game here, so the
     * last position should always be terminal; "*" is a defensive fallback.
     *
     * @param array<string, mixed> $last
     */
    private function deriveResult(array $last): string
    {
        if (($last['terminal'] ?? false) !== true) {
            return '*';
        }
        if (($last['checkmate'] ?? false) === true) {
            // The side to move at the final position is the one checkmated.
            $stm = (($last['sideToMove'] ?? 'w') === 'b') ? 'b' : 'w';

            return $stm === 'w' ? '0-1' : '1-0';
        }

        return '1/2-1/2';
    }

    /**
     * A minimal payload for a game the standard analyzer can't handle (Chess960).
     * Not cached — it's cheap and the flag lets the client show a clear "not
     * available for this variant" state instead of an error.
     *
     * @return array<string, mixed>
     */
    private function unsupported(Game $game): array
    {
        return [
            'version' => self::VERSION,
            'unsupported' => true,
            'variant' => $game->variant,
            'hubGameId' => $game->hub_game_id,
            'result' => $game->result,
            'reason' => $game->reason,
            'pool' => $game->pool,
            'rated' => $game->rated,
            'whiteName' => $game->white_name,
            'blackName' => $game->black_name,
            'whiteIsBot' => $game->white_is_bot,
            'blackIsBot' => $game->black_is_bot,
            'startFen' => self::START_FEN,
            'plies' => [],
            'summary' => $this->summary([]),
        ];
    }

    /**
     * @param array<string, mixed> $meta {@see gameMeta()} / the stateless meta in
     *   {@see analyzeMoves()} — the game-level fields build() needs that don't
     *   come from the engine's per-position payload.
     * @param list<string> $moves
     * @param list<string> $sans
     * @param list<array<string, mixed>> $positions
     * @return array<string, mixed>
     */
    private function build(array $meta, array $moves, array $sans, array $positions): array
    {
        $moveCount = count($moves);
        $plies = [];

        foreach ($positions as $k => $p) {
            $stm = (($p['sideToMove'] ?? 'w') === 'b') ? 'b' : 'w';

            $node = [
                'ply' => $k,
                'fen' => (string) ($p['fen'] ?? ''),
                // Per-position duck square (Duck Chess only; '' for standard —
                // harmless, the client ignores it when the game isn't a duck game).
                'duck' => (string) ($p['duck'] ?? ''),
                'sideToMove' => $stm,
                'evalWhite' => $this->whiteEval($p, $stm, (string) $meta['result']),
                'bestUci' => $this->stringOrNull($p['bestmove'] ?? null),
                'bestSan' => $this->stringOrNull($p['bestSan'] ?? null),
                // Engine's predicted best line (UCI, bestUci first) + search depth,
                // so the board renders the line straight from cache — no per-node
                // re-analysis just to recover the PV the whole-game pass already found.
                'bestPv' => $this->pvUci($p['pv'] ?? null),
                'bestDepth' => $this->intOrNull($p['depth'] ?? null),
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
            // Lets the client tell a duck review apart from a standard one (drives
            // the per-ply duck overlay); '' / 'standard' for ordinary games.
            'variant' => $meta['variant'],
            'hubGameId' => $meta['hubGameId'],
            'result' => $meta['result'],
            'reason' => $meta['reason'],
            'pool' => $meta['pool'],
            'rated' => $meta['rated'],
            'whiteName' => $meta['whiteName'],
            'blackName' => $meta['blackName'],
            'whiteIsBot' => $meta['whiteIsBot'],
            'blackIsBot' => $meta['blackIsBot'],
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

    private function intOrNull(mixed $v): ?int
    {
        return is_int($v) ? $v : (is_numeric($v) ? (int) $v : null);
    }

    /**
     * Normalize the engine's PV to a clean list of UCI strings (empty for a
     * terminal/missing line — never null, so the client treats it as "resolved").
     *
     * @return list<string>
     */
    private function pvUci(mixed $v): array
    {
        if (!is_array($v)) {
            return [];
        }

        $out = [];
        foreach ($v as $uci) {
            if (is_string($uci) && $uci !== '') {
                $out[] = $uci;
            }
        }

        return $out;
    }
}
