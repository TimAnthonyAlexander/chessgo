<?php

namespace App\Models;

use Override;
use BaseApi\Models\BaseModel;

/**
 * A single human-vs-AI game. The gomachine engine owns all chess rules; this
 * model is just the persisted game state. See docs/SPEC.md §3, §6.
 *
 * NOTE: BaseAPI's `array`/`json` casts decode on read but do NOT encode on
 * write (see vendor CLAUDE.md), so JSON-shaped data is stored in TEXT columns
 * as `?string` and round-tripped explicitly via the accessors below.
 *
 * `history_fens` holds the FENs of all prior positions and is passed to the
 * engine for repetition-aware draw detection; it is internal and stripped from
 * API output.
 */
class BotGame extends BaseModel
{
    /**
     * Human-facing bot strength bounds — the FIDE/human scale the picker + Glicko use.
     * The zugzwang engine's `limits.rating` ladder is calibrated on this same
     * engine's own scale (RatingMin=700 .. RatingMax=3500 = full engine strength,
     * ~3500 CCRL), so this rating is forwarded to the engine as-is — no conversion.
     */
    public const RATING_MIN = 700;
    public const RATING_MAX = 3500;

    /** AI strength as a target Elo (RatingMin..RatingMax ≈ 700..2900). The
     *  engine maps this to a weakening config; see gomachine internal/engine
     *  rating.go. Replaces the old 0..10 level. */
    public int $rating = 1500;

    /** The human's color: 'w' or 'b'. */
    public string $human_color = 'w';

    /** Game variant: 'standard' | 'chess960' | 'duck' | 'crazyhouse' | 'antichess'.
     *  Standard and Chess960 share the same engine flow (the engine parses 960
     *  FENs); Duck Chess uses the dedicated /duck/* endpoints and carries a duck
     *  square below; Crazyhouse uses /crazyhouse/* (the FEN carries the pocket);
     *  Antichess (Losing Chess) uses /antichess/* and is otherwise a plain FEN —
     *  no pockets, no duck square. */
    public string $variant = 'standard';

    /** Duck Chess only: the square the duck occupies (e.g. "e5"), or null when
     *  the game is standard/960 or the duck has not yet been placed. */
    public ?string $duck = null;

    /** Current position (FEN). Defaults to the standard start position. */
    public string $fen = 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1';

    /** Side to move: 'w' or 'b' (mirror of the FEN for convenience). */
    public string $side_to_move = 'w';

    /** ongoing | checkmate | stalemate | draw-* (see SPEC §5.4). */
    public string $status = 'ongoing';

    /** Final result once over: '1-0' | '0-1' | '1/2-1/2', else null. */
    public ?string $result = null;

    /** Move list as JSON text: [{ply, uci, san, by, eval?}]. Use getMoves/setMoves. */
    public ?string $moves = null;

    /** Prior-position FENs as JSON text (engine repetition history). Internal. */
    public ?string $history_fens = null;

    /**
     * @var array<string, string>
     */
    public static array $indexes = [
        'status' => 'index',
    ];

    /**
     * @var array<string, array<string, mixed>>
     */
    public static array $columns = [
        'moves' => ['type' => 'TEXT', 'nullable' => true],
        'history_fens' => ['type' => 'TEXT', 'nullable' => true],
    ];

    /** @return list<array<string, mixed>> */
    public function getMoves(): array
    {
        return $this->decodeList($this->moves);
    }

    /** @param list<array<string, mixed>> $moves */
    public function setMoves(array $moves): void
    {
        $this->moves = json_encode(array_values($moves));
    }

    /** @return list<string> */
    public function getHistory(): array
    {
        return $this->decodeList($this->history_fens);
    }

    /** @param list<string> $history */
    public function setHistory(array $history): void
    {
        $this->history_fens = json_encode(array_values($history));
    }

    /**
     * @return list<mixed>
     */
    private function decodeList(?string $json): array
    {
        if ($json === null || $json === '') {
            return [];
        }
        $decoded = json_decode($json, true);

        return is_array($decoded) ? $decoded : [];
    }

    /**
     * The Elo the bot will play its NEXT move at.
     *
     * For every variant except the two handicap modes this is just the stored
     * `rating`. fading and glassjaw derive it from the move history instead, so
     * their stored rating is only a full-strength sentinel and says nothing about
     * how strong the opponent currently is:
     *
     *  - fading: RATING_MAX minus 100 Elo per bot move already played.
     *  - glassjaw: RATING_MAX minus 300 Elo (cumulative, permanent) per check the
     *    human has delivered so far.
     *
     * Both floor at RATING_MIN so they never hit the rating<=0 worst-move path.
     * Evaluated against the CURRENT history, which is why serializing after a move
     * yields the strength that applies to the reply the player is about to face.
     */
    public function effectiveRating(): int
    {
        $moves = $this->getMoves();

        return match ($this->variant) {
            'fading' => max(
                self::RATING_MIN,
                self::RATING_MAX - 100 * count(array_filter(
                    $moves,
                    static fn (array $m): bool => ($m['by'] ?? null) === 'bot',
                )),
            ),
            'glassjaw' => max(
                self::RATING_MIN,
                self::RATING_MAX - 300 * count(array_filter(
                    $moves,
                    static function (array $m): bool {
                        if (($m['by'] ?? null) !== 'human') {
                            return false;
                        }
                        $san = is_string($m['san'] ?? null) ? $m['san'] : '';

                        return $san !== '' && (str_ends_with($san, '+') || str_ends_with($san, '#'));
                    },
                )),
            ),
            default => $this->rating,
        };
    }

    /**
     * Expose `moves` as a decoded array, publish the per-move effective rating,
     * and hide the internal repetition history.
     *
     * `effective_rating` ships on every variant (where it equals `rating`) so the
     * client has one field to render and never has to reimplement the handicap
     * curves to know how strong the opponent is right now.
     *
     * @return array<string, mixed>
     */
    #[Override]
    public function jsonSerialize(): array
    {
        $data = parent::jsonSerialize();
        unset($data['history_fens']);
        $data['moves'] = $this->getMoves();
        $data['effective_rating'] = $this->effectiveRating();

        return $data;
    }
}
