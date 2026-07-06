<?php

namespace App\Jobs;

use Override;
use Throwable;
use BaseApi\App;
use BaseApi\Queue\Job;
use App\Models\Game;
use App\Services\GameAnalysisService;

/**
 * Precompute (and cache) a finished game's full-game analysis in the background,
 * so opening the review board is an instant cache hit instead of a ~2 s engine
 * burst on the user's click. Dispatched by {@see \App\Controllers\GameResultController}
 * when a RATED game is persisted (the only games worth the eager engine cost).
 *
 * The heavy lifting + caching lives in {@see GameAnalysisService::analyze()}: it
 * is idempotent (VERSION-keyed cache on the Game), so a re-run — or a user GET
 * that races this job — recomputes at most once and never conflicts. We carry
 * only the hub game id (a serializable scalar) as the payload and resolve the
 * service from the container inside handle().
 */
class AnalyzeGameJob extends Job
{
    // The engine call can transiently fail (RuntimeException on no positions if
    // the engine is momentarily unreachable); a couple of retries ride that out.
    protected int $maxRetries = 2;

    protected int $retryDelay = 20; // seconds

    public function __construct(private readonly string $hubGameId)
    {
    }

    #[Override]
    public function handle(): void
    {
        $game = Game::firstWhere('hub_game_id', '=', $this->hubGameId);
        if (!$game instanceof Game || $game->getMoves() === []) {
            return; // game gone or empty — nothing to analyze
        }

        // analyze() computes + persists the payload on the Game (setAnalysis + save),
        // or returns the cached one if a GET already warmed it. Cheap on a cache hit.
        $analysis = App::container()->make(GameAnalysisService::class);
        $analysis->analyze($game);
    }

    #[Override]
    public function failed(Throwable $throwable): void
    {
        error_log(sprintf(
            'AnalyzeGameJob failed for hub game %s: %s',
            $this->hubGameId,
            $throwable->getMessage(),
        ));
        parent::failed($throwable);
    }
}
