<?php

namespace App\Services;

use BaseApi\App;

/**
 * The zugzwang C++ engine service. It serves the SAME stateless HTTP API as
 * gomachine for standard chess — byte-compatible for /move, /legal-moves,
 * /bestmove, /perft, /status, /candidates, /analyze-game, and /sf-bestmove
 * (WIRING_RECON.md §A) — so this is just {@see GomachineClient} bound to a
 * different base URL (ZUGZWANG_URL, default http://127.0.0.1:6476). Stockfish
 * traffic (`stockfishMove()`) is served by a Stockfish subprocess zugzwang
 * spawns itself per call (`zugzwang/src/sf_uci.cpp`) — gomachine's own SF
 * integration is unused, and Stockfish plays no part in Crazyhouse.
 * Crazyhouse (`/crazyhouse/{legal-moves,move,bestmove}`) is a completely
 * separate, self-contained module with its own pockets/drops/pocket-aware
 * hand eval and its own search (`zugzwang/src/crazyhouse.h`) — no NNUE, no
 * Stockfish.
 *
 * zugzwang still 501s the Duck variant routes (not yet implemented) — never
 * call those methods on this client directly. {@see EngineSelector} guards
 * its own duck methods straight to the gomachine client for exactly this
 * reason.
 */
class ZugzwangClient extends GomachineClient
{
    public function __construct()
    {
        parent::__construct(
            (string) (App::config('zugzwang.url') ?? 'http://127.0.0.1:6476'),
            (int) (App::config('zugzwang.timeout_ms') ?? App::config('gomachine.engine_timeout_ms') ?? 8000),
        );
    }

    /**
     * Search-free opening-name lookup (`POST /opening`) — a pure table lookup
     * in the engine (`Openings::classify`), computed independently of and
     * before any search, so it's essentially free. Used by AnalyzeController
     * to resolve `opening` on an eval-cache HIT: the cached eval carries no
     * history-dependent opening name of its own (opening classification walks
     * `history` to find the DEEPEST named position along the line, which the
     * cache — keyed on a bare position — cannot represent).
     *
     * MUST degrade gracefully and never throw: `/opening` may not exist yet on
     * a deployed engine (added in a parallel task), so an unreachable engine,
     * a 404, or a malformed response are all caught here and reported via
     * `ok: false` rather than propagating. Callers MUST check `ok` before
     * trusting `opening`:
     *   - `ok: false` — couldn't resolve (missing endpoint / unreachable /
     *     malformed). Treat as unknown, e.g. fall back to a full search.
     *   - `ok: true, opening: null` — the engine resolved it and there is
     *     genuinely no named opening for this line. A legitimate answer.
     *   - `ok: true, opening: {eco, name}` — resolved to a named opening.
     *
     * Short timeout — this sits on the `/analyze` fast path (a cache hit that
     * would otherwise be instant) and the lookup itself does no search.
     *
     * @param list<string> $history Prior-position FENs, root->previous.
     * @return array{ok: bool, opening: array<string, mixed>|null}
     */
    public function opening(string $fen, array $history): array
    {
        try {
            $decoded = $this->post('/opening', [
                'fen' => $fen,
                'history' => array_values($history),
            ], 1000);
        } catch (\Throwable) {
            return ['ok' => false, 'opening' => null];
        }

        if (!array_key_exists('opening', $decoded)) {
            return ['ok' => false, 'opening' => null];
        }

        $opening = $decoded['opening'];
        if ($opening === null) {
            return ['ok' => true, 'opening' => null];
        }
        if (!is_array($opening) || !isset($opening['eco'], $opening['name'])) {
            return ['ok' => false, 'opening' => null];
        }

        return ['ok' => true, 'opening' => $opening];
    }
}
