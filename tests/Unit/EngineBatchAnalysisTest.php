<?php

namespace App\Tests\Unit;

use App\Services\GomachineClient;
use PHPUnit\Framework\TestCase;

/**
 * A batched full-game analysis must ask the engine for EXACTLY what the
 * single-game methods ask for.
 *
 * The point of GomachineClient::analyzeGameMany() is that it changes the
 * schedule and nothing else — same endpoint, same body, same movetime, per
 * variant. If it ever drifted (a different default movetime, the standard
 * endpoint for a duck game), a Tutor report and the review board would quietly
 * disagree about the same game, which is the one failure this whole path is
 * built to avoid. So the request shaping is pinned here.
 *
 * postMany() is the network boundary and is protected, so a test double
 * overrides it and records what it was handed. Nothing here touches curl.
 */
class EngineBatchAnalysisTest extends TestCase
{
    private function client(): GomachineClient
    {
        return new class extends GomachineClient {
            /** @var array<array-key, array{path: string, body: array<string, mixed>, timeoutMs?: int|null}> */
            public array $seen = [];

            public int $seenConcurrency = 0;

            /** @var array<array-key, array{ok: bool, data: array<string, mixed>|null, error: string|null}> */
            public array $reply = [];

            public function __construct()
            {
                // Skip the parent's App::config() lookups — this double never
                // opens a socket.
            }

            protected function postMany(array $requests, int $concurrency = 3): array
            {
                $this->seen = $requests;
                $this->seenConcurrency = $concurrency;

                return $this->reply;
            }
        };
    }

    // --- 1. endpoint + movetime per variant ----------------------------

    public function test_standard_game_uses_the_same_endpoint_and_movetime_as_analyze_game(): void
    {
        $c = $this->client();
        $c->analyzeGameMany(['g1' => ['moves' => ['e2e4', 'e7e5'], 'variant' => 'standard']]);

        $this->assertSame('/analyze-game', $c->seen['g1']['path']);
        $this->assertSame(100, $c->seen['g1']['body']['movetime'], 'standard analyze-game defaults to 100ms, matching analyzeGame()');
        $this->assertSame(['e2e4', 'e7e5'], $c->seen['g1']['body']['moves']);
        $this->assertSame(120_000, $c->seen['g1']['timeoutMs'], 'a full game needs analyzeGame()\'s generous ceiling, not the default engine timeout');
    }

    public function test_duck_and_antichess_go_to_their_own_endpoints_at_their_own_movetime(): void
    {
        $c = $this->client();
        $c->analyzeGameMany([
            'd' => ['moves' => ['e2e4:e5'], 'variant' => 'duck'],
            'a' => ['moves' => ['e2e4'], 'variant' => 'antichess'],
        ]);

        $this->assertSame('/duck/analyze-game', $c->seen['d']['path']);
        $this->assertSame(250, $c->seen['d']['body']['movetime'], 'duckAnalyzeGame() defaults to 250ms');
        $this->assertSame('/antichess/analyze-game', $c->seen['a']['path']);
        $this->assertSame(250, $c->seen['a']['body']['movetime'], 'antichessAnalyzeGame() defaults to 250ms');
    }

    public function test_an_unknown_variant_falls_back_to_the_standard_endpoint(): void
    {
        // GameAnalysisService never sends one (it filters first), so this only
        // pins that a stray value degrades to the standard path rather than
        // producing a request to a nonexistent endpoint.
        $c = $this->client();
        $c->analyzeGameMany(['x' => ['moves' => [], 'variant' => 'nonsense']]);

        $this->assertSame('/analyze-game', $c->seen['x']['path']);
    }

    // --- 2. start position -----------------------------------------------

    public function test_start_fen_is_sent_only_for_the_standard_endpoint(): void
    {
        $fen = '8/8/8/4k3/8/8/4K3/8 w - - 0 1';
        $c = $this->client();
        $c->analyzeGameMany([
            's' => ['moves' => [], 'variant' => 'standard', 'startFen' => $fen],
            'e' => ['moves' => [], 'variant' => 'standard', 'startFen' => ''],
            'd' => ['moves' => [], 'variant' => 'duck', 'startFen' => $fen],
        ]);

        $this->assertSame($fen, $c->seen['s']['body']['startFen']);
        $this->assertArrayNotHasKey('startFen', $c->seen['e']['body'], 'an empty start FEN means "standard start" and is omitted, as in analyzeGame()');
        $this->assertArrayNotHasKey('startFen', $c->seen['d']['body'], 'the duck endpoint takes no start position');
    }

    // --- 3. keys and concurrency -----------------------------------------

    public function test_caller_keys_are_preserved_so_results_can_be_matched_to_games(): void
    {
        $c = $this->client();
        $c->analyzeGameMany([
            '019f2222-1d78-7a95-a009-0b2db81da9df' => ['moves' => ['e2e4']],
            '019f2222-1d84-7c27-afc2-d9e2643a0661' => ['moves' => ['d2d4']],
        ], 3);

        $this->assertSame(
            ['019f2222-1d78-7a95-a009-0b2db81da9df', '019f2222-1d84-7c27-afc2-d9e2643a0661'],
            array_keys($c->seen),
        );
    }

    public function test_the_concurrency_window_is_passed_through_untouched(): void
    {
        $c = $this->client();
        $c->analyzeGameMany(['g' => ['moves' => []]], 2);
        $this->assertSame(2, $c->seenConcurrency);
    }

    // --- 4. one failure must not take the batch with it -------------------

    public function test_a_failed_request_is_reported_alongside_its_successful_siblings(): void
    {
        $c = $this->client();
        $c->reply = [
            'ok' => ['ok' => true, 'data' => ['positions' => [['fen' => 'x']]], 'error' => null],
            'bad' => ['ok' => false, 'data' => null, 'error' => 'engine 400: illegal move in sequence: e2e5'],
        ];

        $res = $c->analyzeGameMany([
            'ok' => ['moves' => ['e2e4']],
            'bad' => ['moves' => ['e2e5']],
        ]);

        $this->assertTrue($res['ok']['ok']);
        $this->assertFalse($res['bad']['ok']);
        $this->assertStringContainsString('illegal move', (string) $res['bad']['error']);
    }
}
