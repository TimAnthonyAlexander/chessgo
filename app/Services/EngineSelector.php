<?php

namespace App\Services;

use BaseApi\App;
use Override;
use RuntimeException;

/**
 * Decorator over the two engine clients: PRIMARY (zugzwang by default —
 * `App::config('engine.primary')`) and FALLBACK (always gomachine). Every
 * standard-chess call tries the primary first and, on the `RuntimeException`
 * {@see GomachineClient::post()} already throws for a connection failure or an
 * HTTP >=400 response, retries the fallback — so the whole site degrades to
 * gomachine automatically if zugzwang is down. Flip `ENGINE_PRIMARY=gomachine`
 * (or `engine.primary` in config) to make the whole site gomachine-primary
 * again with zero code change; the fallback logic then becomes a harmless
 * same-client no-op retry (guarded below, never fired).
 *
 * Duck Chess and Crazyhouse calls skip the primary attempt entirely and go
 * straight to the gomachine client: zugzwang (Wave 1) only implements the
 * standard-chess HTTP surface and explicitly 501s every `/duck/*` and
 * `/crazyhouse/*` route (`zugzwang/src/serve.cpp`), so trying it first would
 * be a guaranteed-failing round trip on every call. Likewise `stockfishMove()`
 * always goes to gomachine — zugzwang has no Stockfish integration.
 *
 * Extends {@see GomachineClient} purely so it satisfies every existing
 * `GomachineClient $engine` constructor type-hint across the app (Liskov
 * substitution) — the inherited no-arg construction path is never used here;
 * every public method is overridden to delegate to the composed clients.
 */
class EngineSelector extends GomachineClient
{
    private readonly GomachineClient $primary;

    private readonly GomachineClient $secondary;

    public function __construct(
        private readonly GomachineClient $gomachine,
        private readonly ZugzwangClient $zugzwang,
    ) {
        $primaryName = App::config('engine.primary') ?? 'zugzwang';
        $this->primary = $primaryName === 'gomachine' ? $this->gomachine : $this->zugzwang;
        // The fallback is always gomachine: it's the durable, feature-complete
        // engine. If gomachine IS the primary (flipped back via config), the
        // "fallback" is the identical instance — withFallback() guards that
        // case and never retries a client against itself.
        $this->secondary = $this->gomachine;
    }

    /**
     * Try the primary client; on a RuntimeException (unreachable / non-2xx),
     * retry the fallback. Never retries a client against itself.
     *
     * @param callable(GomachineClient): array<string, mixed> $call
     * @return array<string, mixed>
     */
    private function withFallback(callable $call): array
    {
        try {
            return $call($this->primary);
        } catch (RuntimeException $e) {
            if ($this->primary === $this->secondary) {
                throw $e; // nothing to fall back to
            }

            return $call($this->secondary);
        }
    }

    /**
     * Skip the primary entirely — used for Duck/Crazyhouse/Stockfish traffic
     * zugzwang can't serve (see class docblock).
     *
     * @param callable(GomachineClient): array<string, mixed> $call
     * @return array<string, mixed>
     */
    private function gomachineOnly(callable $call): array
    {
        return $call($this->gomachine);
    }

    #[Override]
    public function move(string $fen, string $move, array $history = []): array
    {
        return $this->withFallback(static fn (GomachineClient $c): array => $c->move($fen, $move, $history));
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
        return $this->withFallback(
            static fn (GomachineClient $c): array => $c->bestMove($fen, $rating, $history, $movetimeMs, $aggr, $nodes, $depth, $book, $fast),
        );
    }

    #[Override]
    public function worstMove(string $fen, array $history = []): array
    {
        return $this->withFallback(static fn (GomachineClient $c): array => $c->worstMove($fen, $history));
    }

    #[Override]
    public function stockfishMove(string $fen, int $elo, int $movetimeMs = 100, int $depth = 0): array
    {
        // zugzwang has no Stockfish integration and 501s /sf-bestmove — always gomachine.
        return $this->gomachineOnly(static fn (GomachineClient $c): array => $c->stockfishMove($fen, $elo, $movetimeMs, $depth));
    }

    #[Override]
    public function analyze(string $fen, int $movetimeMs = 1500, int $depth = 0): array
    {
        return $this->withFallback(static fn (GomachineClient $c): array => $c->analyze($fen, $movetimeMs, $depth));
    }

    #[Override]
    public function candidates(string $fen, array $history = [], int $multipv = 0, int $movetimeMs = 300, int $depth = 0): array
    {
        return $this->withFallback(
            static fn (GomachineClient $c): array => $c->candidates($fen, $history, $multipv, $movetimeMs, $depth),
        );
    }

    #[Override]
    public function analyzeGame(array $moves, ?string $startFen = null, int $movetimeMs = 100): array
    {
        return $this->withFallback(static fn (GomachineClient $c): array => $c->analyzeGame($moves, $startFen, $movetimeMs));
    }

    #[Override]
    public function duckAnalyzeGame(array $moves, int $movetimeMs = 250): array
    {
        return $this->gomachineOnly(static fn (GomachineClient $c): array => $c->duckAnalyzeGame($moves, $movetimeMs));
    }

    #[Override]
    public function legalMoves(string $fen, ?string $square = null): array
    {
        return $this->withFallback(static fn (GomachineClient $c): array => $c->legalMoves($fen, $square));
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
        return $this->gomachineOnly(static fn (GomachineClient $c): array => $c->crazyhouseLegalMoves($fen));
    }

    #[Override]
    public function crazyhouseMove(string $fen, string $move): array
    {
        return $this->gomachineOnly(static fn (GomachineClient $c): array => $c->crazyhouseMove($fen, $move));
    }

    #[Override]
    public function crazyhouseBestMove(
        string $fen,
        int $rating,
        int $movetimeMs = 0,
        int $depth = 0,
        int $nodes = 0,
    ): array {
        return $this->gomachineOnly(
            static fn (GomachineClient $c): array => $c->crazyhouseBestMove($fen, $rating, $movetimeMs, $depth, $nodes),
        );
    }

    #[Override]
    public function healthy(): bool
    {
        if ($this->primary->healthy()) {
            return true;
        }

        return $this->primary !== $this->secondary && $this->secondary->healthy();
    }
}
