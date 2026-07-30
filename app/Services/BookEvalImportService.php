<?php

namespace App\Services;

use App\Models\EvalCache;

/**
 * Converts zugzwang's precomputed Stockfish opening-book cache (book.bin,
 * recovered into FEN-shaped TSV rows by `zugzwang/tools/book_export.cpp` —
 * see that tool's header comment for why: the book itself stores
 * gomachine-Zobrist KEYS only, no FENs, so a BFS walk from the start
 * position + opening suites is what recovers them) into `eval_cache` rows.
 *
 * TSV row shape (one line per book entry):
 *   fen<TAB>score<TAB>mate<TAB>depth<TAB>pv
 * where `fen` is the full 6-field FEN, and `pv` is a space-separated UCI
 * move list (pv[0] is the book's best move). Every entry currently in
 * book.bin is depth 22 with mate == 0, but the format allows mate entries
 * and this importer honors them.
 *
 * Perspective (the one thing that would silently poison every row if
 * guessed wrong): `score`/`mate` are SIDE-TO-MOVE relative. This is not
 * assumed — it is read directly off zugzwang/src/serve_handlers.cpp's
 * book_eval_json() doc comment ("BookEntry::score/mate are side-to-move
 * relative, same convention as eval_json", serve_handlers.cpp ~line 365),
 * and eval_json() is documented as side-to-move-relative too
 * (serve_json.h). `eval_cache.eval_value` is ALSO side-to-move POV
 * (EvalCache::$eval_value doc comment). So the two conventions already
 * match — no sign flip, UNLIKE LichessEvalImportService, whose dump is
 * WHITE-relative and does negate for black to move. Pinned by
 * BookEvalImportServiceTest fixtures in both directions (black-to-move and
 * white-to-move FENs), not just asserted here.
 *
 * Never-downgrade ordering: this class does NOT reimplement it. Every write
 * goes through EvalCacheService::put(), which already owns that logic — see
 * importRow()'s doc comment for how insert/update/skip is classified by
 * observing state before/after put(), rather than re-deriving the ordering.
 */
class BookEvalImportService
{
    public function __construct(
        private readonly EvalCacheService $cache = new EvalCacheService(),
    ) {
    }

    /**
     * Parse one TSV line into an eval_cache-ready row, or null if the line
     * is malformed/short/unusable. Never throws — the TSV comes from a
     * separate tool run and is treated as untrusted input, same as the
     * Lichess importer treats its dump.
     *
     * @return array{fen:string, eval:array{type:string,value:int}, depth:int,
     *   bestmove:string, pv:list<string>}|null
     */
    public function convertLine(string $line): ?array
    {
        $line = rtrim($line, "\n\r");
        if ($line === '') {
            return null;
        }

        $fields = explode("\t", $line);
        if (count($fields) !== 5) {
            return null;
        }

        [$fen, $scoreStr, $mateStr, $depthStr, $pvStr] = $fields;

        $fen = trim($fen);
        $fenFields = preg_split('/\s+/', $fen) ?: [];
        if ($fen === '' || count($fenFields) !== 6) {
            return null; // must be a full 6-field FEN, not a normalized key
        }

        if (!is_numeric($scoreStr) || !is_numeric($mateStr) || !is_numeric($depthStr)) {
            return null;
        }
        $score = (int) $scoreStr;
        $mate = (int) $mateStr;
        $depth = (int) $depthStr;
        if ($depth <= 0) {
            return null;
        }

        $pv = preg_split('/\s+/', trim($pvStr)) ?: [];
        $pv = array_values(array_filter($pv, static fn (string $m): bool => $m !== ''));
        if ($pv === []) {
            return null;
        }

        // Same rule as book_eval_json() in serve_handlers.cpp: a non-zero
        // mate field wins over the cp score.
        $evalType = $mate !== 0 ? 'mate' : 'cp';
        $evalValue = $mate !== 0 ? $mate : $score;

        return [
            'fen' => $fen,
            'eval' => ['type' => $evalType, 'value' => $evalValue],
            'depth' => $depth,
            'bestmove' => $pv[0],
            'pv' => $pv,
        ];
    }

    /**
     * Write one converted row through EvalCacheService::put() — the only
     * place the never-downgrade ordering lives, so this method does not
     * duplicate it. Classification is done by snapshotting the stored row's
     * (depth, multipv, nodes, eval_type, eval_value) tuple before the call
     * and comparing it to the same tuple after: unchanged means put()
     * declined the write (a downgrade), changed-from-null means an insert,
     * changed-from-something means an update. Must run inside a transaction
     * the caller controls (scripts/import_book_evals.php) so a dry run can
     * roll everything back after classifying it — the classification itself
     * still runs put()'s REAL logic, not a re-derived approximation of it.
     *
     * @param array{fen:string, eval:array{type:string,value:int}, depth:int,
     *   bestmove:string, pv:list<string>} $row
     * @return 'insert'|'update'|'skip'
     */
    public function importRow(array $row, string $source = 'book'): string
    {
        $key = $this->cache->normalizeKey($row['fen']);
        if ($key === '') {
            return 'skip';
        }

        $before = EvalCache::firstWhere('fen_key', '=', $key);
        $beforeState = $before instanceof EvalCache ? $this->fingerprint($before) : null;

        $this->cache->put($row['fen'], [
            'eval' => $row['eval'],
            'depth' => $row['depth'],
            'bestmove' => $row['bestmove'],
            'pv' => $row['pv'],
        ], $source);

        $after = EvalCache::firstWhere('fen_key', '=', $key);

        if ($beforeState === null) {
            return $after instanceof EvalCache ? 'insert' : 'skip';
        }
        if (!$after instanceof EvalCache) {
            return 'skip'; // defensive: put() declined to write anything
        }

        return $this->fingerprint($after) === $beforeState ? 'skip' : 'update';
    }

    /** @return array{int,int,int,string,int} */
    private function fingerprint(EvalCache $e): array
    {
        return [$e->depth, $e->multipv, $e->nodes, $e->eval_type, $e->eval_value];
    }
}
