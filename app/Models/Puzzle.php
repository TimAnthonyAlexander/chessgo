<?php

namespace App\Models;

use Override;
use BaseApi\Models\BaseModel;

/**
 * A single tactical puzzle, seeded from the Lichess open puzzle database (CC0).
 * See docs/SPEC.md §Puzzles.
 *
 * The `rating` is treated as GROUND TRUTH (settled over millions of Lichess
 * attempts) and never changes here — only the solver's User::rating_puzzle
 * moves against it (see PuzzleController + Glicko2Service).
 *
 * Lichess solution convention: `fen` is the position BEFORE the opponent's
 * setup move. `moves[0]` is that opponent move (auto-played), then the line
 * alternates opponent/player. The player solves the odd-indexed moves.
 *
 * NOTE: BaseAPI's `array` cast decodes on read but does NOT encode on write
 * (see CLAUDE.md), so JSON-shaped data lives in TEXT columns as `?string`,
 * round-tripped via the accessors below — mirroring BotGame.
 */
class Puzzle extends BaseModel
{
    /**
     * Lichess PuzzleId (e.g. "00sHx"), informational. NOTE: Lichess ids are
     * CASE-SENSITIVE, but MySQL's default collation is case-insensitive — so
     * `ext_id` must NOT be a unique/join key (distinct ids like "0QCaI" and
     * "0qcai" would collide). Internal joins use the UUID `id`, which the
     * importer derives deterministically from this id (UUIDv5) so the case is
     * preserved in the key. Plain index only.
     */
    public string $ext_id = '';

    /** Starting position (FEN), before the opponent's setup move. */
    public string $fen = '';

    /** Solution line as JSON text: ["e8d7","a2e6",...] (UCI). Use get/setMoves. */
    public ?string $moves = null;

    /** Puzzle difficulty (Lichess Glicko rating). Fixed; drives serving + Elo. */
    public int $rating = 1500;

    /** Lichess rating deviation (confidence). Informational. */
    public int $rating_deviation = 0;

    /** Lichess popularity score (-100..100). */
    public int $popularity = 0;

    /** Number of times played on Lichess. */
    public int $nb_plays = 0;

    /** Theme tags as JSON text: ["fork","mateIn3",...]. Use get/setThemes. */
    public ?string $themes = null;

    /** Lichess game URL the puzzle was mined from. */
    public ?string $game_url = null;

    /**
     * @var array<string, string>
     */
    public static array $indexes = [
        'ext_id' => 'index',
        'rating' => 'index',
    ];

    /**
     * @var array<string, array<string, mixed>>
     */
    public static array $columns = [
        'moves' => ['type' => 'TEXT', 'nullable' => true],
        'themes' => ['type' => 'TEXT', 'nullable' => true],
        'game_url' => ['type' => 'TEXT', 'nullable' => true],
    ];

    /** @return list<string> */
    public function getMoves(): array
    {
        return $this->decodeList($this->moves);
    }

    /** @param list<string> $moves */
    public function setMoves(array $moves): void
    {
        $this->moves = json_encode(array_values($moves));
    }

    /** @return list<string> */
    public function getThemes(): array
    {
        return $this->decodeList($this->themes);
    }

    /** @param list<string> $themes */
    public function setThemes(array $themes): void
    {
        $this->themes = json_encode(array_values($themes));
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
     * Decode `moves`/`themes` for API output. The solution line is intentionally
     * NOT exposed here — PuzzleController strips `moves` from anything sent to a
     * solver mid-puzzle. `jsonSerialize` keeps it for internal/admin use only.
     *
     * @return array<string, mixed>
     */
    #[Override]
    public function jsonSerialize(): array
    {
        $data = parent::jsonSerialize();
        $data['moves'] = $this->getMoves();
        $data['themes'] = $this->getThemes();

        return $data;
    }
}
