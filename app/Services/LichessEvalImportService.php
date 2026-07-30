<?php

namespace App\Services;

use App\Models\BotGame;
use App\Models\Game;
use BaseApi\App;

/**
 * Converts Lichess's public CC0 eval dump (lichess_db_eval.jsonl) into rows
 * shaped for `eval_cache`, and builds the "positions we actually care about"
 * filter set from our own `game`/`bot_game` data. See scripts/import_lichess_evals.php
 * for the CLI that streams the dump through this.
 *
 * Record shape (one JSON object per line):
 *   {"fen":"<4-field normalized FEN>",
 *    "evals":[{"pvs":[{"cp":N,"line":"uci uci …"}, …], "knodes":N, "depth":N}, …]}
 *
 * Two facts drive the conversion (verified against a real slice of the dump,
 * not assumed — see the task report):
 *   1. `fen` is ALREADY EvalCacheService::normalizeKey()'s output — no
 *      transformation needed to use it as `eval_cache.fen_key`.
 *   2. `cp`/`mate` are WHITE-relative. Our `eval_value` is side-to-move POV
 *      (see EvalCache::$eval_value doc), so this negates every score when the
 *      FEN's side to move is 'b'. Getting this backwards silently poisons
 *      every imported row — see LichessEvalImportServiceTest for the pinned
 *      fixtures.
 */
class LichessEvalImportService
{
    public function __construct(
        private readonly EvalCacheService $cache = new EvalCacheService(),
    ) {
    }

    // ------------------------------------------------------------------
    // Record conversion
    // ------------------------------------------------------------------

    /**
     * Convert one decoded dump line into an `eval_cache` row shape, or null
     * if the record is unusable (malformed FEN, no evals, no pvs, ambiguous
     * cp/mate). Never throws — the dump is untrusted external input.
     *
     * @param array<string, mixed> $record
     * @return array{fen_key:string, depth:int, multipv:int, eval_type:string,
     *   eval_value:int, bestmove:?string, pv:list<string>,
     *   lines:list<array<string,mixed>>, nodes:int}|null
     */
    public function convertRecord(array $record): ?array
    {
        $fen = $record['fen'] ?? null;
        if (!is_string($fen) || trim($fen) === '') {
            return null;
        }

        $sideToMove = $this->sideToMoveFromFen($fen);
        if ($sideToMove === null) {
            return null; // can't sign-correct without knowing whose move it is
        }

        $evals = $record['evals'] ?? null;
        if (!is_array($evals) || $evals === []) {
            return null;
        }

        $best = $this->pickBestEvalsEntry($evals);
        if ($best === null) {
            return null;
        }

        $pvsRaw = is_array($best['pvs'] ?? null) ? $best['pvs'] : [];
        $depth = (int) ($best['depth'] ?? 0);
        $negate = $sideToMove === 'b';

        $lines = [];
        foreach ($pvsRaw as $p) {
            if (!is_array($p)) {
                continue;
            }
            $line = $this->convertPv($p, $negate, $depth);
            if ($line !== null) {
                $lines[] = $line;
            }
        }
        if ($lines === [] || $depth <= 0) {
            return null;
        }

        $key = $this->cache->normalizeKey($fen);
        if ($key === '') {
            return null;
        }

        $top = $lines[0];
        $knodes = is_int($best['knodes'] ?? null) || is_float($best['knodes'] ?? null)
            ? (float) $best['knodes']
            : 0.0;

        return [
            'fen_key' => $key,
            'depth' => $depth,
            'multipv' => count($lines),
            'eval_type' => $top['eval']['type'],
            'eval_value' => $top['eval']['value'],
            'bestmove' => $top['pv'][0] ?? null,
            'pv' => $top['pv'],
            'lines' => $lines,
            'nodes' => (int) round($knodes * 1000),
        ];
    }

    /**
     * Pick the best `evals[]` entry: highest depth, tie-break on more pvs,
     * then more knodes.
     *
     * @param list<mixed> $evals
     * @return array<string, mixed>|null
     */
    public function pickBestEvalsEntry(array $evals): ?array
    {
        $best = null;
        foreach ($evals as $e) {
            if (!is_array($e)) {
                continue;
            }
            if ($best === null || $this->isBetterEvalsEntry($e, $best)) {
                $best = $e;
            }
        }

        return $best;
    }

