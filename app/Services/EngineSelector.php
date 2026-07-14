<?php

namespace App\Services;

use BaseApi\App;
use Override;

/**
 * Decorator over the two engine clients. Standard-chess + Stockfish +
 * Crazyhouse calls go to zugzwang ONLY — `App::config('engine.primary')`
 * selects which client is "primary" (zugzwang by default), and every one of
 * those methods calls just that one client. There is no automatic fallback
 * to gomachine on failure: a zugzwang `RuntimeException` (unreachable / HTTP
 * >=400) propagates straight to the caller. gomachine has zero engine-call
 * paths left through this class except Duck (below) —
 * `ENGINE_PRIMARY=gomachine` (or `engine.primary` in config) still exists as
 * an escape hatch to point the whole site back at gomachine with zero code
 * change, but it is a straight swap, not a fallback.
 *
 * Duck Chess calls go straight to the gomachine client: zugzwang only
 * implements the standard-chess HTTP surface plus Crazyhouse (below) and
 * still explicitly 501s every `/duck/*` route (`zugzwang/src/serve.cpp`).
 *
 * Crazyhouse calls go through `primaryOnly` like standard chess — zugzwang
 * ships its own self-contained Crazyhouse engine (pockets/drops + a
 * pocket-aware hand eval, NOT the shared NNUE; `zugzwang/src/crazyhouse.h`)
 * behind `/crazyhouse/{legal-moves,move,bestmove}`.
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
     * Skip the primary entirely — used for Duck traffic zugzwang can't serve
     * yet (see class docblock; Crazyhouse moved to `primaryOnly` once
     * zugzwang shipped its own Crazyhouse engine).
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
    public function analyze(string $fen, int $movetimeMs = 1500, int $depth = 0): array
    {
        return $this->primaryOnly(static fn (GomachineClient $c): array => $c->analyze($fen, $movetimeMs, $depth));
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
    public function duckAnalyzeGame(array $moves, int $movetimeMs = 250): array
    {
        return $this->gomachineOnly(static fn (GomachineClient $c): array => $c->duckAnalyzeGame($moves, $movetimeMs));
    }

    #[Override]
    public function legalMoves(string $fen, ?string $square = null): array
    {
        return $this->primaryOnly(static fn (GomachineClient $c): array => $c->legalMoves($fen, $square));
    }

    #[Override]
    public function duckLegalMoves(string $fen, string $duck): array
    {
        return $this->gomachineOnly(static fn (GomachineClient $c): array => $c->duckLegalMoves($fen, $duck));
    }

    #[Override]
    public function duckMove(string $fen, string $duck, string $move): array
    {
        return $this->gomachineOnly(static fn (GomachineClient $c): array => $c->duckMove($fen, $duck, $move));
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
        return $this->gomachineOnly(
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
    public function healthy(): bool
    {
        return $this->primary->healthy();
    }
}
