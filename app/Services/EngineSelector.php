<?php

namespace App\Services;

use BaseApi\App;
use Override;

/**
 * Decorator over the two engine clients. Standard-chess + Stockfish +
 * Duck + Crazyhouse calls go to zugzwang ONLY —
 * `App::config('engine.primary')` selects which client is "primary"
 * (zugzwang by default), and every one of those methods calls just that one
 * client. There is no automatic fallback to gomachine on failure: a
 * zugzwang `RuntimeException` (unreachable / HTTP >=400) propagates straight
 * to the caller. `ENGINE_PRIMARY=gomachine` (or `engine.primary` in config)
 * still exists as an escape hatch to point the whole site back at gomachine
 * with zero code change, but it is a straight swap, not a fallback.
 *
 * Duck Chess calls go through `primaryOnly` like standard chess — zugzwang
 * ships its own self-contained Duck Chess engine (board/duck-square state +
 * a hand eval + a shallow rating-weakened search, NOT the shared NNUE;
 * `zugzwang/src/duck.h`) behind `/duck/{legal-moves,move,bestmove,
 * analyze-game}`.
 *
 * Crazyhouse calls go through `primaryOnly` like standard chess — zugzwang
 * ships its own self-contained Crazyhouse engine (pockets/drops + a
 * pocket-aware hand eval, NOT the shared NNUE; `zugzwang/src/crazyhouse.h`)
 * behind `/crazyhouse/{legal-moves,move,bestmove}`.
 *
 * Antichess (Losing Chess) calls likewise go through `primaryOnly` — zugzwang
 * ships its own self-contained Antichess engine (forced-capture rules + an
 * inverted-objective eval, NOT the shared NNUE; `zugzwang/src/antichess.h`)
 * behind `/antichess/{legal-moves,move,bestmove,analyze-game}`. Unlike every
 * other variant's /move, an illegal antichess move surfaces as an HTTP 400
 * (GomachineClient::antichessMove() throws) rather than `legal:false`.
 *
 * gomachine has zero engine-call paths left through this class — every
 * variant + standard chess + Stockfish now goes to zugzwang (`primaryOnly`
 * or `zugzwangOnly`); `gomachineOnly` is retained only as machinery
 * (unused today) so a future variant lacking a zugzwang port can drop back
 * to it without re-adding the plumbing.
 *
 * Extends {@see GomachineClient} purely so it satisfies every existing
 * `GomachineClient $engine` constructor type-hint across the app (Liskov
 * substitution) — the inherited no-arg construction path is never used here;
 * every public method is overridden to delegate to the composed clients.
 */
class EngineSelector extends GomachineClient
{
    private readonly GomachineClient $primary;

    public function __construct(
        private readonly GomachineClient $gomachine,
        private readonly ZugzwangClient $zugzwang,
    ) {
        $primaryName = App::config('engine.primary') ?? 'zugzwang';
        $this->primary = $primaryName === 'gomachine' ? $this->gomachine : $this->zugzwang;
    }

    /**
     * Call the primary client. No fallback: a RuntimeException (unreachable /
     * non-2xx) propagates to the caller as-is.
     *
     * @param callable(GomachineClient): array<string, mixed> $call
     * @return array<string, mixed>
     */
    private function primaryOnly(callable $call): array
    {
        return $call($this->primary);
    }

    /**
     * Skip the primary entirely and go straight to gomachine — unused today
     * (every variant now has a zugzwang port and goes through
     * `primaryOnly`; Duck and Crazyhouse both moved off this once zugzwang
     * shipped self-contained engines for them). Retained as machinery for a
     * future variant that lacks a zugzwang port.
     *
     * @param callable(GomachineClient): array<string, mixed> $call
     * @return array<string, mixed>
     */
    private function gomachineOnly(callable $call): array
    {
        return $call($this->gomachine);
    }

    /**
     * Stockfish always goes to zugzwang (`/sf-bestmove`) — gomachine's own SF
     * integration is unused by this decorator now that zugzwang spawns its
     * own Stockfish subprocess (`zugzwang/src/sf_uci.cpp`).
     *
     * @param callable(GomachineClient): array<string, mixed> $call
     * @return array<string, mixed>
     */
    private function zugzwangOnly(callable $call): array
    {
        return $call($this->zugzwang);
    }

    #[Override]
    public function move(string $fen, string $move, array $history = []): array
    {
        return $this->primaryOnly(static fn (GomachineClient $c): array => $c->move($fen, $move, $history));
    }

