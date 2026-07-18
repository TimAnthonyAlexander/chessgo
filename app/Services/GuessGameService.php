<?php

namespace App\Services;

use App\Models\GuessGame;

/**
 * "Guess the Elo" game generator + scorer (SPEC §Guess the Elo).
 *
 * A round is a full gomachine-vs-itself game played at a SECRET human-scale
 * target Elo. The engine owns all rules + play; this service just drives the
 * self-play loop ply-by-ply (bestmove → apply) at a fixed think time, persists
 * the game, and later scores the user's guess against the hidden rating.
 *
 * Both sides play at the SAME rating — the guess is that one number. The rating
 * is stored server-side and never returned until the guess is locked in.
 */
class GuessGameService
{
    /** Fixed think time per ply. Fast enough to generate a game in a couple of
     *  seconds, long enough that the rating (not the clock) shapes strength. */
    private const MOVETIME_MS = 30;

    /** Hard ply backstop so two equal engines can't shuffle forever; drawn
     *  positions are claimed far earlier (threefold/fifty), so this rarely binds. */
    private const PLY_CAP = 200;

    /** Human-scale rating band the user guesses within. */
    public const RATING_MIN = 700;
    public const RATING_MAX = 2500;
    /** Slider/guess granularity — ratings are sampled on this grid. */
    private const RATING_STEP = 25;

    /** Standard start position. */
    private const START_FEN = 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1';

    public function __construct(private readonly EngineSelector $engine)
    {
    }

    /**
     * Generate + persist one round. Picks a random secret rating, plays the game
     * out via engine self-play, and stores it.
     *
     * @throws \RuntimeException if the engine is unreachable.
     */
    public function generate(?string $userId): GuessGame
    {
        $human = $this->randomRating();
        // The engine owns the rating→strength relationship natively — pass the
        // human/FIDE rating straight through (no client-side ladder remap).
        $engineRating = $human;

        $fen = self::START_FEN;
        /** @var list<string> $history Prior-position FENs (repetition detection). */
        $history = [];
        /** @var list<array<string, mixed>> $moves */
        $moves = [];
        $status = 'ongoing';
        $result = '1/2-1/2';

        for ($ply = 1; $ply <= self::PLY_CAP; $ply++) {
            // fast: the weakened search that honors MOVETIME_MS and stays cheap at
            // every rating — without it a mid-band game takes minutes to generate.
            $best = $this->engine->bestMove(
                $fen,
                $engineRating,
                $history,
                self::MOVETIME_MS,
                fast: true,
            );
            $uci = $best['bestmove'] ?? null;
            if (!is_string($uci) || $uci === '') {
                break; // no legal move (already mated/stalemated — status carried below)
            }

            $applied = $this->engine->move($fen, $uci, $history);
            if (empty($applied['legal'])) {
                break; // engine never returns an illegal move; bail defensively
            }

            $newFen = is_string($applied['newFen'] ?? null) ? $applied['newFen'] : $fen;
            $moves[] = [
                'ply' => $ply,
                'uci' => $uci,
                'san' => is_string($applied['san'] ?? null) ? $applied['san'] : $uci,
                'fen' => $newFen,
            ];

            $history[] = $fen; // the position that preceded this move
            $fen = $newFen;
            $status = is_string($applied['status'] ?? null) ? $applied['status'] : 'ongoing';

            if ($status !== 'ongoing') {
                // Only checkmate is decisive and the engine supplies its result
                // directly; any terminal without one (stalemate / draw-*) is a draw.
                $result = is_string($applied['result'] ?? null)
                    ? $applied['result']
                    : '1/2-1/2';
                break;
            }

            // Adjudicate the moment a draw becomes claimable (threefold/fifty) so
            // equal engines don't shuffle out the ply cap — both would take it.
            $claims = $applied['claimableDraws'] ?? [];
            if (is_array($claims) && $claims !== []) {
                $status = 'draw-claimed';
                $result = '1/2-1/2';
                break;
            }
        }

        $game = new GuessGame();
        $game->rating = $human;
        $game->status = $status;
        $game->result = $result;
        $game->setMoves($moves);
        $game->user_id = $userId;
        $game->save();

        return $game;
    }

    /**
     * Score a guess against the true rating: full marks for an exact hit, losing
     * one point per 10 Elo of error, floored at 0.
     */
    public function score(int $guess, int $actual): int
    {
        $delta = abs($guess - $actual);

        return max(0, 100 - intdiv($delta, 10));
    }

    /** Clamp a raw guess to the valid human band. */
    public function clampGuess(int $guess): int
    {
        return max(self::RATING_MIN, min(self::RATING_MAX, $guess));
    }

    /** A random human rating on the guess grid within the human band. */
    private function randomRating(): int
    {
        $steps = intdiv(self::RATING_MAX - self::RATING_MIN, self::RATING_STEP);

        return self::RATING_MIN + random_int(0, $steps) * self::RATING_STEP;
    }

}
