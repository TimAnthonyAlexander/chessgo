<?php

namespace App\Services;

use BaseApi\App;
use RuntimeException;

/**
 * Thin HTTP client for the internal engine service (SPEC §7). The engine is
 * stateless and owns all chess rules + the AI; this client just forwards
 * FEN-in requests. Base URL comes from ENGINE_URL (default
 * http://127.0.0.1:6466).
 *
 * zugzwang serves the identical HTTP API (WIRING_RECON.md §A), so
 * {@see \App\Services\ZugzwangClient} is just this class bound to a different
 * base URL via the optional constructor overrides below — no duplicated
 * method logic needed.
 */
class GomachineClient
{
    private readonly string $baseUrl;

    private readonly int $timeoutMs;

    /**
     * @param string|null $baseUrlOverride  Explicit base URL (used by
     *   {@see \App\Services\ZugzwangClient}); null resolves ENGINE_URL /
     *   gomachine.engine_url as before.
     * @param int|null $timeoutOverrideMs   Explicit timeout; null resolves
     *   ENGINE_TIMEOUT_MS / gomachine.engine_timeout_ms as before.
     */
    public function __construct(?string $baseUrlOverride = null, ?int $timeoutOverrideMs = null)
    {
        $this->baseUrl = rtrim($baseUrlOverride ?? (string) (App::config('gomachine.engine_url') ?? 'http://127.0.0.1:6466'), '/');
        // Engine think time can reach ~2s at level 10; allow headroom.
        $this->timeoutMs = $timeoutOverrideMs ?? (int) (App::config('gomachine.engine_timeout_ms') ?? 8000);
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
     * $aggr is the optional aggression style knob (0..100; 50 = neutral). It is
     * forwarded to the engine's rating path ONLY when non-null — a null (the
     * default for bot games / matchmaking) leaves the engine byte-identical.
     *
     * The admin engine-vs-engine view can pin the search budget to EXACTLY ONE of
     * movetime / nodes / depth (pass the others as 0), and optionally consult the
     * opening book on the rating path via $book=true. Everyday callers (bot games,
     * matchmaking) pass none of these and stay byte-identical to the plain rating
     * search.
     *
     * @param string[] $history
     * @return array<string, mixed> {bestmove, san, eval, pv, depth, nodes, nps}
     */
    public function bestMove(
        string $fen,
        int $rating,
        array $history = [],
        int $movetimeMs = 0,
        ?int $aggr = null,
        int $nodes = 0,
        int $depth = 0,
        bool $book = false,
        bool $fast = false,
    ): array {
        $limits = ['rating' => $rating];
        // Exactly one budget dimension should be set; the engine applies
        // depth→nodes→movetime precedence if more than one leaks through.
        if ($depth > 0) {
            $limits['depth'] = $depth; // fixed-depth search (admin engine-vs-engine)
        } elseif ($nodes > 0) {
            $limits['nodes'] = $nodes; // fixed-nodes search (admin engine-vs-engine)
        } elseif ($movetimeMs > 0) {
            $limits['movetime'] = $movetimeMs; // budget override (admin engine-vs-engine)
        }
        if ($aggr !== null) {
            $limits['aggr'] = $aggr; // aggression style (admin engine-vs-engine, gomachine side)
        }
        if ($book) {
            $limits['book'] = true; // consult the opening book on the rating path
        }
        if ($fast) {
            // Fast weakened search (RootNearBest): best at full depth + only near-best
            // alternatives, so it honors $movetimeMs and stays cheap at every rating.
            // Used by Guess-the-Elo game generation (a full self-play game per call).
            $limits['fast'] = true;
        }

        return $this->post('/bestmove', [
            'fen' => $fen,
            'history' => array_values($history),
            'limits' => $limits,
        ]);
    }

    /**
     * Compute the WORST legal move — the "Unlosable" bot deliberately plays the
     * move that hurts it most (minimizes its own eval, so it hangs material and
     * even walks into mate). The engine ranks every legal move at a fixed depth and
     * returns the minimum-scoring one; rating/level are irrelevant, and the opening
     * book / tablebase are skipped engine-side (they'd return the BEST move).
     *
     * @param string[] $history Prior-position FENs for repetition detection.
     * @return array<string, mixed> {bestmove, san, eval, pv, depth, nodes}
     */
    public function worstMove(string $fen, array $history = []): array
    {
        return $this->post('/bestmove', [
            'fen' => $fen,
            'history' => array_values($history),
            'limits' => ['worst' => true],
        ]);
    }