    /**
     * @param array<string, mixed> $candidate
     * @param array<string, mixed> $existing
     */
    private function isBetterEvalsEntry(array $candidate, array $existing): bool
    {
        $cDepth = (int) ($candidate['depth'] ?? 0);
        $eDepth = (int) ($existing['depth'] ?? 0);
        if ($cDepth !== $eDepth) {
            return $cDepth > $eDepth;
        }

        $cCount = is_array($candidate['pvs'] ?? null) ? count($candidate['pvs']) : 0;
        $eCount = is_array($existing['pvs'] ?? null) ? count($existing['pvs']) : 0;
        if ($cCount !== $eCount) {
            return $cCount > $eCount;
        }

        $cKnodes = is_numeric($candidate['knodes'] ?? null) ? (float) $candidate['knodes'] : 0.0;
        $eKnodes = is_numeric($existing['knodes'] ?? null) ? (float) $existing['knodes'] : 0.0;

        return $cKnodes > $eKnodes;
    }

    /**
     * @param array<string, mixed> $pv
     * @return array{bestmove:string, eval:array{type:string,value:int}, pv:list<string>, depth:int}|null
     */
    private function convertPv(array $pv, bool $negate, int $depth): ?array
    {
        $lineStr = $pv['line'] ?? null;
        if (!is_string($lineStr) || trim($lineStr) === '') {
            return null;
        }
        $moves = preg_split('/\s+/', trim($lineStr)) ?: [];
        if ($moves === []) {
            return null;
        }

        $hasCp = array_key_exists('cp', $pv) && is_int($pv['cp']);
        $hasMate = array_key_exists('mate', $pv) && is_int($pv['mate']);
        if ($hasCp === $hasMate) {
            // Neither present, or both present (malformed — the dump format
            // guarantees exactly one) — refuse to guess.
            return null;
        }

        if ($hasCp) {
            $type = 'cp';
            $value = $negate ? -$pv['cp'] : $pv['cp'];
        } else {
            $type = 'mate';
            $value = $negate ? -$pv['mate'] : $pv['mate'];
        }

        return [
            'bestmove' => $moves[0],
            'eval' => ['type' => $type, 'value' => $value],
            'pv' => array_values($moves),
            'depth' => $depth,
        ];
    }

    /** Thin passthrough to EvalCacheService::normalizeKey() — the same
     *  normalization dump `fen` values already are, and the key both the
     *  position set and `eval_cache.fen_key` are keyed on. */
    public function normalizeKey(string $fen): string
    {
        return $this->cache->normalizeKey($fen);
    }

    /** Returns 'w' | 'b' | null (malformed/short FEN). */
    public function sideToMoveFromFen(string $fen): ?string
    {
        $fields = preg_split('/\s+/', trim($fen)) ?: [];
        $stm = $fields[1] ?? null;

        return $stm === 'w' || $stm === 'b' ? $stm : null;
    }

    // ------------------------------------------------------------------
    // Never-downgrade ordering — mirrors EvalCacheService::isBetter() so a
    // batched SQL upsert can apply the identical rule without going through
    // one Eloquent-style save() per row.
    // ------------------------------------------------------------------

    /**
     * @param array<string, mixed> $candidate Must carry int-castable multipv/depth/nodes.
     * @param array<string, mixed> $existing
     */
    public function isBetter(array $candidate, array $existing): bool
    {
        $cMultipv = (int) $candidate['multipv'];
        $cDepth = (int) $candidate['depth'];
        $cNodes = (int) $candidate['nodes'];
        $eMultipv = (int) $existing['multipv'];
        $eDepth = (int) $existing['depth'];
        $eNodes = (int) $existing['nodes'];

        if ($cMultipv > $eMultipv && $cDepth >= $eDepth) {
            return true;
        }
        if ($cDepth > $eDepth) {
            return true;
        }

        return $cDepth === $eDepth && $cNodes > $eNodes;
    }

    /**
     * Collapse duplicate fen_keys within a single batch to the single best
     * row per key (same ordering as isBetter()), so a multi-row
     * INSERT … ON DUPLICATE KEY UPDATE never has to reason about the order
     * MySQL applies same-key rows within one statement.
     *
     * @param list<array<string, mixed>> $rows
     * @return list<array<string, mixed>>
     */
    public function dedupeBatch(array $rows): array
    {
        /** @var array<string, array<string, mixed>> $byKey */
        $byKey = [];
        foreach ($rows as $row) {
            $key = $row['fen_key'];
            $existing = $byKey[$key] ?? null;
            if ($existing === null || $this->isBetter($row, $existing)) {
                $byKey[$key] = $row;
            }
        }

        return array_values($byKey);
    }

