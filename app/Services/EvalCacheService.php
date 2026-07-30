<?php

namespace App\Services;

use App\Models\EvalCache;

/**
 * Read-through/write-through cache in front of the engine for `POST /analyze`
 * (AnalyzeController). A position already evaluated at >= the requested depth
 * (and multipv) is served from `eval_cache` instead of re-searching zugzwang —
 * the analysis board polls with increasing depths, so common positions
 * (start position, opening theory) would otherwise get re-searched constantly.
 *
 * Two soundness rules keep this correct, both because the cache key drops the
 * halfmove clock and fullmove number (see normalizeKey()):
 *   1. isCacheable() refuses positions where the discarded counters matter —
 *      near the 50-move rule, or mid-repetition — because the true eval there
 *      depends on state the key can't represent.
 *   2. put() never downgrades a stored entry — a fresher, shallower/narrower
 *      result can never overwrite a better one already cached.
 */
class EvalCacheService
{
    /**
     * Normalize a FEN to the cache key: piece placement + side to move +
     * castling rights + en passant square (the first 4 space-separated
     * fields), dropping halfmove clock and fullmove number. Mirrors Lichess's
     * eval-cache key. Robust to malformed input — never throws, just does its
     * best with what it's given.
     */
    public function normalizeKey(string $fen): string
    {
        $fen = trim($fen);
        if ($fen === '') {
            return '';
        }

        $fields = preg_split('/\s+/', $fen) ?: [];
        $fields = array_slice($fields, 0, 4);

        return implode(' ', $fields);
    }

    /**
     * Returns the cached entry only if it satisfies the request: stored depth
     * >= $minDepth AND stored multipv >= $multipv (more lines can serve a
     * request for fewer; the reverse cannot). Bumps `used_at` on a hit.
     */
    public function get(string $fen, int $minDepth, int $multipv): ?EvalCache
    {
        $key = $this->normalizeKey($fen);
        if ($key === '') {
            return null;
        }

        $entry = EvalCache::firstWhere('fen_key', '=', $key);
        if (!$entry instanceof EvalCache) {
            return null;
        }

        if ($entry->depth < $minDepth || $entry->multipv < $multipv) {
            return null;
        }

        $entry->used_at = date('Y-m-d H:i:s');
        $entry->save();

        return $entry;
    }

    /**
     * Upsert keyed on the normalized FEN, but only when the new result is an
     * improvement — never downgrades a stored entry. "Better" (mirrors
     * Lichess's ui/lib/src/ceval/util.ts isFirstEvalBetter ordering):
     *   1. more multipv lines, provided the new depth is >= the existing depth
     *   2. else strictly greater depth
     *   3. else equal depth with more nodes searched
     *
     * @param array<string, mixed> $result Shape matches ZugzwangClient::analyze()'s
     *   return: eval {type, value}, bestmove, pv, depth, multipv?, lines?, nodes?.
     */
    public function put(string $fen, array $result, string $source = 'zugzwang'): void
    {
        $key = $this->normalizeKey($fen);
        if ($key === '') {
            return;
        }

        $evalType = $result['eval']['type'] ?? null;
        $evalValue = $result['eval']['value'] ?? null;
        $depth = (int) ($result['depth'] ?? 0);
        $evalValueIsNumeric = is_int($evalValue) || is_float($evalValue);
        if (!is_string($evalType) || !$evalValueIsNumeric || $depth <= 0) {
            // Nothing usable to cache (e.g. a terminal/instant result with no search).
            return;
        }

        $lines = is_array($result['lines'] ?? null) ? $result['lines'] : [];
        $multipv = max(1, count($lines) ?: (int) ($result['multipv'] ?? 1));
        $nodes = (int) ($result['nodes'] ?? 0);

        $existing = EvalCache::firstWhere('fen_key', '=', $key);

        if ($existing instanceof EvalCache && !$this->isBetter($multipv, $depth, $nodes, $existing)) {
            return;
        }

        $entry = $existing instanceof EvalCache ? $existing : new EvalCache();
        $entry->fen_key = $key;
        $entry->depth = $depth;
        $entry->multipv = $multipv;
        $entry->eval_type = $evalType;
        $entry->eval_value = (int) $evalValue;
        $entry->bestmove = is_string($result['bestmove'] ?? null) ? $result['bestmove'] : null;
        $entry->setPv(is_array($result['pv'] ?? null) ? $result['pv'] : []);
        $entry->setLines($lines);
        $entry->source = $source;
        $entry->nodes = $nodes;
        // `used_at` is only bumped by get() (a genuine cache hit) — a write on
        // its own isn't a "use" of the cache, it's populating it. Left null
        // until the first hit.
        $entry->save();
    }

    /**
     * Lichess-style isFirstEvalBetter ordering, applied to "would the
     * candidate (multipv/depth/nodes) beat what's already stored":
     *   1. more multipv lines at >= existing depth wins outright
     *   2. else strictly greater depth wins
     *   3. else equal depth with more nodes wins
     * Anything else (fewer lines, shallower depth, or equal depth/nodes) is
     * not an improvement — put() must never downgrade a stored entry.
     */
    private function isBetter(int $multipv, int $depth, int $nodes, EvalCache $existing): bool
    {
        if ($multipv > $existing->multipv && $depth >= $existing->depth) {
            return true;
        }

        if ($depth > $existing->depth) {
            return true;
        }

        if ($depth === $existing->depth && $nodes > $existing->nodes) {
            return true;
        }

        return false;
    }

    /**
     * False when caching would be unsound because the key drops the halfmove
     * clock and fullmove number, so it cannot represent 50-move-rule
     * proximity or repetition state:
     *   - halfmove clock >= 80 (approaching the 50-move rule; the true eval
     *     depends on the counter the key discards)
     *   - the normalized current position already appears in `$history`
     *     (root→previous) — the position has repeated, so repetition state
     *     (draw claims, "third time" heuristics) matters and isn't captured
     *     by a bare position key
     * True otherwise.
     *
     * @param list<string> $history Prior-position FENs, root→previous.
     */
    public function isCacheable(string $fen, array $history): bool
    {
        $fields = preg_split('/\s+/', trim($fen)) ?: [];
        $halfmove = $fields[4] ?? null;
        if ($halfmove !== null && is_numeric($halfmove) && (int) $halfmove >= 80) {
            return false;
        }

        $key = $this->normalizeKey($fen);
        if ($key === '') {
            return true;
        }

        foreach ($history as $priorFen) {
            if (!is_string($priorFen)) {
                continue;
            }
            if ($this->normalizeKey($priorFen) === $key) {
                return false;
            }
        }

        return true;
    }
}
