<?php

namespace App\Controllers;

use BaseApi\Controllers\Controller;
use BaseApi\Http\JsonResponse;
use App\Models\BotGame;
use App\Services\BotGameService;

/**
 * Create and fetch human-vs-AI games (SPEC §6). Public/guest — no auth required
 * to play the bot.
 *
 *   POST /bot-games        { rating?: 0|700..3500, human_color?: "w"|"b", fen?: string,
 *                            variant?: "standard"|"chess960"|"duck"|"crazyhouse"|"antichess"|
 *                                      "secretqueen"|"fading"|"glassjaw"|"doublemove",
 *                            secret_square?: string,
 *                            time_control?: "1+0"|"3+0"|"3+2"|"5+0"|"10+0"|"15+10" }
 *   GET  /bot-games/{id}
 *
 * `rating` is the bot's target Elo (the engine maps it to a weakening config).
 * An optional `fen` starts the game from a custom position (carried over from
 * the analysis board); omitted = the standard start position. `variant` selects
 * the ruleset (default "standard"); Chess960 passes a 960 start FEN through the
 * standard flow, while "duck", "crazyhouse", "antichess", and "secretqueen"
 * ignore `fen` and start from the standard position. "fading", "glassjaw", and
 * "doublemove" are standard-rules handicap modes (see BotGameService) that also
 * share the standard flow. `secret_square` is Secret Queen only — the human's
 * chosen pawn (e.g. "e2"); omitted/invalid picks one at random from their own
 * home rank (see BotGameService::create()). `time_control` is omitted/empty for
 * an untimed game (the default); otherwise the server owns the clock end to end
 * (see BotGameService's clock rules) — the client clock is display only.
 */
class BotGameController extends Controller
{
    public string $id = '';

    public int $rating = 1500;

    public string $human_color = 'w';

    public string $fen = '';

    public string $variant = 'standard';

    /** Secret Queen only — the human's chosen pawn square, e.g. "e2". */
    public string $secret_square = '';

    public string $time_control = '';

    public function __construct(private readonly BotGameService $games)
    {
    }

    public function get(): JsonResponse
    {
        if ($this->id === '') {
            return JsonResponse::badRequest('game id is required');
        }
        $game = BotGame::find($this->id);
        if (!$game instanceof BotGame) {
            return JsonResponse::notFound('game not found');
        }

        return JsonResponse::ok($this->games->present($game));
    }

    public function post(): JsonResponse
    {
        $this->validate([
            // rating 0 = the "Unlosable" bot (Standard rules, engine plays the WORST
            // move); real bot strengths are 700..3500 (3500 = full engine strength).
            // min:0 admits the sentinel.
            'rating' => 'integer|min:0|max:3500',
            'human_color' => 'in:w,b',
            'fen' => 'string',
            'variant' => 'string|in:standard,chess960,duck,crazyhouse,antichess,secretqueen,fading,glassjaw,doublemove',
            // Loosely validated here — the service is the one place that knows
            // what "valid" means (a pawn on the human's own home rank), and
            // falls back to a random pick on anything that isn't, so there's
            // nothing to gain from duplicating that check at the controller.
            'secret_square' => 'string|max:2',
            // Empty (untimed, the default) skips this check entirely — only a
            // non-empty value is validated against the offered ladder.
            'time_control' => 'string|in:1+0,3+0,3+2,5+0,10+0,15+10',
        ]);

        try {
            $game = $this->games->create(
                $this->rating,
                $this->human_color,
                $this->fen !== '' ? $this->fen : null,
                $this->variant !== '' ? $this->variant : 'standard',
                $this->time_control !== '' ? $this->time_control : null,
                $this->secret_square !== '' ? $this->secret_square : null,
            );
        } catch (\InvalidArgumentException $e) {
            return JsonResponse::badRequest($e->getMessage());
        }

        return JsonResponse::created($this->games->present($game));
    }
}
