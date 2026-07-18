<?php

namespace App\Services;

use App\Models\BotGame;

/**
 * Game logic for human-vs-AI play. PHP owns persistence and orchestration; the
 * engine owns rules + AI (SPEC §3, §7.2) — zugzwang-primary with automatic
 * gomachine fallback via {@see EngineSelector} (WIRING_RECON.md §B). A human
 * move is validated and applied by the engine, then — if it becomes the bot's
 * turn — the bot's reply is computed and applied in the same request
 * (synchronous; fine for untimed v1 play).
 */
class BotGameService
{
    /**
     * Human-facing bot strength bounds — the FIDE/human scale the picker + Glicko use.
     * The zugzwang engine's `limits.rating` ladder is calibrated on this same
     * engine's own scale (RatingMin=700 .. RatingMax=3500 = full engine strength,
     * ~3500 CCRL), so this rating is forwarded to the engine as-is — no conversion.
     */
    public const RATING_MIN = 700;
    public const RATING_MAX = 3500;

    public function __construct(private readonly EngineSelector $engine)
    {
    }

    /**
     * Create a new game. The bot opens whenever it is not the human's turn in
     * the starting position — i.e. the human plays Black from the standard
     * start, or picks the side that is not to move in a custom `$startFen`.
     *
     * @param string|null $startFen Optional custom starting position (e.g. carried
     *   over from the analysis board). Null = standard start. Ignored for Duck Chess,
     *   which always starts from the standard position with no duck placed.
     * @param string $variant 'standard' | 'chess960' | 'duck'. Chess960 uses the
     *   standard engine flow (the engine parses 960 FENs); Duck Chess uses the
     *   dedicated /duck/* endpoints.
     * @throws \InvalidArgumentException if the custom FEN is invalid or already finished.
     */
    public function create(int $rating, string $humanColor, ?string $startFen = null, string $variant = 'standard'): BotGame
    {
        $game = new BotGame();
        $game->variant = in_array($variant, ['standard', 'chess960', 'duck', 'crazyhouse'], true) ? $variant : 'standard';
        // rating<=0 is the "Unlosable" sentinel — kept verbatim (0), NOT clamped up to
        // RATING_MIN, so playBot() routes it to the worst-move engine. Real ratings
        // clamp to the human ladder [RATING_MIN, RATING_MAX].
        $game->rating = $rating <= 0 ? 0 : max(self::RATING_MIN, min(self::RATING_MAX, $rating));
        $game->human_color = $humanColor === 'b' ? 'b' : 'w';
        $game->setMoves([]);
        $game->setHistory([]);

        if ($game->variant === 'duck') {
            // Duck Chess always starts from the standard position (the model
            // defaults: standard start FEN, duck=null, White to move); a custom
            // start FEN is not supported. Open with a duck bot move if the human
            // is Black.
            if ($game->status === 'ongoing' && $game->side_to_move !== $game->human_color) {
                $this->playDuckBot($game);
            }
        } elseif ($game->variant === 'crazyhouse') {
            // Crazyhouse always starts from the standard opening with empty
            // pockets; the FEN carries the pocket ("[]"), so no custom start FEN
            // and no extra column are needed. Open with a bot move if human is Black.
            $game->fen = 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR[] w KQkq - 0 1';
            if ($game->status === 'ongoing' && $game->side_to_move !== $game->human_color) {
                $this->playCrazyhouseBot($game);
            }
        } else {
            // Standard and Chess960 share the same flow: applyStartFen validates
            // any provided FEN via the engine (which now understands 960 castling).
            if ($startFen !== null && $startFen !== '') {
                $this->applyStartFen($game, $startFen);
            }

            if ($game->status === 'ongoing' && $game->side_to_move !== $game->human_color) {
                $this->playBot($game);
            }
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

        if ($game->variant === 'duck') {
            $result = $this->engine->duckMove($game->fen, $game->duck ?? '', $move);
            if (empty($result['legal'])) {
                return ['ok' => false, 'error' => is_string($result['error'] ?? null) ? $result['error'] : 'illegal move'];
            }

            $this->applyDuck($game, $move, $result, 'human');

            if ($game->status === 'ongoing') {
                $this->playDuckBot($game);
            }

            $game->save();

            return ['ok' => true];
        }

        if ($game->variant === 'crazyhouse') {
            // Crazyhouse move ("e2e4" / "e7e8q" / drop "P@e4"); the FEN carries the
            // pocket, so it reuses the standard apply() (the engine ignores history).
            $result = $this->engine->crazyhouseMove($game->fen, $move);
            if (empty($result['legal'])) {
                return ['ok' => false, 'error' => is_string($result['error'] ?? null) ? $result['error'] : 'illegal move'];
            }

            $this->apply($game, $move, $result, 'human');

            if ($game->status === 'ongoing') {
                $this->playCrazyhouseBot($game);
            }

            $game->save();

            return ['ok' => true];
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

    /**
     * Undo the human's last move, including any bot reply that followed it, so
     * it becomes the human's turn again in the position before that move.
     *
     * Trailing bot move(s) are dropped first, then the human's move. If the
     * human hasn't moved yet (nothing of theirs to take back), this is a no-op
     * and reports an error.
     *
     * @return array{ok: bool, error?: string}
     */
    public function undo(BotGame $game): array
    {
        // Duck Chess undo is out of scope (the duck endpoints carry no history).
        if ($game->variant === 'duck') {
            return ['ok' => false, 'error' => 'undo is not available in Duck Chess'];
        }

        $moves = $game->getMoves();
        $history = $game->getHistory();
        if ($moves === []) {
            return ['ok' => false, 'error' => 'nothing to undo'];
        }

        $newMoves = $moves;
        $newHistory = $history;

        // Drop the bot's reply (and any trailing bot moves), then require a
        // human move to take back — otherwise the human hasn't moved.
        while ($newMoves !== [] && (end($newMoves)['by'] ?? '') === 'bot') {
            array_pop($newMoves);
            array_pop($newHistory);
        }
        if ($newMoves === [] || (end($newMoves)['by'] ?? '') !== 'human') {
            return ['ok' => false, 'error' => 'nothing to undo'];
        }
        array_pop($newMoves);
        array_pop($newHistory);

        // Re-number the surviving plies (1..N) so they stay contiguous.
        $reindexed = [];
        foreach (array_values($newMoves) as $i => $m) {
            $m['ply'] = $i + 1;
            $reindexed[] = $m;
        }

        // The position before that human move is the last surviving move's
        // resulting FEN — or, if none survive, the game's original start (the
        // first recorded history entry).
        if ($reindexed === []) {
            $game->fen = is_string($history[0] ?? null) ? $history[0] : $game->fen;
        } else {
            $last = $reindexed[count($reindexed) - 1];
            $game->fen = is_string($last['fen'] ?? null) ? $last['fen'] : $game->fen;
        }

        $game->setMoves($reindexed);
        $game->setHistory(array_values($newHistory));
        $parts = explode(' ', $game->fen);
        $game->side_to_move = (($parts[1] ?? 'w') === 'b') ? 'b' : 'w';
        $game->status = 'ongoing';
        $game->result = null;
        $game->save();

        return ['ok' => true];
    }

    /** Compute and apply one bot move on the given (ongoing) game. */
    private function playBot(BotGame $game): void
    {
        if ($game->status !== 'ongoing') {
            return;
        }
        // The "Unlosable" bot (sentinel rating 0, the /bot slider's lowest stop) is
        // Standard rules with the engine playing the WORST move it can find; every
        // real rating (>=RATING_MIN) plays its advertised strength.
        $best = $game->rating <= 0
            ? $this->engine->worstMove($game->fen, $game->getHistory())
            : $this->engine->bestMove(
                $game->fen,
                $game->rating,
                $game->getHistory(),
            );
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
     * Compute and apply one Crazyhouse bot move. The RAW human rating is passed
     * (the engine's rating ladder is human-scale, same as playBot() and Duck).
     * The bestmove is already applied engine-side, so its response carries the
     * resulting newFen/pocket/status/result.
     */
    private function playCrazyhouseBot(BotGame $game): void
    {
        if ($game->status !== 'ongoing') {
            return;
        }
        $best = $this->engine->crazyhouseBestMove($game->fen, $game->rating);
        $uci = $best['bestmove'] ?? null;
        if (!is_string($uci) || $uci === '') {
            return;
        }
        $this->apply($game, $uci, $best, 'bot', $best);
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
     * Compute and apply one Duck Chess bot move on the given (ongoing) game.
     * The RAW human rating is passed (the engine's rating ladder is human-scale,
     * same as playBot() and Crazyhouse). The bestmove is already applied
     * engine-side, so its response carries the resulting newFen/duck/status/result.
     */
    private function playDuckBot(BotGame $game): void
    {
        if ($game->status !== 'ongoing') {
            return;
        }
        $best = $this->engine->duckBestMove($game->fen, $game->duck ?? '', $game->rating);
        $uci = $best['bestmove'] ?? null;
        if (!is_string($uci) || $uci === '') {
            return;
        }
        $this->applyDuck($game, $uci, $best, 'bot', $best);
    }

    /**
     * Mutate the game with one applied Duck Chess move's result. Unlike the
     * standard apply(), this stores the resulting `duck` square on both the game
     * and the move entry (so the frontend can show the duck per historical ply),
     * and does NOT push a repetition-history FEN (the duck endpoints are stateless
     * and take no history).
     *
     * @param array<string, mixed> $result Engine /duck/move or /duck/bestmove response.
     * @param array<string, mixed> $best   Engine /duck/bestmove response (bot only, for eval).
     */
    private function applyDuck(BotGame $game, string $uci, array $result, string $by, array $best = []): void
    {
        $moves = $game->getMoves();
        $entry = [
            'ply' => count($moves) + 1,
            'uci' => $uci,
            'san' => is_string($result['san'] ?? null) ? $result['san'] : $uci,
            'by' => $by,
            'fen' => is_string($result['newFen'] ?? null) ? $result['newFen'] : $game->fen,
            'duck' => is_string($result['duck'] ?? null) ? $result['duck'] : null,
        ];
        if ($by === 'bot' && isset($best['eval'])) {
            $entry['eval'] = $best['eval'];
        }
        $moves[] = $entry;
        $game->setMoves($moves);

        $game->fen = is_string($result['newFen'] ?? null) ? $result['newFen'] : $game->fen;
        $game->duck = is_string($result['duck'] ?? null) ? $result['duck'] : $game->duck;
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
            $legal = match ($game->variant) {
                'duck' => $this->engine->duckLegalMoves($game->fen, $game->duck ?? ''),
                'crazyhouse' => $this->engine->crazyhouseLegalMoves($game->fen),
                default => $this->engine->legalMoves($game->fen),
            };
            $data['legal_moves'] = $legal['moves'] ?? [];
        }
        $data['your_turn'] = $game->status === 'ongoing' && $game->side_to_move === $game->human_color;

        return $data;
    }
}
