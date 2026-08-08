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
 *
 * Secret Queen (`secretqueen{Designate,LegalMoves,Move,BestMove}()` below) is
 * ANOTHER completely separate, self-contained module (`zugzwang/src/
 * secretqueen.{h,cpp}` + `secretqueen_bot.{h,cpp}`) behind `/secretqueen/
 * {designate,legal-moves,move,bestmove}` — own mailbox rules (no check, king
 * capture wins), but unlike Duck/Crazyhouse/Antichess it DOES reuse the real
 * NNUE search for its bot (see secretqueen_bot.h). Gomachine has no Secret
 * Queen implementation at all, so these four methods live directly on THIS
 * class (like {@see opening()}/{@see book()}) rather than on the shared
 * {@see GomachineClient} base — {@see EngineSelector} calls this client
 * straight through, with no primary/gomachine routing to speak of.
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

    /**
     * Search-free book probe (`POST /book`) — a pure Zobrist-keyed lookup into
     * zugzwang's precomputed depth-22 Stockfish best-move cache
     * (`zugzwang/src/book.h`), no search. Used by AnalyzeController's
     * `cacheOnly` path: when the eval cache misses and the caller has asked us
     * not to search (the browser's own local engine is doing that), a book hit
     * still gets the ~100-Elo-over-our-search move for free.
     *
     * MUST degrade gracefully and never throw, exactly like {@see opening()}:
     * `/book` may not exist yet on an older deployed engine, so an unreachable
     * engine, a 404, or a malformed response are all caught here and reported
     * via `ok: false` rather than propagating. Callers MUST check `ok`:
     *   - `ok: false` — couldn't resolve (missing endpoint / unreachable /
     *     malformed). Treat as unknown, same as a book miss.
     *   - `ok: true, hit: false` — the engine resolved it; genuinely not in
     *     the book.
     *   - `ok: true, hit: true, eval, bestmove, pv, depth` — a book hit.
     *
     * Short timeout — this sits on the `cacheOnly` fast path, and the lookup
     * itself does no search.
     *
     * @return array{ok: false, hit: false}|array{ok: true, hit: false}|array{ok: true, hit: true, eval: array<string, mixed>, bestmove: string, pv: list<string>, depth: int}
     */
    public function book(string $fen): array
    {
        try {
            $decoded = $this->post('/book', ['fen' => $fen], 1000);
        } catch (\Throwable) {
            return ['ok' => false, 'hit' => false];
        }

        if (!array_key_exists('hit', $decoded) || !is_bool($decoded['hit'])) {
            return ['ok' => false, 'hit' => false];
        }

        if ($decoded['hit'] === false) {
            return ['ok' => true, 'hit' => false];
        }

        $eval = $decoded['eval'] ?? null;
        $bestmove = $decoded['bestmove'] ?? null;
        $pv = $decoded['pv'] ?? null;
        $depth = $decoded['depth'] ?? null;
        if (
            !is_array($eval) || !isset($eval['type'], $eval['value'])
            || !is_string($bestmove)
            || !is_array($pv)
            || !is_int($depth)
        ) {
            return ['ok' => false, 'hit' => false];
        }

        return [
            'ok' => true,
            'hit' => true,
            'eval' => $eval,
            'bestmove' => $bestmove,
            'pv' => array_values(array_map('strval', $pv)),
            'depth' => $depth,
        ];
    }

    /**
     * Secret Queen: designates `$square` as `$color`'s secret pawn-queen on
     * `$fen`. Kept in the engine so the FEN's trailing "[e2|h7]" secret field
     * has exactly one writer — a caller composing it by hand is a second
     * implementation waiting to disagree (`serve_handlers.cpp`).
     *
     * THE ONE THING TO GET RIGHT (repeated here because it's the whole point):
     * `newFen` in the response is the CANONICAL fen — it names BOTH sides'
     * secrets and must never reach a browser. `fenWhite`/`fenBlack`/`boardFen`
     * are the three redacted views, safe to hand to White, Black, and a
     * spectator respectively.
     *
     * @return array<string, mixed> {designated, newFen, fenWhite, fenBlack, boardFen, sideToMove, status, result, kingCaptured}
     */
    public function secretqueenDesignate(string $fen, string $color, string $square): array
    {
        return $this->post('/secretqueen/designate', [
            'fen' => $fen,
            'color' => $color,
            'square' => $square,
        ]);
    }

    /**
     * Secret Queen: legal moves for the side to move, in ITS OWN information
     * set — its own hidden queen generates queen moves as well as pawn moves,
     * the opponent's hidden queen is just a pawn. Safe to hand to that player
     * ONLY, never to the opponent or a spectator: the list itself names queen
     * moves from the secret square.
     *
     * @return array<string, mixed> {moves}
     */
    public function secretqueenLegalMoves(string $fen): array
    {
        return $this->post('/secretqueen/legal-moves', ['fen' => $fen]);
    }

    /**
     * Secret Queen: validate and apply a move. Like {@see GomachineClient::antichessMove()}
     * (and unlike Duck's `legal:false` 200), an illegal move here is an HTTP
     * 400 — post() throws a RuntimeException; callers needing a soft failure
     * (e.g. BotGameService::humanMove) must catch it. `reveal` reports what
     * the move unmasked (`moved`/`captured`/`promoted`/`square`, all
     * false/null on a move that stayed pawn-shaped) so the caller can narrate
     * it.
     *
     * @return array<string, mixed> {legal, san, reveal, newFen, fenWhite, fenBlack, boardFen, sideToMove, status, result, kingCaptured}
     */
    public function secretqueenMove(string $fen, string $move): array
    {
        return $this->post('/secretqueen/move', [
            'fen' => $fen,
            'move' => $move,
        ]);
    }

    /**
     * Secret Queen: compute the AI's move at a target Elo rating (human-scale,
     * same semantics as antichessBestMove()/crazyhouseBestMove()). Unlike
     * those two self-contained variants, this one runs zugzwang's real NNUE
     * search rather than a hand eval (`secretqueen_bot.h`) — it is blind to
     * the OPPONENT's hidden queen (only its own), so the bot walks into an
     * ambush the same way a human would, with no belief model and no
     * peeking. The returned move is ALREADY APPLIED — newFen/fenWhite/
     * fenBlack/boardFen/sideToMove reflect the position after it.
     *
     * @return array<string, mixed> {bestmove, san, eval, reveal, newFen, fenWhite, fenBlack, boardFen, sideToMove, status, result, kingCaptured}
     */
    public function secretqueenBestMove(
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

        return $this->post('/secretqueen/bestmove', [
            'fen' => $fen,
            'limits' => $limits,
        ]);
    }
}
