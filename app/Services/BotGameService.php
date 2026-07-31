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
     * Bot strength bounds. These live on the model (it owns `rating` and the
     * handicap curves that floor at RATING_MIN); aliased here so the service's
     * own clamping reads naturally.
     */
    public const RATING_MIN = BotGame::RATING_MIN;
    public const RATING_MAX = BotGame::RATING_MAX;

    /**
     * Below this per-move time slice (ms), the bot's remaining clock is the
     * binding constraint and an explicit movetime cap is forwarded to the
     * engine; at or above it, the clock has plenty of room and the engine's own
     * rating-driven default budget is left alone (movetime 0). Keeps a bullet
     * bot from thinking itself into a flag without slowing down games that
     * still have ample time. See botMovetimeMs().
     */
    private const BOT_MOVETIME_CEILING_MS = 1500;

    /**
     * A plain divisor (NOT a real moves-to-go estimate) used to carve a
     * per-move time slice out of the bot's remaining clock. Good enough to keep
     * a bullet/blitz bot safe; see botMovetimeMs().
     */
    private const BOT_MOVETIME_DIVISOR = 20;

    public function __construct(private readonly EngineSelector $engine)
    {
    }

    /**
     * Create a new game. The bot opens whenever it is not the human's turn in
     * the starting position — i.e. the human plays Black from the standard
     * start, or picks the side that is not to move in a custom `$startFen`.
     *
     * @param string|null $startFen Optional custom starting position (e.g. carried
     *   over from the analysis board). Null = standard start. Ignored for Duck
     *   Chess, Crazyhouse, and Antichess, which always start from the standard
     *   position (Duck with no duck placed, Crazyhouse with empty pockets).
     * @param string $variant 'standard' | 'chess960' | 'duck' | 'crazyhouse' |
     *   'antichess' | 'fading' | 'glassjaw' | 'doublemove'. Chess960 uses the
     *   standard engine flow (the engine parses 960 FENs); Duck Chess,
     *   Crazyhouse, and Antichess each use their own dedicated /duck/*,
     *   /crazyhouse/*, /antichess/* endpoints. "fading", "glassjaw", and
     *   "doublemove" are standard-rules handicap modes — they use the plain
     *   engine /move + /bestmove flow like Chess960, just with a per-move
     *   effective rating (fading/glassjaw) or an altered turn order
     *   (doublemove); see effectiveBotRating() and humanMove().
     * @param string|null $timeControl One of BotGame::TIME_CONTROLS, or null/anything
     *   else for untimed (the default) — see BotGame::parseTimeControl().
     * @throws \InvalidArgumentException if the custom FEN is invalid or already finished.
     */
    public function create(
        int $rating,
        string $humanColor,
        ?string $startFen = null,
        string $variant = 'standard',
        ?string $timeControl = null,
    ): BotGame {
        $game = new BotGame();
        $game->variant = in_array($variant, [
            'standard', 'chess960', 'duck', 'crazyhouse', 'antichess',
            'fading', 'glassjaw', 'doublemove',
        ], true) ? $variant : 'standard';
        // rating<=0 is the "Unlosable" sentinel — kept verbatim (0), NOT clamped up to
        // RATING_MIN, so playBot() routes it to the worst-move engine. Real ratings
        // clamp to the human ladder [RATING_MIN, RATING_MAX].
        $game->rating = $rating <= 0 ? 0 : max(self::RATING_MIN, min(self::RATING_MAX, $rating));
        $game->human_color = $humanColor === 'b' ? 'b' : 'w';
        $game->setMoves([]);
        $game->setHistory([]);

        $parsedTc = BotGame::parseTimeControl($timeControl);
        if ($parsedTc !== null) {
            [$baseMs] = $parsedTc;
            $game->time_control = $timeControl;
            $game->white_ms = $baseMs;
            $game->black_ms = $baseMs;
        }

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
        } elseif ($game->variant === 'antichess') {
            // Antichess (Losing Chess) always starts from the standard chess start
            // position — no pockets, no duck square, so the model's default `fen`
            // is already correct. Open with a bot move if the human is Black.
            if ($game->status === 'ongoing' && $game->side_to_move !== $game->human_color) {
                $this->playAntichessBot($game);
            }
        } else {
            // Standard, Chess960, and the three handicap modes (fading, glassjaw,
            // doublemove) share the same flow: applyStartFen validates any provided
            // FEN via the engine (which now understands 960 castling).
            if ($startFen !== null && $startFen !== '') {
                $this->applyStartFen($game, $startFen);
            }

            if ($game->status === 'ongoing' && $game->side_to_move !== $game->human_color) {
                $this->playBot($game);
            }
        }

        // Rule: the first move of the game starts the clock. If the bot just
        // opened, playXBot() above already set last_move_at (via
        // settleBotClockAfterMove) once its reply landed — the guard here only
        // covers the human-moves-first case, where nothing else would set it.
        if ($this->isTimed($game) && $game->last_move_at === null) {
            $game->last_move_at = (string) self::nowMs();
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

        // Clock: charge the human's elapsed thinking time (since last_move_at)
        // against their own clock BEFORE the submitted move is validated or
        // applied at all. A flag here ends the game outright — whatever move
        // they tried to submit is discarded, exactly like arriving too late.
        if ($this->isTimed($game) && $this->flagHumanIfOutOfTime($game)) {
            $game->save();

            return ['ok' => true];
        }

        if ($game->variant === 'duck') {
            $result = $this->engine->duckMove($game->fen, $game->duck ?? '', $move);
            if (empty($result['legal'])) {
                return ['ok' => false, 'error' => is_string($result['error'] ?? null) ? $result['error'] : 'illegal move'];
            }

            $this->applyDuck($game, $move, $result, 'human');
            $this->addHumanIncrement($game);

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
            $this->addHumanIncrement($game);

            if ($game->status === 'ongoing') {
                $this->playCrazyhouseBot($game);
            }

            $game->save();

            return ['ok' => true];
        }

        if ($game->variant === 'antichess') {
            // Antichess move ("e2e4" / "e7e8q" / king-promotion "e7e8k"); the FEN
            // is self-describing (no pockets, no duck), so this reuses the
            // standard apply() like crazyhouse. Unlike the other variants'
            // /move endpoints, the engine reports an illegal move as an HTTP 400
            // (GomachineClient::antichessMove() throws) rather than `legal:false`
            // in a 200 body — catch it and surface the same rejected-move shape.
            try {
                $result = $this->engine->antichessMove($game->fen, $move);
            } catch (\RuntimeException) {
                return ['ok' => false, 'error' => 'illegal move'];
            }

            $this->apply($game, $move, $result, 'human');
            $this->addHumanIncrement($game);

            if ($game->status === 'ongoing') {
                $this->playAntichessBot($game);
            }

            $game->save();

            return ['ok' => true];
        }

        $result = $this->engine->move($game->fen, $move, $game->getHistory());
        if (empty($result['legal'])) {
            return ['ok' => false, 'error' => 'illegal move'];
        }

        $this->apply($game, $move, $result, 'human');
        $this->addHumanIncrement($game);

        // Double Move: the human plays two plies per bot reply. After the FIRST ply
        // of the pair the bot normally passes — EXCEPT when that ply gave check.
        //
        // This is the balanced Marseillais rule: a checking first ply ENDS the turn
        // (no second ply), so the bot gets to answer the check like in normal chess.
        // Without it, a first-ply check is an unstoppable win — the bot never moves
        // in between, so the checking piece just takes the king next ply — which made
        // the variant trivially winnable. Checks stay fully legal; they only cost the
        // free tempo. Falling through here also keeps the position ordinary chess
        // (bot to move, in check) rather than the illegal "enemy king in check on your
        // own move" FEN a pass-flip would produce.
        if ($game->variant === 'doublemove'
            && $game->status === 'ongoing'
            && empty($result['check'])
            && $this->isFirstDoubleMove($game)
        ) {
            // Quiet first ply: the bot "passes" by flipping the side to move back to
            // the human for their second ply.
            $flipped = $this->flipSideToMove($game->fen);
            $game->fen = $flipped;
            $parts = explode(' ', $flipped);
            $game->side_to_move = (($parts[1] ?? 'w') === 'b') ? 'b' : 'w';

            // Stalemate probe: the human's own move was legal, so they were not in
            // check before it — if the flipped position now has zero legal moves
            // for them, that can only be stalemate (not "in check with no moves"),
            // so it must be resolved here rather than leaving your_turn=true stuck.
            $legal = $this->engine->legalMoves($flipped);
            if (empty($legal['moves'])) {
                $game->status = 'stalemate';
                $game->result = '1/2-1/2';
            }

            $game->save();

            return ['ok' => true];
        }

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
        // Double Move's turn order (1-2 human plies per bot reply, with a passed
        // "flip" ply that isn't recorded in moves/history) doesn't map cleanly onto
        // the trailing-bot-then-human pop below, so undo is out of scope here too.
        if ($game->variant === 'doublemove') {
            return ['ok' => false, 'error' => 'undo is not available in Double Move'];
        }
        // Timed games: rewinding moves would have to rewind the clock too (whose
        // time was actually spent thinking on the undone moves?), so undo is
        // simply disabled once a game has a time control — the least surprising
        // rule available, and consistent with how real clocks work elsewhere.
        if ($this->isTimed($game)) {
            return ['ok' => false, 'error' => 'undo is not available in a timed game'];
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
        $botColor = $game->side_to_move;
        // The "Unlosable" bot (sentinel rating 0, the /bot slider's lowest stop) is
        // Standard rules with the engine playing the WORST move it can find; every
        // real rating (>=RATING_MIN) plays its advertised strength. fading and
        // glassjaw always clamp to >=RATING_MIN (see effectiveBotRating()), so they
        // never take the worst-move path — only a stored sentinel rating of 0 on a
        // standard/chess960/doublemove game does.
        $rating = $this->effectiveBotRating($game);
        $movetimeMs = $this->botMovetimeMs($game, $botColor);
        $startedAt = microtime(true);
        $best = $rating <= 0
            ? $this->engine->worstMove($game->fen, $game->getHistory())
            : $this->engine->bestMove(
                $game->fen,
                $rating,
                $game->getHistory(),
                $movetimeMs,
            );
        if ($this->isTimed($game) && $this->flagBotIfOutOfTime($game, $botColor, $startedAt)) {
            return; // bot flagged — game already ended, no move applied
        }
        $uci = $best['bestmove'] ?? null;
        if (!is_string($uci) || $uci === '') {
            return;
        }
        $result = $this->engine->move($game->fen, $uci, $game->getHistory());
        if (empty($result['legal'])) {
            return;
        }
        $this->apply($game, $uci, $result, 'bot', $best);
        $this->settleBotClockAfterMove($game, $botColor);
    }

    // --- Clocks -------------------------------------------------------------
    //
    // Server-authoritative; the client clock is display only. Rules:
    //  1. A human move request first charges elapsed time (since last_move_at)
    //     against the human's own clock. Hitting 0 ends the game immediately —
    //     the submitted move is never applied (flagHumanIfOutOfTime()).
    //  2. Otherwise the move is applied and the increment is added to the
    //     human's clock (addHumanIncrement()).
    //  3. The bot's own think time is measured (wall clock) and deducted from
    //     its clock; hitting 0 ends the game without applying its candidate
    //     move (flagBotIfOutOfTime()). Otherwise the move is applied and the
    //     increment is added, and last_move_at resets so the human's clock
    //     starts now (settleBotClockAfterMove()) — matching the rule that the
    //     first move of the game starts the clock (create() sets it directly
    //     when the human is to move first, since no bot move runs to do it).
    //  4. The engine's requested think time is capped by the bot's remaining
    //     clock (botMovetimeMs()) so it can't flag itself on a fast time
    //     control.

    private function isTimed(BotGame $game): bool
    {
        return $game->time_control !== null;
    }

    private function clockMs(BotGame $game, string $color): int
    {
        return $color === 'w' ? ($game->white_ms ?? 0) : ($game->black_ms ?? 0);
    }

    private function setClockMs(BotGame $game, string $color, int $ms): void
    {
        if ($color === 'w') {
            $game->white_ms = $ms;
        } else {
            $game->black_ms = $ms;
        }
    }

    /** Now, in epoch milliseconds — see BotGame::$last_move_at for why this is
     *  ms rather than the app's usual second-resolution timestamp string. */
    private static function nowMs(): int
    {
        return (int) round(microtime(true) * 1000);
    }

    /** End the game on a clock flag: `$color` ran out, so the OTHER color wins. */
    private function flagTimeout(BotGame $game, string $color): void
    {
        $game->status = 'timeout';
        $game->result = $color === 'w' ? '0-1' : '1-0';
    }

    /**
     * Charge the human's elapsed thinking time (since last_move_at) against
     * their own clock. Always resets last_move_at to "now" as of this check —
     * whether or not it flags — so a later check (the next humanMove() call,
     * including a Double Move second ply where no bot reply resets it) measures
     * a fresh interval instead of double-charging the same elapsed time twice.
     * Returns true if the clock is now empty (the human loses on time).
     */
    private function flagHumanIfOutOfTime(BotGame $game): bool
    {
        $color = $game->human_color;
        $elapsed = $game->last_move_at !== null
            ? max(0, self::nowMs() - (int) $game->last_move_at)
            : 0;
        $remaining = $this->clockMs($game, $color) - $elapsed;
        $game->last_move_at = (string) self::nowMs();
        if ($remaining <= 0) {
            $this->setClockMs($game, $color, 0);
            $this->flagTimeout($game, $color);

            return true;
        }
        $this->setClockMs($game, $color, $remaining);

        return false;
    }

    /** Add the time control's increment to the human's clock, once their move
     *  has actually been applied (called after every successful human move). */
    private function addHumanIncrement(BotGame $game): void
    {
        if (!$this->isTimed($game)) {
            return;
        }
        [, $incMs] = BotGame::parseTimeControl($game->time_control) ?? [0, 0];
        if ($incMs > 0) {
            $this->setClockMs($game, $game->human_color, $this->clockMs($game, $game->human_color) + $incMs);
        }
    }

    /**
     * The movetime (ms) to forward to the engine for the bot's next move, given
     * its remaining clock — 0 (untimed, or the engine's own rating-driven
     * default) once the clock still affords more than
     * BOT_MOVETIME_CEILING_MS per this rough per-move slice. See the class-level
     * constants for why.
     */
    private function botMovetimeMs(BotGame $game, string $botColor): int
    {
        if (!$this->isTimed($game)) {
            return 0;
        }
        $remaining = $this->clockMs($game, $botColor);
        $slice = max(50, intdiv($remaining, self::BOT_MOVETIME_DIVISOR));

        return $slice < self::BOT_MOVETIME_CEILING_MS ? $slice : 0;
    }

    /**
     * Deduct the bot's just-spent think time (wall clock since $startedAt) from
     * its own clock. Returns true and ends the game (status=timeout, no move
     * applied) if that empties it; otherwise just updates the clock — the
     * increment is added later, only once the move is actually applied
     * (settleBotClockAfterMove), mirroring the human side's charge-then-apply order.
     */
    private function flagBotIfOutOfTime(BotGame $game, string $botColor, float $startedAt): bool
    {
        $thinkMs = (int) round((microtime(true) - $startedAt) * 1000);
        $remaining = $this->clockMs($game, $botColor) - $thinkMs;
        if ($remaining <= 0) {
            $this->setClockMs($game, $botColor, 0);
            $this->flagTimeout($game, $botColor);

            return true;
        }
        $this->setClockMs($game, $botColor, $remaining);

        return false;
    }

    /** Add the increment and restart the human's clock now that the bot's reply
     *  has landed (last_move_at resets here, not on the human's turn — see the
     *  class-level clock rules). No-op once the game is no longer ongoing (the
     *  bot's move itself ended it — nothing left to time). */
    private function settleBotClockAfterMove(BotGame $game, string $botColor): void
    {
        if (!$this->isTimed($game) || $game->status !== 'ongoing') {
            return;
        }
        [, $incMs] = BotGame::parseTimeControl($game->time_control) ?? [0, 0];
        if ($incMs > 0) {
            $this->setClockMs($game, $botColor, $this->clockMs($game, $botColor) + $incMs);
        }
        $game->last_move_at = (string) self::nowMs();
    }

    /**
     * The rating the bot plays this move at. Standard, Chess960, and Double Move
     * forward the game's stored `rating` unchanged (Double Move's handicap is the
     * turn order, not strength); fading and glassjaw derive theirs from the move
     * history.
     *
     * The curves live on the model (BotGame::effectiveRating) because the same
     * number is serialized to the client — computing it twice was how the UI ended
     * up advertising a static "~3500 Elo" for opponents that were already hundreds
     * of Elo weaker. One definition, both callers.
     */
    private function effectiveBotRating(BotGame $game): int
    {
        return $game->effectiveRating();
    }

    /**
     * True when the human move just applied was the FIRST of a Double Move pair —
     * i.e. the number of trailing consecutive human moves at the end of the move
     * list (after applying this move) is odd. A bot-opened game's first human
     * reply is trailing-count 1 (odd = first), matching the spec.
     */
    private function isFirstDoubleMove(BotGame $game): bool
    {
        $moves = $game->getMoves();
        $trailingHuman = 0;
        for ($i = count($moves) - 1; $i >= 0; $i--) {
            if (($moves[$i]['by'] ?? null) !== 'human') {
                break;
            }
            $trailingHuman++;
        }

        return $trailingHuman % 2 === 1;
    }

    /**
     * Flip the side to move in a FEN without changing the position — used by
     * Double Move's "pass" (the bot skips its reply after the human's first ply).
     * Clears the en-passant field (field 3), since a passed move means no pawn
     * just double-stepped for the flipped side to capture. Castling rights and
     * clocks are left untouched. Malformed FENs (fewer than 4 space-separated
     * fields) are returned unchanged rather than guessed at.
     */
    private function flipSideToMove(string $fen): string
    {
        $parts = explode(' ', $fen);
        if (count($parts) < 4) {
            return $fen;
        }
        $parts[1] = $parts[1] === 'w' ? 'b' : 'w';
        $parts[3] = '-';

        return implode(' ', $parts);
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
        $botColor = $game->side_to_move;
        $movetimeMs = $this->botMovetimeMs($game, $botColor);
        $startedAt = microtime(true);
        $best = $this->engine->crazyhouseBestMove($game->fen, $game->rating, $movetimeMs);
        if ($this->isTimed($game) && $this->flagBotIfOutOfTime($game, $botColor, $startedAt)) {
            return;
        }
        $uci = $best['bestmove'] ?? null;
        if (!is_string($uci) || $uci === '') {
            return;
        }
        $this->apply($game, $uci, $best, 'bot', $best);
        $this->settleBotClockAfterMove($game, $botColor);
    }

    /**
     * Compute and apply one Antichess bot move. The RAW human rating is passed
     * (the engine's rating ladder is human-scale, same as playBot(), Duck, and
     * Crazyhouse). The bestmove is already applied engine-side, so its response
     * carries the resulting newFen/sideToMove/status/result.
     */
    private function playAntichessBot(BotGame $game): void
    {
        if ($game->status !== 'ongoing') {
            return;
        }
        $botColor = $game->side_to_move;
        $movetimeMs = $this->botMovetimeMs($game, $botColor);
        $startedAt = microtime(true);
        $best = $this->engine->antichessBestMove($game->fen, $game->rating, $movetimeMs);
        if ($this->isTimed($game) && $this->flagBotIfOutOfTime($game, $botColor, $startedAt)) {
            return;
        }
        $uci = $best['bestmove'] ?? null;
        if (!is_string($uci) || $uci === '') {
            return;
        }
        $this->apply($game, $uci, $best, 'bot', $best);
        $this->settleBotClockAfterMove($game, $botColor);
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
        $botColor = $game->side_to_move;
        $movetimeMs = $this->botMovetimeMs($game, $botColor);
        $startedAt = microtime(true);
        $best = $this->engine->duckBestMove($game->fen, $game->duck ?? '', $game->rating, $movetimeMs);
        if ($this->isTimed($game) && $this->flagBotIfOutOfTime($game, $botColor, $startedAt)) {
            return;
        }
        $uci = $best['bestmove'] ?? null;
        if (!is_string($uci) || $uci === '') {
            return;
        }
        $this->applyDuck($game, $uci, $best, 'bot', $best);
        $this->settleBotClockAfterMove($game, $botColor);
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
                'antichess' => $this->engine->antichessLegalMoves($game->fen),
                default => $this->engine->legalMoves($game->fen),
            };
            $data['legal_moves'] = $legal['moves'] ?? [];
        }
        $data['your_turn'] = $game->status === 'ongoing' && $game->side_to_move === $game->human_color;

        return $data;
    }
}
