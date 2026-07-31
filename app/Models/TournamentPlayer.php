<?php

namespace App\Models;

use BaseApi\Models\BaseModel;

/**
 * One account's standing in one {@see Tournament} (Arena scoring). A row is
 * created on join (or re-created/un-withdrawn on re-join) and updated by
 * {@see \App\Controllers\GameResultController} every time a tournament game
 * finishes.
 *
 * Scoring (see GameResultController::applyTournamentScoring()): win = 2,
 * draw = 1, loss = 0, plus a streak bonus — a win while already on a 2+ game
 * win streak in this tournament scores 4 instead of 2. `streak` counts
 * consecutive wins and resets to 0 on a draw or loss.
 */
class TournamentPlayer extends BaseModel
{
    public string $tournament_id = '';

    public string $user_id = '';

    public int $score = 0;

    public int $games = 0;

    /** Consecutive wins in this tournament (resets to 0 on a draw/loss). */
    public int $streak = 0;

    public bool $withdrawn = false;

    /**
     * @var array<int|string, mixed>
     */
    public static array $indexes = [
        ['tournament_id', 'user_id', 'type' => 'unique'],
        ['tournament_id', 'score'],
    ];
}
