<?php

namespace App\Services;

use App\Models\BotGame;

/**
 * Game logic for human-vs-AI play. PHP owns persistence and orchestration; the
 * gomachine engine owns rules + AI (SPEC §3, §7.2). A human move is validated
 * and applied by the engine, then — if it becomes the bot's turn — the bot's
 * reply is computed and applied in the same request (synchronous; fine for
 * untimed v1 play).
 */
class BotGameService
{
    public function __construct(private readonly GomachineClient $engine)
    {
    }

    /**
     * Create a new game. The bot opens whenever it is not the human's turn in
     * the starting position — i.e. the human plays Black from the standard
     * start, or picks the side that is not to move in a custom `$startFen`.
     *
     * @param string|null $startFen Optional custom starting position (e.g. carried
     *   over from the analysis board). Null = standard start.
     * @throws \InvalidArgumentException if the custom FEN is invalid or already finished.
     */
    public function create(int $level, string $humanColor, ?string $startFen = null): BotGame
    {
        $game = new BotGame();
        $game->level = max(0, min(10, $level));
        $game->human_color = $humanColor === 'b' ? 'b' : 'w';
        $game->setMoves([]);
        $game->setHistory([]);

        if ($startFen !== null && $startFen !== '') {
            $this->applyStartFen($game, $startFen);
        }

        if ($game->status === 'ongoing' && $game->side_to_move !== $game->human_color) {
            $this->playBot($game);
        }

        $game->save();

        return $game;
    }

    /**
     * Adopt a custom starting position, validating it against the engine and
     * rejecting finished positions (nothing to play from).
     *
     * @throws \InvalidArgumentException on an invalid or terminal position.
     */
    private function applyStartFen(BotGame $game, string $fen): void
    {
        $fen = trim($fen);
        try {
            $legal = $this->engine->legalMoves($fen);
        } catch (\Throwable) {
            throw new \InvalidArgumentException('invalid starting position');
        }
        if (empty($legal['moves'])) {
            throw new \InvalidArgumentException('that position is already finished');
        }
        // The active-color field is the source of truth for whose turn it is.
        $parts = explode(' ', $fen);
        $game->fen = $fen;
        $game->side_to_move = (($parts[1] ?? 'w') === 'b') ? 'b' : 'w';
    }

    /**
     * Apply the human's move, then the bot's reply if applicable.
     *
     * @return array{ok: bool, error?: string}
     */
    public function humanMove(BotGame $game, string $move): array
    {
        if ($game->status !== 'ongoing') {
            return ['ok' => false, 'error' => 'game is already over'];
        }
        if ($game->side_to_move !== $game->human_color) {
            return ['ok' => false, 'error' => 'not your turn'];
        }

        $result = $this->engine->move($game->fen, $move, $game->getHistory());
        if (empty($result['legal'])) {
            return ['ok' => false, 'error' => 'illegal move'];
        }

        $this->apply($game, $move, $result, 'human');

        if ($game->status === 'ongoing') {
            $this->playBot($game);
        }

        $game->save();

        return ['ok' => true];
    }

    /** Compute and apply one bot move on the given (ongoing) game. */
    private function playBot(BotGame $game): void
    {
        if ($game->status !== 'ongoing') {
            return;
        }
        $best = $this->engine->bestMove($game->fen, $game->level, $game->getHistory());
        $uci = $best['bestmove'] ?? null;
        if (!is_string($uci) || $uci === '') {
            return;
        }
        $result = $this->engine->move($game->fen, $uci, $game->getHistory());
        if (empty($result['legal'])) {
            return;
        }
        $this->apply($game, $uci, $result, 'bot', $best);
    }

    /**
     * Mutate the game with one applied move's result.
     *
     * @param array<string, mixed> $result Engine /move response.
     * @param array<string, mixed> $best   Engine /bestmove response (bot only).
     */
    private function apply(BotGame $game, string $uci, array $result, string $by, array $best = []): void
    {
        // Record the position we are leaving for repetition detection.
        $history = $game->getHistory();
        $history[] = $game->fen;
        $game->setHistory($history);

        $moves = $game->getMoves();
        $entry = [
            'ply' => count($moves) + 1,
            'uci' => $uci,
            'san' => is_string($result['san'] ?? null) ? $result['san'] : $uci,
            'by' => $by,
            'fen' => is_string($result['newFen'] ?? null) ? $result['newFen'] : $game->fen,
        ];
        if ($by === 'bot' && isset($best['eval'])) {
            $entry['eval'] = $best['eval'];
        }
        $moves[] = $entry;
        $game->setMoves($moves);

        $game->fen = is_string($result['newFen'] ?? null) ? $result['newFen'] : $game->fen;
        $game->side_to_move = is_string($result['sideToMove'] ?? null) ? $result['sideToMove'] : $game->side_to_move;
        $game->status = is_string($result['status'] ?? null) ? $result['status'] : 'ongoing';
        if (!empty($result['result'])) {
            $game->result = $result['result'];
        }
    }

    /**
     * Build the API representation: the game plus the legal moves available to
     * the side to move and a your_turn flag.
     *
     * @return array<string, mixed>
     */
    public function present(BotGame $game): array
    {
        $data = $game->jsonSerialize();
        $data['legal_moves'] = [];
        if ($game->status === 'ongoing') {
            $legal = $this->engine->legalMoves($game->fen);
            $data['legal_moves'] = $legal['moves'] ?? [];
        }
        $data['your_turn'] = $game->status === 'ongoing' && $game->side_to_move === $game->human_color;

        return $data;
    }
}