    /**
     * Classify a (deduped) batch against what's already stored, WITHOUT
     * writing anything — the shared path for both dry-run reporting and the
     * pre-write filter in commit mode.
     *
     * @param list<array<string, mixed>> $rows Deduped rows (see dedupeBatch()).
     * @return array{insert: list<array<string,mixed>>, update: list<array<string,mixed>>, skip: int}
     */
    public function classifyBatch(array $rows): array
    {
        if ($rows === []) {
            return ['insert' => [], 'update' => [], 'skip' => 0];
        }

        $keys = array_column($rows, 'fen_key');
        $placeholders = implode(',', array_fill(0, count($keys), '?'));
        $existingRows = App::db()->raw(
            "SELECT `fen_key`, `depth`, `multipv`, `nodes` FROM `eval_cache` WHERE `fen_key` IN ({$placeholders})",
            $keys,
        );

        /** @var array<string, array{depth:int,multipv:int,nodes:int}> $existingByKey */
        $existingByKey = [];
        foreach ($existingRows as $r) {
            $existingByKey[(string) $r['fen_key']] = [
                'depth' => (int) $r['depth'],
                'multipv' => (int) $r['multipv'],
                'nodes' => (int) $r['nodes'],
            ];
        }

        $insert = [];
        $update = [];
        $skip = 0;
        foreach ($rows as $row) {
            $existing = $existingByKey[$row['fen_key']] ?? null;
            if ($existing === null) {
                $insert[] = $row;
                continue;
            }
            if ($this->isBetter($row, $existing)) {
                $update[] = $row;
            } else {
                $skip++;
            }
        }

        return ['insert' => $insert, 'update' => $update, 'skip' => $skip];
    }

    /**
     * Batched upsert. The ON DUPLICATE KEY UPDATE clause re-applies the SAME
     * never-downgrade condition as EvalCacheService::isBetter() in SQL (via
     * VALUES(...) referencing the row being inserted), so this stays correct
     * even if a concurrent writer (e.g. live /analyze traffic) improved the
     * row between classifyBatch()'s SELECT and this write — belt-and-braces
     * on top of classifyBatch() already having filtered out non-improvements.
     *
     * @param list<array<string, mixed>> $rows Rows to write (insert ∪ update
     *   from classifyBatch() — skip rows must NOT be passed here).
     */
    public function writeBatch(array $rows, string $source = 'lichess'): int
    {
        if ($rows === []) {
            return 0;
        }

        // `lines` (and, harmlessly, a couple of others) are reserved words in
        // MySQL 8 (LINES is part of LOAD DATA syntax) — every identifier here
        // MUST be backtick-quoted or the INSERT is a syntax error.
        $cols = ['id', 'fen_key', 'depth', 'multipv', 'eval_type', 'eval_value', 'bestmove', 'pv', 'lines', 'source', 'nodes'];
        $quotedCols = array_map(static fn (string $c): string => "`{$c}`", $cols);
        $placeholder = '(' . implode(',', array_fill(0, count($cols), '?')) . ')';
        $isBetterSql = '((VALUES(`multipv`) > `multipv` AND VALUES(`depth`) >= `depth`)'
            . ' OR VALUES(`depth`) > `depth`'
            . ' OR (VALUES(`depth`) = `depth` AND VALUES(`nodes`) > `nodes`))';

        $sql = 'INSERT INTO `eval_cache` (' . implode(',', $quotedCols) . ') VALUES '
            . implode(',', array_fill(0, count($rows), $placeholder))
            . ' ON DUPLICATE KEY UPDATE '
            . "`depth` = IF({$isBetterSql}, VALUES(`depth`), `depth`), "
            . "`multipv` = IF({$isBetterSql}, VALUES(`multipv`), `multipv`), "
            . "`eval_type` = IF({$isBetterSql}, VALUES(`eval_type`), `eval_type`), "
            . "`eval_value` = IF({$isBetterSql}, VALUES(`eval_value`), `eval_value`), "
            . "`bestmove` = IF({$isBetterSql}, VALUES(`bestmove`), `bestmove`), "
            . "`pv` = IF({$isBetterSql}, VALUES(`pv`), `pv`), "
            . "`lines` = IF({$isBetterSql}, VALUES(`lines`), `lines`), "
            . "`source` = IF({$isBetterSql}, VALUES(`source`), `source`), "
            . "`nodes` = IF({$isBetterSql}, VALUES(`nodes`), `nodes`)";

        $bindings = [];
        foreach ($rows as $row) {
            $bindings[] = $this->uuidv4();
            $bindings[] = $row['fen_key'];
            $bindings[] = $row['depth'];
            $bindings[] = $row['multipv'];
            $bindings[] = $row['eval_type'];
            $bindings[] = $row['eval_value'];
            $bindings[] = $row['bestmove'];
            $bindings[] = json_encode(array_values($row['pv'])) ?: null;
            $bindings[] = json_encode(array_values($row['lines'])) ?: null;
            $bindings[] = $source;
            $bindings[] = $row['nodes'];
        }

        App::db()->exec($sql, $bindings);

        return count($rows);
    }

