<?php

namespace App\Models;

use BaseApi\Models\BaseModel;

/**
 * Server-side position-evaluation cache for `POST /analyze` (AnalyzeController).
 * Read-through/write-through: a position already evaluated at >= the requested
 * depth (and multipv) is served from here instead of re-searching zugzwang.
 *
 * `fen_key` is a NORMALIZED FEN — the first 4 space-separated fields (piece
 * placement, side to move, castling rights, en passant square) with the
 * halfmove clock and fullmove number dropped, mirroring what Lichess keys its
 * eval cache on. See EvalCacheService::normalizeKey(). Because the key drops
 * move counters it cannot represent 50-move-rule proximity or repetition
 * state — EvalCacheService::isCacheable() is what keeps those positions out
 * of the cache entirely, not this model.
 *
 * NOTE: BaseAPI's `array`/`json` casts decode on read but do NOT encode on
 * write (see vendor CLAUDE.md / app/Models/BotGame.php), so `pv` and `lines`
 * are stored as JSON text in `?string` TEXT columns and round-tripped
 * explicitly via the accessors below — never typed `array` here.
 */
class EvalCache extends BaseModel
{
    /** Normalized position key (piece placement + side to move + castling + en
     *  passant only). Unique — one row per position. */
    public string $fen_key = '';

    /** Search depth this entry was produced at. */
    public int $depth = 0;

    /** How many multipv lines this entry holds (1 when the engine returned a
     *  single line). */
    public int $multipv = 1;

    /** 'cp' | 'mate'. */
    public string $eval_type = 'cp';

    /** Centipawns or mate distance, side-to-move POV. */
    public int $eval_value = 0;

    /** Best move, UCI. */
    public ?string $bestmove = null;

    /** JSON array of UCI moves (the PV). Use getPv()/setPv() — never assign
     *  directly, see the array-cast footgun note above. */
    public ?string $pv = null;

    /** JSON of the multipv lines exactly as `/analyze` returns them. Use
     *  getLines()/setLines(). */
    public ?string $lines = null;

    /** Provenance: 'zugzwang' | 'stockfish' | 'lichess'. Keeps future imported
     *  third-party evals distinguishable from our own engine's. */
    public string $source = 'zugzwang';

    /** Node count the engine reported, when available; 0 otherwise. */
    public int $nodes = 0;

    /** Bumped on cache hit, so a future eviction job can drop cold entries. */
    public ?string $used_at = null;

    /**
     * @var array<string, string>
     */
    public static array $indexes = [
        'fen_key' => 'unique',
        'used_at' => 'index',
    ];

    /**
     * @var array<string, array<string, mixed>>
     */
    public static array $columns = [
        'pv' => ['type' => 'TEXT', 'nullable' => true],
        'lines' => ['type' => 'TEXT', 'nullable' => true],
        'used_at' => ['type' => 'TEXT', 'nullable' => true],
    ];

    /** @return list<string> */
    public function getPv(): array
    {
        return $this->decodeList($this->pv);
    }

    /** @param list<string> $pv */
    public function setPv(array $pv): void
    {
        $this->pv = json_encode(array_values($pv)) ?: null;
    }

    /** @return list<array<string, mixed>> */
    public function getLines(): array
    {
        return $this->decodeList($this->lines);
    }

    /** @param list<array<string, mixed>> $lines */
    public function setLines(array $lines): void
    {
        $this->lines = json_encode(array_values($lines)) ?: null;
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
}
