<?php

namespace App\Tests\Unit;

use App\Controllers\GameResultController;
use App\Models\Game;
use PHPUnit\Framework\TestCase;
use ReflectionMethod;
use ReflectionClass;

/**
 * GameResultController::shouldEagerlyAnalyze() — the predicate that decides
 * whether a finished hub game gets an AnalyzeGameJob dispatched off-request.
 *
 * Exercised directly rather than through post(): that method is the internal
 * hub endpoint (shared-secret header, request body, DB write, Elo, arena
 * scoring), none of which this rule depends on. The controller is built
 * without its constructor for the same reason — the predicate reads only the
 * Game, not the injected services.
 */
class GameResultEagerAnalysisTest extends TestCase
{
    private ReflectionMethod $predicate;

    private GameResultController $controller;

    protected function setUp(): void
    {
        parent::setUp();

        $this->controller = (new ReflectionClass(GameResultController::class))
            ->newInstanceWithoutConstructor();
        $this->predicate = new ReflectionMethod(GameResultController::class, 'shouldEagerlyAnalyze');
        $this->predicate->setAccessible(true);
    }

    private function game(bool $rated, bool $whiteBot, bool $blackBot): Game
    {
        $game = new Game();
        $game->rated = $rated;
        $game->white_is_bot = $whiteBot;
        $game->black_is_bot = $blackBot;

        return $game;
    }

    private function shouldAnalyze(Game $game): bool
    {
        return (bool) $this->predicate->invoke($this->controller, $game);
    }

    public function testRatedHumanVsHumanIsEagerlyAnalyzed(): void
    {
        $this->assertTrue($this->shouldAnalyze($this->game(true, false, false)));
    }

    public function testRatedGameWithBotAsWhiteIsNotEagerlyAnalyzed(): void
    {
        $this->assertFalse($this->shouldAnalyze($this->game(true, true, false)));
    }

    public function testRatedGameWithBotAsBlackIsNotEagerlyAnalyzed(): void
    {
        $this->assertFalse($this->shouldAnalyze($this->game(true, false, true)));
    }

    public function testRatedBotVsBotIsNotEagerlyAnalyzed(): void
    {
        $this->assertFalse($this->shouldAnalyze($this->game(true, true, true)));
    }

    /** The pre-existing rated-only rule is unchanged by the bot rule. */
    public function testCasualHumanVsHumanIsNotEagerlyAnalyzed(): void
    {
        $this->assertFalse($this->shouldAnalyze($this->game(false, false, false)));
    }
}
