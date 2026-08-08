<?php

namespace App\Models;

use Override;
use BaseApi\Models\BaseModel;

/**
 * A finished human/hub game, persisted by the realtime hub via the internal
 * results endpoint (GameResultController). The hub owns live play; this is the
 * durable record for history + ratings. Bot-fill games are stored too (rated
 * is false for them, so they never move Elo). See docs/SPEC.md §8, §10.
 *
 * Per-side `*_user_id` is set whenever the side's uid resolves to a real
 * `user` row — a seeded bot account (role='bot') included, so its arena games
 * show up on its own profile — and stays null for anonymous sides and the
 * hub's ordinary fill-in bots (bot-<random> uids, no account to resolve to).
 * `*_uid` keeps the raw hub identity for reference. This is independent of
 * Elo: {@see \App\Controllers\GameResultController::resolveAccount()} still
 * returns null for any bot side there, so ratings are unaffected. As with
 * BotGame, JSON-shaped move data lives in TEXT columns (the array cast does not
 * encode on write) and is round-tripped via the accessors below.
 */
class Game extends BaseModel
{
    /** The hub's game id — unique, so a retried persist call can't double-insert. */
    public string $hub_game_id = '';

    /** Time-control pool, e.g. "3+0". */
    public string $pool = '';

    /** Rating category: a time control (bullet|blitz|rapid|classical) or one of
     *  the isolated pools 'duck' | 'crazyhouse' | 'antichess' | 'secretqueen'. */
    public string $category = '';

    /** True only when both sides are registered accounts (affects Elo). */
    public bool $rated = false;

    /** Game variant: 'standard' | 'chess960' | 'duck' | 'crazyhouse' | 'antichess'
     *  | 'secretqueen'. Live play persists the variant the hub reports; standard +
     *  Chess960 share the same board/rules record (only the start position
     *  differs). */
    public string $variant = 'standard';

    /** Final result: '1-0' | '0-1' | '1/2-1/2'. */
    public string $result = '';

    /** Owning {@see Tournament} id, or null for an ordinary (non-arena) game. */
    public ?string $tournament_id = null;

    /** Custom starting FEN the hub played from, or null for the normal start
     *  position. The hub sends this as `startFen` on POST /internal/games. */
    public ?string $start_fen = null;

    /** How it ended: checkmate | stalemate | resign | timeout | draw-* | … */
    public string $reason = '';

    /** White identity (hub sub: account id, anon id, or bot-…) + display name. */
    public string $white_uid = '';

    public string $black_uid = '';

    public string $white_name = '';

    public string $black_name = '';

    /** Account ids when the side is a registered user; null otherwise. */
    public ?string $white_user_id = null;

    public ?string $black_user_id = null;

    public bool $white_is_bot = false;

    public bool $black_is_bot = false;

    /** Category ratings before/after the game (null when unrated). */
    public ?int $white_rating_before = null;

    public ?int $white_rating_after = null;

    public ?int $black_rating_before = null;

    public ?int $black_rating_after = null;

    public int $ply = 0;

    /** Move list as JSON text: ["e2e4", …] (UCI). Use getMoves/setMoves. */
    public ?string $moves = null;

    /** SANs as JSON text: ["e4", …]. Use getSans/setSans. */
    public ?string $sans = null;

    /**
     * Per-move think-times in ms as JSON text: [1200, 800, …], parallel to moves.
     * Anti-cheat telemetry (move-time variance / difficulty correlation). Captured
     * live by the hub; cannot be back-filled for older games. Use getMoveTimes/set.
     */
    public ?string $move_times = null;

    /**
     * Cached full-game engine analysis as JSON text (per-ply eval + best move +
     * blunder judgments), computed once on first request. Internal — stripped
     * from the default serialization; served only via the analysis endpoint.
     */
    public ?string $analysis = null;

    /**
     * True once the out-of-band anti-cheat engine-correlation scan has processed
     * this game (scripts/anticheat_scan.php). Lets the scan be idempotent + resume
     * where it left off. Internal — never client-facing.
     */
    public bool $ac_scanned = false;

    /**
     * @var array<string, string>
     */
    public static array $indexes = [
        'hub_game_id' => 'unique',
        'white_user_id' => 'index',
        'black_user_id' => 'index',
        'category' => 'index',
        'ac_scanned' => 'index',
        'tournament_id' => 'index',
    ];