    private function uuidv4(): string
    {
        $data = random_bytes(16);
        $data[6] = chr((ord($data[6]) & 0x0f) | 0x40);
        $data[8] = chr((ord($data[8]) & 0x3f) | 0x80);

        return vsprintf('%s%s-%s-%s-%s-%s%s%s', str_split(bin2hex($data), 4));
    }

    // ------------------------------------------------------------------
    // Position-set builders — "positions we actually care about", so the
    // import doesn't pull in all ~394M dump rows.
    // ------------------------------------------------------------------

    /**
     * Every position reached in our own BotGame corpus, straight from stored
     * JSON — NO chess replay logic here. `BotGameService::apply()` already
     * stashes the resulting FEN on every move entry (`moves[].fen`) and the
     * pre-move FEN in `history_fens` (root→previous), so the union of
     * `history_fens` (the very first entry is the game's start FEN) and every
     * `moves[].fen` is the complete set of positions the game passed through.
     * The engine computed all of these originally — this just reads them back.
     *
     * Restricted to variant standard|chess960 — those two share the plain
     * 4-field FEN shape the dump uses (CLAUDE.md: "standard and Chess960
     * share the same board/rules record"). Duck/Crazyhouse/Antichess FENs
     * carry extra state (duck square, bracketed pocket, …) that would never
     * match a dump entry anyway; excluding them keeps the set free of keys
     * that can only ever be dead weight.
     *
     * @return array<string, true> normalized-key => true
     */
    public function positionsFromBotGames(int $limit = 0): array
    {
        /** @var array<string, true> $out */
        $out = [];
        $scanned = 0;

        // NOTE: deliberately NOT ModelQuery::chunkById() — it double-quotes
        // the cursor column internally (sanitizeColumnName() is applied both
        // in chunkById() itself and again inside the where()/orderBy() calls
        // it makes with the already-quoted column name), throwing
        // "Invalid identifier segment: `id`" on every call regardless of
        // model. Reproduced standalone against a vanilla BotGame::query() —
        // a vendor bug, not something to work around by editing vendor/. This
        // hand-rolled keyset pagination (id > lastId, ordered by id) is the
        // same strategy chunkById is documented to use, just without going
        // through the broken helper.
        $lastId = null;
        $pageSize = 500;
        while (true) {
            $query = BotGame::query()->whereIn('variant', ['standard', 'chess960'])->orderBy('id');
            if ($lastId !== null) {
                $query = $query->where('id', '>', $lastId);
            }
            $take = $pageSize;
            if ($limit > 0) {
                $remaining = $limit - $scanned;
                if ($remaining <= 0) {
                    break;
                }
                $take = min($pageSize, $remaining);
            }

            $games = $query->limit($take)->get();
            if ($games === []) {
                break;
            }

            foreach ($games as $game) {
                if (!$game instanceof BotGame) {
                    continue;
                }
                $scanned++;
                $lastId = $game->id;
                foreach ($game->getHistory() as $fen) {
                    if (is_string($fen) && $fen !== '') {
                        $out[$this->cache->normalizeKey($fen)] = true;
                    }
                }
                foreach ($game->getMoves() as $move) {
                    $fen = $move['fen'] ?? null;
                    if (is_string($fen) && $fen !== '') {
                        $out[$this->cache->normalizeKey($fen)] = true;
                    }
                }
                // Current position too (covers a still-ongoing game whose
                // latest position isn't yet reflected in moves[]/history).
                if ($game->fen !== '') {
                    $out[$this->cache->normalizeKey($game->fen)] = true;
                }
            }

            if (count($games) < $take) {
                break;
            }
        }

        unset($out['']);

        return $out;
    }

