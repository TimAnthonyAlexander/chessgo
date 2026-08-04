<?php

namespace App\Services\Tutor;

use App\Models\Game;
use App\Services\EngineSelector;
use App\Services\GameAnalysisService;
use Throwable;

/**
 * Turns one of our stored games into the normalized shape TutorMetrics eats.
 *
 * This is the second of the two producers. The first is the Lichess corpus
 * transcoder (scripts/tutor/pgn_to_jsonl.py); both must emit exactly the same
 * per-ply shape, or the peer comparison compares two different things.
 *
 * It leans on GameAnalysisService for the engine work — that service already
 * knows how to analyze a game once and cache the result on the row, so a game
 * that has been looked at on the analysis board costs a Tutor report nothing.
 */
class TutorGameReader
{
    /** Plies at which we try to name the opening, deepest first. */
    private const array OPENING_PROBE_PLIES = [24, 18, 12, 8];

    public function __construct(
        private readonly GameAnalysisService $analysis,
        private readonly EngineSelector $engine,
    ) {}

    /**
     * @return array<string, mixed>|null Null when the game can't be measured
     *                                   (no moves, unsupported variant, engine
     *                                   failure).
     */
    public function read(Game $game, string $userId, bool $withOpening = true): ?array
    {
        $color = $this->colorOf($game, $userId);
        if ($color === null) {
            return null;
        }

        try {
            $payload = $this->analysis->analyze($game);
        } catch (Throwable) {
            return null;
        }

        if (($payload['unsupported'] ?? false) === true) {
            return null;
        }

        $rawPlies = is_array($payload['plies'] ?? null) ? $payload['plies'] : [];
        if (count($rawPlies) < 6) {
            return null;
        }

        [$baseMs, $incMs] = $this->parsePool($game->pool);
        $clocks = $this->reconstructClocks($game, $baseMs, $incMs, count($rawPlies));

        $plies = [];
        foreach ($rawPlies as $i => $ply) {
            $move = is_array($ply['move'] ?? null) ? $ply['move'] : null;
            $fen = (string) ($ply['fen'] ?? '');

            $plies[] = [
                // GameAnalysisService names the eval value 'white'; TutorMetrics
                // expects 'value'. Same number, different key.
                'evalWhite' => $this->evalOf($ply),
                'san' => $move === null ? null : (string) ($move['san'] ?? ''),
                'piece' => $move === null ? null : $this->pieceOf((string) ($move['san'] ?? '')),
                'npPieces' => $this->nonPawnPieces($fen),
                'clockMs' => $clocks[$i] ?? null,
                // Not read by TutorMetrics — carried so the drill builder can
                // hand a player back the exact position they went wrong in.
                // The Lichess corpus has no equivalent and doesn't need one.
                'fen' => $fen,
                'uci' => $move === null ? null : (string) ($move['uci'] ?? ''),
            ];
        }

        return [
            'id' => $game->id,
            'hubGameId' => $game->hub_game_id,
            'category' => $game->category,
            'variant' => $game->variant,
            'color' => $color,
            'result' => $game->result,
            'reason' => $game->reason,
            'opening' => $withOpening ? $this->openingFamily($rawPlies) : '',
            'baseMs' => $baseMs,
            'incMs' => $incMs,
            'myRating' => $color === 'w' ? $game->white_rating_before : $game->black_rating_before,
            'oppRating' => $color === 'w' ? $game->black_rating_before : $game->white_rating_before,
            'playedAt' => $game->created_at ?? null,
            'plies' => $plies,
        ];
    }

    /** 'w', 'b', or null when this user didn't play in this game. */
    public function colorOf(Game $game, string $userId): ?string
    {
        if ($game->white_user_id === $userId) {
            return 'w';
        }

        if ($game->black_user_id === $userId) {
            return 'b';
        }

        return null;
    }

    /**
     * @param array<string, mixed> $ply
     * @return array{type: string, value: int}|null
     */
    private function evalOf(array $ply): ?array
    {
        $eval = $ply['evalWhite'] ?? null;
        if (!is_array($eval) || !isset($eval['type'])) {
            return null;
        }

        // 'white' is the analysis payload's key for the White-POV number.
        $value = $eval['white'] ?? $eval['value'] ?? null;
        if (!is_numeric($value)) {
            return null;
        }

        return ['type' => $eval['type'] === 'mate' ? 'mate' : 'cp', 'value' => (int) $value];
    }