    /**
     * @var array<string, array<string, mixed>>
     */
    public static array $columns = [
        'moves' => ['type' => 'TEXT', 'nullable' => true],
        'sans' => ['type' => 'TEXT', 'nullable' => true],
        'move_times' => ['type' => 'TEXT', 'nullable' => true],
        // MEDIUMTEXT (16MB), not TEXT: the cached analysis is one entry per ply
        // carrying a FEN, an eval, a bestmove, a PV and a judgment, so a long
        // game overflows TEXT's 64KB. That truncation failed 2,486 AnalyzeGameJob
        // runs in prod (SQLSTATE 22001) — the job could never cache, so every
        // later read re-ran the engine and failed to save again.
        'analysis' => ['type' => 'MEDIUMTEXT', 'nullable' => true],
    ];

    /** @return array<string, mixed>|null Decoded cached analysis, or null if absent. */
    public function getAnalysis(): ?array
    {
        if ($this->analysis === null || $this->analysis === '') {
            return null;
        }
        $decoded = json_decode($this->analysis, true);

        return is_array($decoded) ? $decoded : null;
    }

    /** @param array<string, mixed> $analysis */
    public function setAnalysis(array $analysis): void
    {
        $this->analysis = json_encode($analysis);
    }

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
    public function getSans(): array
    {
        return $this->decodeList($this->sans);
    }

    /** @param list<string> $sans */
    public function setSans(array $sans): void
    {
        $this->sans = json_encode(array_values($sans));
    }

    /** @return list<int> Per-move think-times in ms (parallel to moves); [] if not captured. */
    public function getMoveTimes(): array
    {
        return array_map('intval', $this->decodeList($this->move_times));
    }

    /** @param list<int> $times */
    public function setMoveTimes(array $times): void
    {
        $this->move_times = json_encode(array_values(array_map('intval', $times)));
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
     * Light row for history lists (a user's profile / game log). Deliberately
     * omits the move/SAN/analysis blobs — those are fetched per-game via the
     * analysis endpoint when a game is opened. `id` is the hub game id (what the
     * analysis route keys on).
     *
     * @return array<string, mixed>
     */
    public function summaryRow(): array
    {
        return [
            'id' => $this->hub_game_id,
            'created_at' => $this->created_at,
            'category' => $this->category,
            'pool' => $this->pool,
            'variant' => $this->variant,
            'rated' => $this->rated,
            'result' => $this->result,
            'reason' => $this->reason,
            'white_name' => $this->white_name,
            'black_name' => $this->black_name,
            'white_user_id' => $this->white_user_id,
            'black_user_id' => $this->black_user_id,
            'white_is_bot' => $this->white_is_bot,
            'black_is_bot' => $this->black_is_bot,
            'white_rating_before' => $this->white_rating_before,
            'white_rating_after' => $this->white_rating_after,
            'black_rating_before' => $this->black_rating_before,
            'black_rating_after' => $this->black_rating_after,
            'ply' => $this->ply,
        ];
    }

    /**
     * Batch {@see summaryRow} for a list of games, with each side's display
     * title attached (white_title/black_title) via ONE User::titleMapFor
     * lookup across every white_user_id/black_user_id in the set — never a
     * per-row query. Games store denormalized name strings, not a User
     * reference, so the title has to be joined in separately; player rows
     * built from live User rows (leaderboard, admin list, …) get it for free.
     *
     * @param list<Game> $games
     * @return list<array<string, mixed>>
     */
    public static function summaryRowsWithTitles(array $games): array
    {
        $ids = [];
        foreach ($games as $g) {
            $ids[] = $g->white_user_id;
            $ids[] = $g->black_user_id;
        }
        $titles = User::titleMapFor($ids);

        return array_map(static function (Game $g) use ($titles): array {
            $row = $g->summaryRow();
            $row['white_title'] = $g->white_user_id !== null ? ($titles[$g->white_user_id] ?? null) : null;
            $row['black_title'] = $g->black_user_id !== null ? ($titles[$g->black_user_id] ?? null) : null;

            return $row;
        }, $games);
    }

    /**
     * @return array<string, mixed>
     */
    #[Override]
    public function jsonSerialize(): array
    {
        $data = parent::jsonSerialize();
        unset($data['analysis']); // large cached blob; served only via the analysis endpoint
        unset($data['move_times']); // internal anti-cheat telemetry; never client-facing
        unset($data['ac_scanned']); // internal anti-cheat bookkeeping
        $data['moves'] = $this->getMoves();
        $data['sans'] = $this->getSans();

        return $data;
    }
}