    /**
     * Every position reached in our `game` (human/hub) corpus. Unlike
     * BotGame, `Game` stores only the UCI move list — no per-ply FEN — so
     * this REPLAYS moves through the engine's `/move` endpoint (no search,
     * just rules application) rather than reimplementing chess in PHP (the
     * project rule: the engine owns the rules). One engine round trip per
     * ply; `/move` is cheap (rules-only, no search) so this is fine at
     * dev-corpus scale, but it does mean this path needs a reachable engine —
     * see the CLI's --no-db / --positions fallback when one isn't available.
     *
     * Only 'standard' variant games are replayed. Unlike BotGame (which
     * stashes its own start FEN in history_fens[0]), `Game` has no fen column
     * at all, so this hardcodes the standard start position below — correct
     * only for 'standard'. Chess960 starts from a different (per-game)
     * position we have no record of, so replaying it from the standard start
     * would silently produce WRONG FENs rather than merely unmatched ones;
     * Duck/Crazyhouse/Antichess follow different rules entirely. All four are
     * excluded rather than risk poisoning the position set.
     *
     * A game whose move sequence fails to replay (illegal move per the
     * engine, or the engine unreachable) is skipped entirely (its positions
     * already collected are discarded) and counted in the returned
     * `skippedGames` — this is a best-effort corpus, not a source of truth.
     *
     * @param list<string>|null $onlyGameIds Restrict to exactly these `game.id`
     *   values (e.g. a targeted re-import, or test isolation); null (default)
     *   scans the whole standard-variant corpus.
     * @return array{positions: array<string, true>, gamesReplayed: int, skippedGames: int}
     */
    public function positionsFromHumanGames(GomachineClient $engine, int $limit = 0, ?array $onlyGameIds = null): array
    {
        /** @var array<string, true> $out */
        $out = [];
        $replayed = 0;
        $skipped = 0;

        // See positionsFromBotGames() for why this is hand-rolled keyset
        // pagination rather than ModelQuery::chunkById() (vendor bug).
        $lastId = null;
        $pageSize = 200;
        $fetched = 0;
        while (true) {
            $query = Game::query()->where('variant', '=', 'standard')->orderBy('id');
            if ($onlyGameIds !== null) {
                $query = $query->whereIn('id', $onlyGameIds);
            }
            if ($lastId !== null) {
                $query = $query->where('id', '>', $lastId);
            }
            $take = $pageSize;
            if ($limit > 0) {
                $remaining = $limit - $fetched;
                if ($remaining <= 0) {
                    break;
                }
                $take = min($pageSize, $remaining);
            }

            $games = $query->limit($take)->get();
            if ($games === []) {
                break;
            }

            foreach ($games as $game) {
                if (!$game instanceof Game) {
                    continue;
                }
                $fetched++;
                $lastId = $game->id;

                $moves = $game->getMoves();
                if ($moves === []) {
                    continue;
                }

                $fen = 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1';
                $history = [];
                $positions = [$this->cache->normalizeKey($fen) => true];
                $ok = true;

                foreach ($moves as $uci) {
                    if (!is_string($uci) || $uci === '') {
                        $ok = false;
                        break;
                    }
                    try {
                        $result = $engine->move($fen, $uci, $history);
                    } catch (\Throwable) {
                        $ok = false;
                        break;
                    }
                    $newFen = $result['newFen'] ?? null;
                    if (!is_string($newFen) || $newFen === '' || ($result['legal'] ?? false) !== true) {
                        $ok = false;
                        break;
                    }
                    $history[] = $fen;
                    $fen = $newFen;
                    $positions[$this->cache->normalizeKey($fen)] = true;
                }

                if ($ok) {
                    $out += $positions;
                    $replayed++;
                } else {
                    $skipped++;
                }
            }

            if (count($games) < $take) {
                break;
            }
        }

        unset($out['']);

        return ['positions' => $out, 'gamesReplayed' => $replayed, 'skippedGames' => $skipped];
    }

    /**
     * Load an explicit position list — one FEN (or already-normalized key)
     * per line, blank lines and `#`-prefixed comments ignored. The
     * PGN-corpus-processed-separately path: whatever produced the file did
     * its own chess-rules work upstream (e.g. a PGN replay tool, or this
     * same importer's own DB-derived builders written to a file for reuse).
     *
     * @return array<string, true>
     */
    public function positionsFromFile(string $path): array
    {
        /** @var array<string, true> $out */
        $out = [];
        $handle = fopen($path, 'r');
        if ($handle === false) {
            return $out;
        }

        while (($line = fgets($handle)) !== false) {
            $line = trim($line);
            if ($line === '' || str_starts_with($line, '#')) {
                continue;
            }
            $key = $this->cache->normalizeKey($line);
            if ($key !== '') {
                $out[$key] = true;
            }
        }
        fclose($handle);

        return $out;
    }
}
