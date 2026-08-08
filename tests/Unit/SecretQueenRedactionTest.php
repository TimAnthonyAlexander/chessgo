<?php

namespace App\Tests\Unit;

use App\Services\BotGameService;
use PHPUnit\Framework\TestCase;
use ReflectionClass;
use ReflectionMethod;

/**
 * Secret Queen redaction — the one thing this variant lives or dies on.
 *
 * The stored FEN is CANONICAL: its trailing "[w|b]" field names both sides'
 * still-hidden queens. BotGameService::present() is the only thing standing
 * between that and the browser, and if the bot's square ever reaches the client
 * the variant is not buggy, it is pointless — the player can just read off which
 * pawn to take.
 *
 * The history case is the one that actually went wrong in development and is why
 * this file exists: `fen` was redacted, but every entry in `moves[]` carries the
 * position AFTER that move and the client replays those FENs for history review.
 * Redacting only the live FEN handed the secret over on ply 1.
 *
 * These are pure string transforms with no engine or database involvement, so
 * they are exercised directly through reflection rather than by standing up the
 * whole service.
 */
class SecretQueenRedactionTest extends TestCase
{
    private const CANONICAL = 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1 [e2|h7]';

    private BotGameService $svc;

    private ReflectionMethod $redact;

    private ReflectionMethod $square;

    protected function setUp(): void
    {
        // The redaction helpers touch no collaborator, so the constructor's
        // EngineSelector is irrelevant here — skip it rather than build a mock
        // that would only document a dependency this code path does not have.
        $this->svc = (new ReflectionClass(BotGameService::class))->newInstanceWithoutConstructor();

        $this->redact = new ReflectionMethod(BotGameService::class, 'secretQueenRedact');
        $this->redact->setAccessible(true);
        $this->square = new ReflectionMethod(BotGameService::class, 'secretQueenSquare');
        $this->square->setAccessible(true);
    }

    private function redact(string $fen, string $color): string
    {
        return $this->redact->invoke($this->svc, $fen, $color);
    }

    public function test_each_side_keeps_its_own_secret_and_never_sees_the_other(): void
    {
        $white = $this->redact(self::CANONICAL, 'w');
        $black = $this->redact(self::CANONICAL, 'b');

        $this->assertStringContainsString('[e2|-]', $white);
        $this->assertStringNotContainsString('h7', $white, "White's view disclosed Black's secret");

        $this->assertStringContainsString('[-|h7]', $black);
        $this->assertStringNotContainsString('e2', $black, "Black's view disclosed White's secret");
    }

    /**
     * Redaction is SUBTRACTIVE by design: it blanks a field, it never swaps a
     * piece. The board itself must come through byte-identical, because a hidden
     * queen is an ordinary pawn on it — that is what makes a leak impossible to
     * cause by forgetting to substitute something back.
     */
    public function test_the_board_field_is_never_touched(): void
    {
        $board = explode(' ', self::CANONICAL)[0];

        foreach (['w', 'b'] as $color) {
            $this->assertSame($board, explode(' ', $this->redact(self::CANONICAL, $color))[0]);
        }
    }

    public function test_secret_square_reads_only_the_requested_colour(): void
    {
        $this->assertSame('e2', $this->square->invoke($this->svc, self::CANONICAL, 'w'));
        $this->assertSame('h7', $this->square->invoke($this->svc, self::CANONICAL, 'b'));
    }

    /**
     * Once a queen is revealed, captured or promoted the engine records "-" and
     * there is no hidden state left — the client should be told null so it stops
     * drawing the badge, not an empty string it has to interpret.
     */
    public function test_a_spent_secret_reads_null(): void
    {
        $spent = 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1 [-|h7]';

        $this->assertNull($this->square->invoke($this->svc, $spent, 'w'));
        $this->assertSame('h7', $this->square->invoke($this->svc, $spent, 'b'));
    }

    /**
     * The regression this file exists for: a move-history FEN discloses exactly
     * as much as the live one, so present() must redact every one of them.
     */
    public function test_move_history_fens_are_redacted_too(): void
    {
        $history = [
            'rnbqkbnr/pppppppp/8/8/4P3/8/PPPP1PPP/RNBQKBNR b KQkq - 0 1 [e4|h7]',
            'rnbqkbnr/ppppppp1/8/7p/4P3/8/PPPP1PPP/RNBQKBNR w KQkq - 0 2 [e4|h5]',
        ];

        foreach ($history as $ply => $fen) {
            $seen = $this->redact($fen, 'w');

            $this->assertStringContainsString('[e4|-]', $seen, "ply {$ply} lost White's own secret");
            $this->assertDoesNotMatchRegularExpression(
                '/\|h[0-9]\]/',
                $seen,
                "ply {$ply} disclosed Black's secret through the move history",
            );
        }
    }

    /**
     * A FEN without the trailing field is not a canonical Secret Queen FEN (a
     * plain chess FEN, or one already redacted upstream). Passing it through
     * untouched keeps the helper safe to call unconditionally.
     */
    public function test_a_fen_without_the_field_passes_through(): void
    {
        $plain = 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1';

        $this->assertSame($plain, $this->redact($plain, 'w'));
        $this->assertNull($this->square->invoke($this->svc, $plain, 'w'));
    }
}
