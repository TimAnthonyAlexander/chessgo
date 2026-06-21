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
    /** AI strength as a target Elo (RatingMin..RatingMax ≈ 700..2900). The
     *  engine maps this to a weakening config; see gomachine internal/engine
     *  rating.go. Replaces the old 0..10 level. */
    public int $rating = 1500;

    /** The human's color: 'w' or 'b'. */
    public string $human_color = 'w';

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
     * Expose `moves` as a decoded array and hide the internal repetition history.
     *
     * @return array<string, mixed>
     */
    #[Override]
    public function jsonSerialize(): array
    {
        $data = parent::jsonSerialize();
        unset($data['history_fens']);
        $data['moves'] = $this->getMoves();

        return $data;
    }
}
