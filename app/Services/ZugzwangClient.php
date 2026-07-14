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
}