    #[Override]
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
        return $this->primaryOnly(
            static fn (GomachineClient $c): array => $c->bestMove($fen, $rating, $history, $movetimeMs, $aggr, $nodes, $depth, $book, $fast),
        );
    }

    #[Override]
    public function worstMove(string $fen, array $history = []): array
    {
        return $this->primaryOnly(static fn (GomachineClient $c): array => $c->worstMove($fen, $history));
    }

    #[Override]
    public function stockfishMove(string $fen, int $elo, int $movetimeMs = 100, int $depth = 0): array
    {
        // zugzwang spawns its own Stockfish subprocess (sf_uci.cpp) — always zugzwang.
        return $this->zugzwangOnly(static fn (GomachineClient $c): array => $c->stockfishMove($fen, $elo, $movetimeMs, $depth));
    }

    #[Override]
    public function analyze(
        string $fen,
        int $movetimeMs = 1500,
        int $depth = 0,
        int $multipv = 0,
        array $history = [],
    ): array {
        return $this->primaryOnly(
            static fn (GomachineClient $c): array => $c->analyze($fen, $movetimeMs, $depth, $multipv, $history),
        );
    }

    #[Override]
    public function candidates(string $fen, array $history = [], int $multipv = 0, int $movetimeMs = 300, int $depth = 0): array
    {
        return $this->primaryOnly(
            static fn (GomachineClient $c): array => $c->candidates($fen, $history, $multipv, $movetimeMs, $depth),
        );
    }

    #[Override]
    public function analyzeGame(array $moves, ?string $startFen = null, int $movetimeMs = 100): array
    {
        return $this->primaryOnly(static fn (GomachineClient $c): array => $c->analyzeGame($moves, $startFen, $movetimeMs));
    }

    #[Override]
    public function analyzeGameMany(array $jobs, int $concurrency = 3): array
    {
        // Same routing as analyzeGame()/duckAnalyzeGame()/antichessAnalyzeGame()
        // — the batch just puts several of those in flight at once, and every
        // one of them is a primary-engine call.
        return $this->primaryOnly(static fn (GomachineClient $c): array => $c->analyzeGameMany($jobs, $concurrency));
    }

    #[Override]
    public function duckAnalyzeGame(array $moves, int $movetimeMs = 250): array
    {
        return $this->primaryOnly(static fn (GomachineClient $c): array => $c->duckAnalyzeGame($moves, $movetimeMs));
    }

    #[Override]
    public function legalMoves(string $fen, ?string $square = null): array
    {
        return $this->primaryOnly(static fn (GomachineClient $c): array => $c->legalMoves($fen, $square));
    }

    #[Override]
    public function duckLegalMoves(string $fen, string $duck): array
    {
        return $this->primaryOnly(static fn (GomachineClient $c): array => $c->duckLegalMoves($fen, $duck));
    }

    #[Override]
    public function duckMove(string $fen, string $duck, string $move): array
    {
        return $this->primaryOnly(static fn (GomachineClient $c): array => $c->duckMove($fen, $duck, $move));
    }

    #[Override]
    public function duckBestMove(
        string $fen,
        string $duck,
        int $rating,
        int $movetimeMs = 0,
        int $depth = 0,
        int $nodes = 0,
    ): array {
        return $this->primaryOnly(
            static fn (GomachineClient $c): array => $c->duckBestMove($fen, $duck, $rating, $movetimeMs, $depth, $nodes),
        );
    }

    #[Override]
    public function crazyhouseLegalMoves(string $fen): array
    {
        return $this->primaryOnly(static fn (GomachineClient $c): array => $c->crazyhouseLegalMoves($fen));
    }

    #[Override]
    public function crazyhouseMove(string $fen, string $move): array
    {
        return $this->primaryOnly(static fn (GomachineClient $c): array => $c->crazyhouseMove($fen, $move));
    }

    #[Override]
    public function crazyhouseBestMove(
        string $fen,
        int $rating,
        int $movetimeMs = 0,
        int $depth = 0,
        int $nodes = 0,
    ): array {
        return $this->primaryOnly(
            static fn (GomachineClient $c): array => $c->crazyhouseBestMove($fen, $rating, $movetimeMs, $depth, $nodes),
        );
    }

    #[Override]
    public function antichessLegalMoves(string $fen): array
    {
        return $this->primaryOnly(static fn (GomachineClient $c): array => $c->antichessLegalMoves($fen));
    }

    #[Override]
    public function antichessMove(string $fen, string $move): array
    {
        return $this->primaryOnly(static fn (GomachineClient $c): array => $c->antichessMove($fen, $move));
    }

    #[Override]
    public function antichessBestMove(
        string $fen,
        int $rating,
        int $movetimeMs = 0,
        int $depth = 0,
        int $nodes = 0,
    ): array {
        return $this->primaryOnly(
            static fn (GomachineClient $c): array => $c->antichessBestMove($fen, $rating, $movetimeMs, $depth, $nodes),
        );
    }

    #[Override]
    public function antichessAnalyzeGame(array $moves, int $movetimeMs = 250): array
    {
        return $this->primaryOnly(static fn (GomachineClient $c): array => $c->antichessAnalyzeGame($moves, $movetimeMs));
    }

    #[Override]
    public function healthy(): bool
    {
        return $this->primary->healthy();
    }

    /**
     * Search-free opening-name lookup — always zugzwang, never gomachine: the
     * `/opening` endpoint (a pure table lookup, {@see ZugzwangClient::opening()})
     * only exists on zugzwang, added alongside the eval-cache work. No
     * `primaryOnly`/`gomachineOnly` routing needed since there's nothing on the
     * gomachine side to route to (mirrors `stockfishMove()`'s always-zugzwang
     * shape). Never throws — see `ZugzwangClient::opening()` for the ok/opening
     * contract callers must check.
     *
     * @param list<string> $history Prior-position FENs, root->previous.
     * @return array{ok: bool, opening: array<string, mixed>|null}
     */
    public function opening(string $fen, array $history = []): array
    {
        return $this->zugzwang->opening($fen, $history);
    }

    /**
     * Search-free book probe — always zugzwang, never gomachine: the `/book`
     * endpoint ({@see ZugzwangClient::book()}) only exists on zugzwang, same
     * always-zugzwang shape as `opening()`/`stockfishMove()`. Never throws —
     * see `ZugzwangClient::book()` for the ok/hit contract callers must check.
     *
     * @return array{ok: false, hit: false}|array{ok: true, hit: false}|array{ok: true, hit: true, eval: array<string, mixed>, bestmove: string, pv: list<string>, depth: int}
     */
    public function book(string $fen): array
    {
        return $this->zugzwang->book($fen);
    }
}
