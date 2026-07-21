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
 *                            variant?: "standard"|"chess960"|"duck"|"crazyhouse"|"antichess" }
 *   GET  /bot-games/{id}
 *
 * `rating` is the bot's target Elo (the engine maps it to a weakening config).
 * An optional `fen` starts the game from a custom position (carried over from
 * the analysis board); omitted = the standard start position. `variant` selects
 * the ruleset (default "standard"); Chess960 passes a 960 start FEN through the
 * standard flow, while "duck", "crazyhouse", and "antichess" ignore `fen` and
 * start from the standard position.
 */
class BotGameController extends Controller
{
    public string $id = '';

    public int $rating = 1500;

    public string $human_color = 'w';

    public string $fen = '';

    public string $variant = 'standard';

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
            'variant' => 'string|in:standard,chess960,duck,crazyhouse,antichess',
        ]);

        try {
            $game = $this->games->create(
                $this->rating,
                $this->human_color,
                $this->fen !== '' ? $this->fen : null,
                $this->variant !== '' ? $this->variant : 'standard',
            );
        } catch (\InvalidArgumentException $e) {
            return JsonResponse::badRequest($e->getMessage());
        }

        return JsonResponse::created($this->games->present($game));
    }
}