    /**
     * Stockfish's move at a target UCI_Elo (for the admin engine-vs-engine view).
     *
     * The admin engine-vs-engine view can pin Stockfish to a fixed search depth
     * ($depth > 0), which takes precedence over the time budget engine-side.
     *
     * @return array<string, mixed> {bestmove, san}
     */
    public function stockfishMove(string $fen, int $elo, int $movetimeMs = 100, int $depth = 0): array
    {
        $body = [
            'fen' => $fen,
            'elo' => $elo,
            'movetime' => $movetimeMs,
        ];
        if ($depth > 0) {
            $body['depth'] = $depth; // fixed-depth search (takes precedence over movetime)
        }

        return $this->post('/sf-bestmove', $body);
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
     * `$multipv > 1` returns `lines`: the top N moves from ONE search, all at the
     * same depth (the engine's native MultiPV), each with the opening it leads to.
     *
     * The `eval` object is `{type: 'cp'|'mate', value: int}` plus an OPTIONAL
     * `tb: 'win'|'loss'` naming a Syzygy verdict, in which case `value` is a
     * stand-in (±EngineEval::TB_CP) and not a measurement. Anything doing
     * arithmetic on the number must consult {@see EngineEval} first.
     *
     * @param string[] $history Prior-position FENs (root→previous). Naming only —
     *   the engine uses them to resolve the DEEPEST named opening along the line,
     *   for the position and for every line. Mirrors {@see candidates()}.
     * @return array<string, mixed> {bestmove, san, eval, pv, depth, nodes, opening, lines?}
     */
    public function analyze(
        string $fen,
        int $movetimeMs = 1500,
        int $depth = 0,
        int $multipv = 0,
        array $history = [],
    ): array {
        $limits = ['movetime' => $movetimeMs];
        if ($depth > 0) {
            $limits['depth'] = $depth;
        }
        if ($multipv > 0) {
            $limits['multipv'] = $multipv;
        }

        // The analysis board's deep-rung calls pass a large movetime ceiling; give
        // the HTTP request enough headroom to outlast it (never shorter than the
        // configured default) so the client doesn't sever a legitimate deep search.
        $timeoutMs = max($this->timeoutMs, $movetimeMs + 5000);

        $body = [
            'fen' => $fen,
            'limits' => $limits,
        ];
        if ($history !== []) {
            $body['history'] = array_values($history);
        }

        return $this->post('/bestmove', $body, $timeoutMs);
    }

    /**
     * Opening explorer for the analysis board: the opening NAME of the current
     * line plus a full-strength eval for EVERY legal move (ranked best-first),
     * so the UI can draw a per-move eval bar. The engine owns all of it — naming
     * (its native-Zobrist opening table) and the MultiPV search.
     *
     * @param string[] $history Prior-position FENs (root→previous), so the engine
     *   resolves the DEEPEST named opening along the line, not just the current
     *   position.
     * @return array<string, mixed> {opening: {eco,name}|null, moves: list<{uci,san,eval,pv,depth}>}
     */
    public function candidates(string $fen, array $history = [], int $multipv = 0, int $movetimeMs = 300, int $depth = 0): array
    {
        $limits = ['movetime' => $movetimeMs];
        if ($multipv > 0) {
            $limits['multipv'] = $multipv;
        }
        if ($depth > 0) {
            $limits['depth'] = $depth;
        }

        return $this->post('/candidates', [
            'fen' => $fen,
            'history' => array_values($history),
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
    public function analyzeGame(array $moves, ?string $startFen = null, int $movetimeMs = 100): array
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
     * Full-game analysis for MANY games at once, issued CONCURRENTLY.
     *
     * Same per-game work as {@see analyzeGame()} / {@see duckAnalyzeGame()} /
     * {@see antichessAnalyzeGame()} — identical endpoints, identical bodies,
     * identical timeouts — but the requests are in flight together instead of
     * one after another. The engine keeps `min(6, cores)` independent search
     * groups (`zugzwang/src/serve.cpp`), each leased for the duration of one
     * `/analyze-game` call, and a strictly sequential caller leaves all but one
     * of them idle. Its HTTP layer is a 128-thread pool, so concurrency is
     * bounded by the search groups, not by the socket handling.
     *
     * $concurrency MUST stay below the pool size: live play (bot moves, the
     * analysis board) leases from the same groups, and saturating them makes a
     * game stutter. See `engine.analysis_concurrency`.
     *
     * One request failing never fails the batch — every input key gets an entry
     * back, carrying either the decoded body or the error string that
     * {@see post()} would have thrown. Keys are preserved, so callers can key
     * the batch by game id.
     *
     * @param array<array-key, array{moves: list<string>, variant?: string, startFen?: string|null, movetimeMs?: int|null}> $jobs
     * @return array<array-key, array{ok: bool, data: array<string, mixed>|null, error: string|null}>
     */
    public function analyzeGameMany(array $jobs, int $concurrency = 3): array
    {
        $requests = [];

        foreach ($jobs as $key => $job) {
            $moves = array_values(array_map('strval', $job['moves'] ?? []));
            $variant = (string) ($job['variant'] ?? 'standard');
            $movetimeMs = $job['movetimeMs'] ?? null;

            // Per-variant endpoint + default movetime, mirroring the single-game
            // methods exactly so a batched analysis is byte-identical to a
            // sequential one.
            [$path, $defaultMovetime] = match ($variant) {
                'duck' => ['/duck/analyze-game', 250],
                'antichess' => ['/antichess/analyze-game', 250],
                default => ['/analyze-game', 100],
            };

            $body = [
                'moves' => $moves,
                'movetime' => $movetimeMs ?? $defaultMovetime,
            ];
            // Only the standard endpoint takes a start position (see analyzeGame()).
            if ($path === '/analyze-game') {
                $startFen = $job['startFen'] ?? null;
                if (is_string($startFen) && $startFen !== '') {
                    $body['startFen'] = $startFen;
                }
            }

            $requests[$key] = ['path' => $path, 'body' => $body, 'timeoutMs' => 120_000];
        }

        return $this->postMany($requests, $concurrency);
    }

    /**
     * Duck Chess full-game analysis: replay composite `moves`
     * (`"<pieceUCI>:<duckSquare>"`) from the standard start and evaluate every
     * resulting position with the duck engine at full strength. Mirrors
     * {@see analyzeGame()} — one HTTP call fanned across the pool, so it can take
     * many seconds for a long game (hence the generous timeout). Each position
     * carries a `duck` square and composite `bestmove` in addition to the
     * standard analyze-game shape.
     *
     * @param string[] $moves Composite duck moves in order
     * @return array<string, mixed> {positions: list<position>, count} where each
     *   position is {ply, fen, duck, sideToMove, eval|null, bestmove|null,
     *   bestSan|null, terminal, checkmate, stalemate}
     */
    public function duckAnalyzeGame(array $moves, int $movetimeMs = 250): array
    {
        // A full game can be 80+ positions; even fanned out across the pool this
        // dwarfs the per-move budget, so allow a generous ceiling.
        return $this->post('/duck/analyze-game', [
            'moves' => array_values($moves),
            'movetime' => $movetimeMs,
        ], 120_000);
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

    /**
     * Duck Chess: list the legal PIECE moves in the given position (UCI long
     * algebraic). King-captures are included and no check filter is applied —
     * Duck Chess has no check. The duck placement that follows each piece move
     * is chosen client-side / by the engine when the move is submitted.
     *
     * @param string $duck Current duck square ("" if not yet placed).
     * @return array<string, mixed> {moves}
     */
    public function duckLegalMoves(string $fen, string $duck): array
    {
        return $this->post('/duck/legal-moves', [
            'fen' => $fen,
            'duck' => $duck,
        ]);
    }

    /**
     * Duck Chess: validate and apply a composite move `"<pieceUCI>:<duckSquare>"`
     * (e.g. "e2e4:e5", "e7e8q:h6") — the duck square is where the duck ends up
     * after the piece move.
     *
     * @param string $duck Current duck square ("" if not yet placed).
     * @return array<string, mixed> {legal, error?, newFen, duck, san, sideToMove, status, result}
     */
    public function duckMove(string $fen, string $duck, string $move): array
    {
        return $this->post('/duck/move', [
            'fen' => $fen,
            'duck' => $duck,
            'move' => $move,
        ]);
    }

    /**
     * Duck Chess: compute the AI's composite move at a target Elo rating. The
     * duck engine does its own weakening, so pass the raw human rating. The
     * returned move is ALREADY APPLIED — newFen/duck reflect the position after it.
     *
     * Like {@see bestMove()}, the admin engine-vs-engine (Duck mode) view can pin
     * the search budget to EXACTLY ONE of depth / nodes / movetime (pass the
     * others as 0; the engine applies depth→nodes→movetime precedence). Everyday
     * callers (bot games) pass rating + optional movetime and stay identical.
     *
     * @param string $duck Current duck square ("" if not yet placed).
     * @return array<string, mixed> {bestmove, san, eval, newFen, duck, sideToMove, status, result}
     */
    public function duckBestMove(
        string $fen,
        string $duck,
        int $rating,
        int $movetimeMs = 0,
        int $depth = 0,
        int $nodes = 0,
    ): array {
        $limits = [];
        if ($rating > 0) {
            $limits['rating'] = $rating; // >0 caps strength; omit for full power
        }
        // Exactly one budget dimension; the engine applies depth→nodes→movetime
        // precedence if more than one leaks through.
        if ($depth > 0) {
            $limits['depth'] = $depth; // fixed-depth search (admin engine-vs-engine)
        } elseif ($nodes > 0) {
            $limits['nodes'] = $nodes; // fixed-nodes search (admin engine-vs-engine)
        } elseif ($movetimeMs > 0) {
            $limits['movetime'] = $movetimeMs; // budget override
        }

        return $this->post('/duck/bestmove', [
            'fen' => $fen,
            'duck' => $duck,
            'limits' => $limits,
        ]);
    }

    /**
     * Crazyhouse: list the legal moves (UCI long algebraic, incl. drops "P@e4")
     * for the side to move. The Crazyhouse FEN carries the pocket, so it is
     * self-describing — no auxiliary field.
     *
     * @return array<string, mixed> {moves}
     */
    public function crazyhouseLegalMoves(string $fen): array
    {
        return $this->post('/crazyhouse/legal-moves', ['fen' => $fen]);
    }

    /**
     * Crazyhouse: validate and apply a move ("e2e4", "e7e8q", or a drop "P@e4").
     * The returned newFen is the canonical Crazyhouse FEN (carries the pocket).
     *
     * @return array<string, mixed> {legal, error?, newFen, pocket, san, sideToMove, status, result}
     */
    public function crazyhouseMove(string $fen, string $move): array
    {
        return $this->post('/crazyhouse/move', [
            'fen' => $fen,
            'move' => $move,
        ]);
    }

    /**
     * Crazyhouse: compute the AI's move at a target Elo rating. The Crazyhouse
     * engine does its own weakening, so pass the raw human rating. The returned
     * move is ALREADY APPLIED — newFen/pocket reflect the position after it.
     *
     * @return array<string, mixed> {bestmove, san, eval, newFen, pocket, sideToMove, status, result}
     */
    public function crazyhouseBestMove(
        string $fen,
        int $rating,
        int $movetimeMs = 0,
        int $depth = 0,
        int $nodes = 0,
    ): array {
        $limits = [];
        if ($rating > 0) {
            $limits['rating'] = $rating; // >0 caps strength; omit for full power
        }
        if ($depth > 0) {
            $limits['depth'] = $depth;
        } elseif ($nodes > 0) {
            $limits['nodes'] = $nodes;
        } elseif ($movetimeMs > 0) {
            $limits['movetime'] = $movetimeMs;
        }

        return $this->post('/crazyhouse/bestmove', [
            'fen' => $fen,
            'limits' => $limits,
        ]);
    }

    /**
     * Antichess (Losing Chess): list the legal moves (UCI long algebraic; a
     * king-promotion suffix "k" may appear alongside q/r/b/n, since the king can
     * be forced to promote-capture like any other piece). The FEN is
     * self-describing — no pockets, no duck square.
     *
     * @return array<string, mixed> {moves}
     */
    public function antichessLegalMoves(string $fen): array
    {
        return $this->post('/antichess/legal-moves', ['fen' => $fen]);
    }

    /**
     * Antichess: validate and apply a move ("e2e4", "e7e8q", or the
     * king-promotion suffix "e7e8k"). Unlike every other variant's /move
     * endpoint, an illegal move here is reported as an HTTP 400 `{error}`
     * response rather than `legal:false` in a 200 body — post() throws a
     * RuntimeException in that case; callers needing a soft failure (e.g.
     * BotGameService::humanMove) must catch it.
     *
     * @return array<string, mixed> {legal, san, newFen, sideToMove, status, result}
     */
    public function antichessMove(string $fen, string $move): array
    {
        return $this->post('/antichess/move', [
            'fen' => $fen,
            'move' => $move,
        ]);
    }

    /**
     * Antichess: compute the AI's move at a target Elo rating. The Antichess
     * engine does its own weakening, so pass the raw human rating (same
     * human-scale semantics as bestMove()/crazyhouseBestMove()). The returned
     * move is ALREADY APPLIED — newFen/sideToMove reflect the position after it.
     *
     * @return array<string, mixed> {bestmove, san, eval, newFen, sideToMove, status, result}
     */
    public function antichessBestMove(
        string $fen,
        int $rating,
        int $movetimeMs = 0,
        int $depth = 0,
        int $nodes = 0,
    ): array {
        $limits = [];
        if ($rating > 0) {
            $limits['rating'] = $rating; // >0 caps strength; omit for full power
        }
        if ($depth > 0) {
            $limits['depth'] = $depth;
        } elseif ($nodes > 0) {
            $limits['nodes'] = $nodes;
        } elseif ($movetimeMs > 0) {
            $limits['movetime'] = $movetimeMs;
        }

        return $this->post('/antichess/bestmove', [
            'fen' => $fen,
            'limits' => $limits,
        ]);
    }

    /**
     * Antichess full-game analysis: replay UCI `moves` from the standard start
     * and evaluate every resulting position with the antichess engine at full
     * strength. Mirrors {@see duckAnalyzeGame()} — one HTTP call fanned across
     * the pool, so it can take many seconds for a long game (hence the generous
     * timeout).
     *
     * @param string[] $moves UCI moves in order
     * @return array<string, mixed> {positions: list<position>, count} where each
     *   position is {ply, fen, sideToMove, eval|null, bestmove|null, bestSan|null,
     *   terminal, result}
     */
    public function antichessAnalyzeGame(array $moves, int $movetimeMs = 250): array
    {
        return $this->post('/antichess/analyze-game', [
            'moves' => array_values($moves),
            'movetime' => $movetimeMs,
        ], 120_000);
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
     * Protected (not private) so {@see \App\Services\ZugzwangClient} can reuse
     * it for zugzwang-only endpoints (e.g. `opening()`) that have no
     * equivalent on this base class — same baseUrl/timeout plumbing, no
     * duplicated curl setup.
     *
     * @param array<string, mixed> $body
     * @param int|null $timeoutMs Override the default request timeout (e.g. for
     *   long full-game analysis); null uses the configured default.
     * @return array<string, mixed>
     */
    protected function post(string $path, array $body, ?int $timeoutMs = null): array
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

    /**
     * POST several requests CONCURRENTLY, at most $concurrency in flight.
     *
     * The sibling of {@see post()}: same URL, headers, body encoding, connect
     * timeout and per-request timeout override. The one deliberate difference
     * is the failure mode — post() throws, this REPORTS. A batch is only worth
     * having if one bad game can't take the other 149 with it, so every input
     * key comes back with `ok` plus either `data` or the exact message post()
     * would have thrown.
     *
     * Protected for the same reason as post(): {@see \App\Services\ZugzwangClient}
     * reuses it for zugzwang-only endpoints.
     *
     * @param array<array-key, array{path: string, body: array<string, mixed>, timeoutMs?: int|null}> $requests
     * @return array<array-key, array{ok: bool, data: array<string, mixed>|null, error: string|null}>
     */
    protected function postMany(array $requests, int $concurrency = 3): array
    {
        if ($requests === []) {
            return [];
        }

        $limit = max(1, $concurrency);
        $queue = array_keys($requests);
        $out = [];

        $mh = curl_multi_init();

        /** @var array<int, array-key> $inflight spl_object_id => request key */
        $inflight = [];
        /** @var array<int, \CurlHandle> $handles */
        $handles = [];

        try {
            do {
                // Top up the in-flight window.
                while (count($inflight) < $limit && $queue !== []) {
                    $key = array_shift($queue);
                    $req = $requests[$key];

                    $ch = curl_init($this->baseUrl . $req['path']);
                    if ($ch === false) {
                        $out[$key] = ['ok' => false, 'data' => null, 'error' => 'could not initialise request'];

                        continue;
                    }

                    curl_setopt_array($ch, [
                        CURLOPT_RETURNTRANSFER => true,
                        CURLOPT_POST => true,
                        CURLOPT_POSTFIELDS => json_encode($req['body'], JSON_THROW_ON_ERROR),
                        CURLOPT_HTTPHEADER => ['Content-Type: application/json'],
                        CURLOPT_TIMEOUT_MS => $req['timeoutMs'] ?? $this->timeoutMs,
                        CURLOPT_CONNECTTIMEOUT_MS => 2000,
                    ]);

                    $id = spl_object_id($ch);
                    $inflight[$id] = $key;
                    $handles[$id] = $ch;
                    curl_multi_add_handle($mh, $ch);
                }

                $status = curl_multi_exec($mh, $running);
                if ($status !== CURLM_OK) {
                    break;
                }

                // Reap everything that finished this round.
                while (($info = curl_multi_info_read($mh)) !== false) {
                    /** @var \CurlHandle $ch */
                    $ch = $info['handle'];
                    $id = spl_object_id($ch);
                    $key = $inflight[$id] ?? null;
                    if ($key !== null) {
                        $out[$key] = $this->readMultiResult($ch, (int) $info['result'], (string) $requests[$key]['path']);
                    }

                    unset($inflight[$id], $handles[$id]);
                    curl_multi_remove_handle($mh, $ch);
                    curl_close($ch);
                }

                // Block until something moves rather than spinning. select()
                // returns -1 immediately when there is nothing to wait on
                // (all handles just finished / none added yet), so guard it.
                if ($running > 0 && curl_multi_select($mh, 1.0) === -1) {
                    usleep(1000);
                }
            } while ($running > 0 || $inflight !== [] || $queue !== []);
        } finally {
            foreach ($handles as $ch) {
                curl_multi_remove_handle($mh, $ch);
                curl_close($ch);
            }

            curl_multi_close($mh);
        }

        // Anything that never produced a result (a curl_multi_exec failure
        // above) still has to answer for its key.
        foreach (array_keys($requests) as $key) {
            $out[$key] ??= ['ok' => false, 'data' => null, 'error' => 'engine batch aborted'];
        }

        return $out;
    }

    /**
     * Decode one finished multi handle with EXACTLY {@see post()}'s validation
     * order and messages — unreachable, empty, non-JSON, HTTP >= 400 — reported
     * instead of thrown.
     *
     * @return array{ok: bool, data: array<string, mixed>|null, error: string|null}
     */
    private function readMultiResult(\CurlHandle $ch, int $result, string $path): array
    {
        $raw = curl_multi_getcontent($ch);
        $code = curl_getinfo($ch, CURLINFO_RESPONSE_CODE);

        if ($result !== CURLE_OK) {
            return [
                'ok' => false,
                'data' => null,
                'error' => sprintf('engine unreachable at %s%s: %s', $this->baseUrl, $path, curl_error($ch)),
            ];
        }
        if (!is_string($raw)) {
            return ['ok' => false, 'data' => null, 'error' => 'engine returned no response'];
        }

        $decoded = json_decode($raw, true);
        if (!is_array($decoded)) {
            return ['ok' => false, 'data' => null, 'error' => 'engine returned invalid JSON: ' . $raw];
        }
        if ($code >= 400) {
            $msg = is_string($decoded['error'] ?? null) ? $decoded['error'] : 'engine error';

            return ['ok' => false, 'data' => null, 'error' => sprintf('engine %d: %s', $code, $msg)];
        }

        return ['ok' => true, 'data' => $decoded, 'error' => null];
    }
}
