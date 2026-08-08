<?php

namespace App\Models;

use Override;
use BaseApi\Models\BaseModel;

/**
 * One Premove Trainer attempt — simultaneously the live game and the attempt
 * record (the {@see GuessGame} precedent: one model plays both roles). See
 * docs/tasks/open/premove-trainer.md §7.1, the frozen contract for this
 * feature.
 *
 * You are handed a forced-mate position, queue a whole chain of premoves
 * blind, and release it against the engine. Rated attempts (`time_control`
 * non-null) carry a real 10-second clock; casual attempts (`time_control`
 * null) have none at all. A "chain" is `chains[]` — every batch of moves
 * released, in order; `moves[]` is the flattened resulting ply list actually
 * played (player + engine replies).
 *
 * NOTE: BaseAPI's `array`/`json` casts decode on read but do NOT encode on
 * write (see vendor CLAUDE.md), so `moves`/`chains` are stored as `?string`
 * TEXT columns and round-tripped explicitly via the accessors below, mirroring
 * {@see BotGame}.
 */
class PremoveGame extends BaseModel
{
    /** Null = anonymous. Anonymous players may play the rated format (full
     *  clock) but are never rated — see {@see $rated}. */
    public ?string $user_id = null;

    /** References PremovePosition::id. Kept off the wire, though unlike the
     *  puzzle pool this replaced there is no secret in it: a generated Syzygy
     *  position has many winning moves by construction, so there is no single
     *  solution to leak. See jsonSerialize(). */
    public string $position_id = '';

    /** Whether Glicko is (or, once the game finishes, was) actually applied to
     *  this attempt: `user_id !== null && format === 'rated'`, decided once at
     *  creation. Since a row is one attempt and there is no re-play/alreadyPlayed
     *  guard (§6), an eligible attempt always DOES get rated once it resolves —
     *  so this flag is trustworthy both as "will be rated" (pre-resolution) and
     *  "was rated" (post-resolution). */
    public bool $rated = false;

    /**
     * `RATED_TIME_CONTROL` ("10+0" — a 10-second clock, 0 increment) when this
     * is a rated-format attempt, else null for casual. This is what actually
     * drives clock behavior (`PremoveTrainerService::isTimed()`), independent
     * of `$rated` — an anonymous player can play the rated format (full clock)
     * without ever being rated. NOT parsed by BotGame::parseTimeControl() (that
     * helper's "<base minutes>+<increment seconds>" convention does not apply
     * here); the clock length is PremoveTrainerService::RATED_CLOCK_MS.
     */
    public ?string $time_control = null;

    /** 'w' | 'b' — the side the player is on in `start_fen`/`fen`. */
    public string $player_color = 'w';

    /** Position after the puzzle's setup move (Lichess convention — see
     *  PremoveTrainerService::create()). Fixed for the life of the attempt;
     *  used to derive repetition history alongside `moves`. */
    public string $start_fen = '';

    /** Current position (FEN). */
    public string $fen = '';

    /** Side to move: 'w' or 'b' (mirror of `fen`, for convenience). */
    public string $side_to_move = 'w';

    /** Player's remaining clock in ms. Null when casual — no opponent clock
     *  exists in this mode (the "opponent" is a stateless engine call). */
    public ?int $clock_ms = null;

    /**
     * The instant (epoch MILLISECONDS, as a string) the player's clock is
     * currently counting down from — deliberately not the app's usual
     * second-resolution datetime string, for the same reason as
     * {@see BotGame::$last_move_at}: a bullet clock rounded to the second
     * would drift visibly. On any non-terminal outcome this is stamped into
     * the FUTURE (`nowMs() + playoutPlies * PLY_MS`) so the player's clock
     * doesn't silently bleed the animation time they haven't been shown yet —
     * see the contract §2.2. Null when casual.
     */
    public ?string $last_move_at = null;

    /** ongoing | won | lost. */
    public string $status = 'ongoing';

    /** checkmate | mated | flagged | stalemate | draw | chain-broke | unresolved.
     *  Null while ongoing. See the contract's terminal mapping table (§5). */
    public ?string $end_reason = null;

    /** Flattened resulting ply list as JSON text: [{ply,uci,san,fen,by}], `by`
     *  is 'player' or 'engine'. Use getMoves/setMoves. */
    public ?string $moves = null;

    /** Every chain released, in order, as submitted (post-promotion-resolution
     *  4/5-char UCI strings) — JSON text: [["e2e4","d1h5"], ...]. Analytics
     *  only; never interpreted at read time. Use getChains/setChains. */
    public ?string $chains = null;

    /** The puzzle's player-move count (2 for mateIn2 .. 5 for mateIn5). Stored
     *  for analytics; shown nowhere — telling the player the line length would
     *  hand them a third of the calculation. */
    public int $chain_target = 0;

    /** The rating rated against — the puzzle's own `rating`, unadjusted (v1;
     *  see the contract §6 for why a chain-length bonus isn't in v1). Stored on
     *  every row, rated or not, so recalibration is a data question later. */
    public int $opponent_rating = 1500;

    public ?int $rating_before = null;

    public ?int $rating_after = null;

    public ?int $rating_delta = null;

    /**
     * @var array<string, string>
     */
    public static array $indexes = [
        'user_id' => 'index',
        'position_id' => 'index',
    ];

    /**
     * @var array<string, array<string, mixed>>
     */
    public static array $columns = [
        'moves' => ['type' => 'TEXT', 'nullable' => true],
        'chains' => ['type' => 'TEXT', 'nullable' => true],
        'time_control' => ['type' => 'TEXT', 'nullable' => true],
        'last_move_at' => ['type' => 'TEXT', 'nullable' => true],
        'end_reason' => ['type' => 'TEXT', 'nullable' => true],
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

    /** @return list<list<string>> */
    public function getChains(): array
    {
        return $this->decodeList($this->chains);
    }

    /** @param list<list<string>> $chains */
    public function setChains(array $chains): void
    {
        $this->chains = json_encode(array_values($chains));
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

        return is_array($decoded) ? array_values($decoded) : [];
    }

    /**
     * Expose `moves`/`chains` as decoded arrays and strip `position_id`. The id
     * is not load-bearing for secrecy any more — a generated Syzygy position has
     * many winning moves, which is the whole point of the mode — but the client
     * has no use for it, and stripping it here keeps every response path
     * (create/release/get) building its payload from one place rather than from
     * the raw model properties.
     *
     * @return array<string, mixed>
     */
    #[Override]
    public function jsonSerialize(): array
    {
        $data = parent::jsonSerialize();
        $data['moves'] = $this->getMoves();
        $data['chains'] = $this->getChains();
        unset($data['position_id']);

        return $data;
    }
}