    /**
     * The piece letter from SAN. Castling is a king move; a plain pawn move
     * has no leading piece letter.
     */
    private function pieceOf(string $san): ?string
    {
        if ($san === '') {
            return null;
        }

        if (str_starts_with($san, 'O-O') || str_starts_with($san, '0-0')) {
            return 'K';
        }

        $first = $san[0];

        return in_array($first, ['N', 'B', 'R', 'Q', 'K'], true) ? $first : 'P';
    }

    /** Non-pawn, non-king pieces standing in a position. Drives phase. */
    private function nonPawnPieces(string $fen): int
    {
        if ($fen === '') {
            return 14;
        }

        $placement = strstr($fen, ' ', true);
        if ($placement === false) {
            $placement = $fen;
        }

        $count = 0;
        $length = strlen($placement);
        for ($i = 0; $i < $length; $i++) {
            if (str_contains('nbrqNBRQ', $placement[$i])) {
                $count++;
            }
        }

        return $count;
    }

    /**
     * Rebuild each mover's remaining clock from the per-move think-times the
     * hub recorded. `move_times` is elapsed ms per ply; the clock left after a
     * move is the base, minus everything that side has spent, plus one
     * increment per move they've completed.
     *
     * Returns null for every ply when the game was untimed or the hub captured
     * no think-times (older games predate the column) — the time metrics then
     * simply don't appear, rather than appearing wrong.
     *
     * @return array<int, int|null>
     */
    private function reconstructClocks(Game $game, ?int $baseMs, int $incMs, int $plyCount): array
    {
        $times = $game->getMoveTimes();
        if ($baseMs === null || $baseMs <= 0 || $times === []) {
            return [];
        }

        $spent = ['w' => 0, 'b' => 0];
        $moved = ['w' => 0, 'b' => 0];
        $out = [];

        for ($i = 0; $i < $plyCount; $i++) {
            if (!isset($times[$i]) || !is_numeric($times[$i])) {
                $out[$i] = null;
                continue;
            }

            $side = $i % 2 === 0 ? 'w' : 'b';
            $spent[$side] += (int) $times[$i];
            $moved[$side]++;

            $out[$i] = max(0, $baseMs - $spent[$side] + $incMs * $moved[$side]);
        }

        return $out;
    }

    /**
     * Name the opening family by asking the engine's opening table at a few
     * decreasing depths and taking the first hit. This is a table lookup, not
     * a search, so it's cheap — but it's still an HTTP call, so we try at most
     * a handful and give up quietly.
     *
     * @param list<array<string, mixed>> $plies
     */
    private function openingFamily(array $plies): string
    {
        $fens = [];
        foreach ($plies as $ply) {
            $fens[] = (string) ($ply['fen'] ?? '');
        }

        foreach (self::OPENING_PROBE_PLIES as $at) {
            if (!isset($fens[$at]) || $fens[$at] === '') {
                continue;
            }

            try {
                $result = $this->engine->opening($fens[$at], array_slice($fens, 0, $at));
            } catch (Throwable) {
                return '';
            }

            $name = $result['opening']['name'] ?? null;
            if (is_string($name) && $name !== '') {
                return $this->familyOf($name);
            }
        }

        return '';
    }

    /**
     * "Sicilian Defense: Najdorf Variation" → "Sicilian Defense". The family is
     * what a report can say something useful about; the exact sub-variation
     * splits the sample into slices too thin to compare.
     */
    private function familyOf(string $name): string
    {
        foreach ([':', ','] as $separator) {
            $cut = strpos($name, $separator);
            if ($cut !== false) {
                $name = substr($name, 0, $cut);
            }
        }

        return trim($name);
    }

    /**
     * "3+2" → [180000, 2000]. Base is minutes, increment is seconds — the
     * same convention Glicko2Service::categoryForPool reads.
     *
     * @return array{0: int|null, 1: int}
     */
    private function parsePool(string $pool): array
    {
        if (!preg_match('/^(\d+)\s*\+\s*(\d+)$/', trim($pool), $m)) {
            return [null, 0];
        }

        return [((int) $m[1]) * 60_000, ((int) $m[2]) * 1000];
    }
}
