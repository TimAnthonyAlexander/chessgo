<?php

namespace App\Services;

use BaseApi\App;
use RuntimeException;

/**
 * Thin HTTP client for the internal gomachine engine service (SPEC §7). The
 * engine is stateless and owns all chess rules + the AI; this client just
 * forwards FEN-in requests. Base URL comes from ENGINE_URL (default
 * http://127.0.0.1:6466).
 */
class GomachineClient
{
    private readonly string $baseUrl;

    private readonly int $timeoutMs;

    public function __construct()
    {
        $this->baseUrl = rtrim((string) (App::config('gomachine.engine_url') ?? 'http://127.0.0.1:6466'), '/');
        // Engine think time can reach ~2s at level 10; allow headroom.
        $this->timeoutMs = (int) (App::config('gomachine.engine_timeout_ms') ?? 8000);
    }

    /**
     * Validate and apply a single move.
     *
     * @param string[] $history Prior-position FENs for repetition detection.
     * @return array<string, mixed> {legal, newFen, san, status, sideToMove, check, claimableDraws, result?}
     */
    public function move(string $fen, string $move, array $history = []): array
    {
        return $this->post('/move', [
            'fen' => $fen,
            'move' => $move,
            'history' => array_values($history),
        ]);
    }

    /**
     * Compute the AI's move at a target Elo rating (the engine maps it to a
     * weakening config at a fixed think time).
     *
     * @param string[] $history
     * @return array<string, mixed> {bestmove, san, eval, pv, depth, nodes, nps}
     */
    public function bestMove(string $fen, int $rating, array $history = [], int $movetimeMs = 0): array
    {
        $limits = ['rating' => $rating];
        if ($movetimeMs > 0) {
            $limits['movetime'] = $movetimeMs; // budget override (admin engine-vs-engine)
        }

        return $this->post('/bestmove', [
            'fen' => $fen,
            'history' => array_values($history),
            'limits' => $limits,
        ]);
    }

    /**
     * Stockfish's move at a target UCI_Elo (for the admin engine-vs-engine view).
     *
     * @return array<string, mixed> {bestmove, san}
     */
    public function stockfishMove(string $fen, int $elo, int $movetimeMs = 100): array
    {
        return $this->post('/sf-bestmove', [
            'fen' => $fen,
            'elo' => $elo,
            'movetime' => $movetimeMs,
        ]);
    }

    /**
     * Full-strength positional analysis, INDEPENDENT of any bot difficulty
     * level (SPEC §6) — used to drive the eval bar. Always searches at full
     * power for a fixed time budget, so a level-1 bot game still shows an
     * accurate evaluation.
     *
     * When `$depth > 0`, search to that fixed ply depth instead of by time —
     * `$movetimeMs` then acts as a safety ceiling so a deep request can't hang
     * the engine pool (the search stops at whichever bound hits first). The
     * analysis board polls this with increasing depths to "stream" a refining
     * evaluation; the engine's warm transposition table makes each step cheap.
     *
     * @return array<string, mixed> {bestmove, san, eval, pv, depth, nodes}
     */
    public function analyze(string $fen, int $movetimeMs = 1500, int $depth = 0): array
    {
        $limits = ['movetime' => $movetimeMs];
        if ($depth > 0) {
            $limits['depth'] = $depth;
        }

        return $this->post('/bestmove', [
            'fen' => $fen,
            'limits' => $limits,
        ]);
    }

    /**
     * Full-game analysis: replay UCI `moves` from `startFen` (null = standard
     * start) and evaluate every resulting position at full strength. The engine
     * fans the positions out across its worker pool, so this is one HTTP call;
     * it can still take many seconds for a long game, hence the longer timeout.
     *
     * @param string[] $moves UCI moves in order
     * @return array<string, mixed> {positions: list<position>, count} where each
     *   position is {ply?, fen, sideToMove, eval|null, bestmove|null, bestSan|null,
     *   terminal, checkmate, stalemate}
     */
    public function analyzeGame(array $moves, ?string $startFen = null, int $movetimeMs = 600): array
    {
        $body = [
            'moves' => array_values($moves),
            'movetime' => $movetimeMs,
        ];
        if ($startFen !== null && $startFen !== '') {
            $body['startFen'] = $startFen;
        }

        // A full game can be 80+ positions; even fanned out across the pool this
        // dwarfs the per-move budget, so allow a generous ceiling.
        return $this->post('/analyze-game', $body, 120_000);
    }

    /**
     * List legal moves (optionally from a single square).
     *
     * @return array<string, mixed> {moves, count}
     */
    public function legalMoves(string $fen, ?string $square = null): array
    {
        $body = ['fen' => $fen];
        if ($square !== null && $square !== '') {
            $body['square'] = $square;
        }

        return $this->post('/legal-moves', $body);
    }

    /** Liveness check against the engine. */
    public function healthy(): bool
    {
        $ch = curl_init($this->baseUrl . '/healthz');
        curl_setopt_array($ch, [
            CURLOPT_RETURNTRANSFER => true,
            CURLOPT_TIMEOUT_MS => 1000,
        ]);
        $body = curl_exec($ch);
        $code = curl_getinfo($ch, CURLINFO_RESPONSE_CODE);

        return $code === 200 && is_string($body);
    }

    /**
     * POST JSON and decode the response.
     *
     * @param array<string, mixed> $body
     * @param int|null $timeoutMs Override the default request timeout (e.g. for
     *   long full-game analysis); null uses the configured default.
     * @return array<string, mixed>
     */
    private function post(string $path, array $body, ?int $timeoutMs = null): array
    {
        $ch = curl_init($this->baseUrl . $path);
        curl_setopt_array($ch, [
            CURLOPT_RETURNTRANSFER => true,
            CURLOPT_POST => true,
            CURLOPT_POSTFIELDS => json_encode($body, JSON_THROW_ON_ERROR),
            CURLOPT_HTTPHEADER => ['Content-Type: application/json'],
            CURLOPT_TIMEOUT_MS => $timeoutMs ?? $this->timeoutMs,
            CURLOPT_CONNECTTIMEOUT_MS => 2000,
        ]);
        $raw = curl_exec($ch);
        $errno = curl_errno($ch);
        $error = curl_error($ch);
        $code = curl_getinfo($ch, CURLINFO_RESPONSE_CODE);

        if ($errno !== 0) {
            throw new RuntimeException(sprintf('engine unreachable at %s%s: %s', $this->baseUrl, $path, $error));
        }
        if (!is_string($raw)) {
            throw new RuntimeException('engine returned no response');
        }

        $decoded = json_decode($raw, true);
        if (!is_array($decoded)) {
            throw new RuntimeException('engine returned invalid JSON: ' . $raw);
        }
        if ($code >= 400) {
            $msg = is_string($decoded['error'] ?? null) ? $decoded['error'] : 'engine error';
            throw new RuntimeException(sprintf('engine %d: %s', $code, $msg));
        }

        return $decoded;
    }
}
