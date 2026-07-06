<?php

namespace App\Models;

use Override;
use BaseApi\Models\BaseModel;

/**
 * A single "Guess the Elo" round (SPEC §Guess the Elo). The server generates a
 * full gomachine-vs-itself game at a SECRET target Elo, the client watches it,
 * then guesses the strength — and only AFTER guessing is the true rating
 * revealed. The whole point is anti-cheat: `rating` is the answer and MUST NEVER
 * reach the client until the guess is locked in, so it is stripped from API
 * output while unanswered.
 *
 * NOTE: BaseAPI's `array`/`json` casts decode on read but do NOT encode on write
 * (see vendor CLAUDE.md), so the move list is stored in a TEXT column as
 * `?string` and round-tripped explicitly via getMoves/setMoves.
 */
class GuessGame extends BaseModel
{
    /** SECRET answer: the human-scale target Elo the game was played at
     *  (700..2500). Never exposed until the round is answered. */
    public int $rating = 1500;

    /** Terminal status label (checkmate | stalemate | draw-* | draw-claimed). */
    public string $status = 'ongoing';

    /** Final result: '1-0' | '0-1' | '1/2-1/2'. Safe to expose (visible on the
     *  board anyway) — it does not reveal the rating. */
    public string $result = '1/2-1/2';

    /** Move list as JSON text: [{ply, uci, san, fen}]. Use getMoves/setMoves. */
    public ?string $moves = null;

    /** The player who guessed, if signed in (optional; anonymous = null). */
    public ?string $user_id = null;

    /** The user's locked-in guess (human Elo), or null until answered. */
    public ?int $guess = null;

    /** Score 0..100 for the guess, or null until answered. */
    public ?int $score = null;

    /** ISO-8601 timestamp the guess was locked in; null while unanswered. Also
     *  the one-shot guard — a second guess returns the stored result unchanged. */
    public ?string $answered_at = null;

    /**
     * @var array<string, string>
     */
    public static array $indexes = [
        'user_id' => 'index',
    ];

    /**
     * @var array<string, array<string, mixed>>
     */
    public static array $columns = [
        'moves' => ['type' => 'TEXT', 'nullable' => true],
    ];

    /** @return list<array<string, mixed>> */
    public function getMoves(): array
    {
        if ($this->moves === null || $this->moves === '') {
            return [];
        }
        $decoded = json_decode($this->moves, true);

        return is_array($decoded) ? array_values($decoded) : [];
    }

    /** @param list<array<string, mixed>> $moves */
    public function setMoves(array $moves): void
    {
        $this->moves = json_encode(array_values($moves));
    }

    public function isAnswered(): bool
    {
        return $this->guess !== null && $this->score !== null;
    }

    /**
     * Never leak the secret `rating` (nor the internal owner) until the round is
     * answered; always expose `moves` as a decoded array.
     *
     * @return array<string, mixed>
     */
    #[Override]
    public function jsonSerialize(): array
    {
        $data = parent::jsonSerialize();
        $data['moves'] = $this->getMoves();
        unset($data['user_id']);
        if (!$this->isAnswered()) {
            unset($data['rating']);
        }

        return $data;
    }
}
