<?php

namespace App\Controllers;

use BaseApi\Controllers\Controller;
use BaseApi\Http\JsonResponse;
use App\Models\User;
use App\Models\EvalCache;
use App\Services\EngineSelector;
use App\Services\AnticheatService;
use App\Services\EvalCacheService;

/**
 * Full-strength position analysis for the eval bar (SPEC §6). Stateless: takes a
 * FEN, returns the engine's best move + evaluation at full power, regardless of
 * any game's bot difficulty.
 *
 *   POST /analyze   { fen, movetime?: <ms>, depth?: <ply>, multipv?, history?: ["<FEN>"...] }
 *   → { eval: {type:"cp"|"mate", value}, bestmove, pv: [uci...], depth, opening, lines, source }
 *
 * `source` tells a caller whether this response was served from `eval_cache`
 * ("cache"), a fresh engine search ("engine"), the precomputed opening book on
 * a `cacheOnly` cache miss ("book" — see `resolveAnalysis()`), or nothing at
 * all ("miss", `cacheOnly` only) — added for the in-browser local-engine
 * feature (frontend/src/lib/engine/), which races a local search against this
 * endpoint and badges a displayed cache result until local analysis
 * supersedes it (see precedence.ts). Purely informational: it does not affect
 * the cache-or-search decision itself.
 *
 * `history` is the prior-position FENs (root→previous). It buys no search
 * strength — it is what lets the engine NAME the opening (its native-Zobrist
 * table resolves the DEEPEST named position along the line, the Lichess rule),
 * both for the position itself (`opening`) and for each `lines[]` entry (the
 * opening that line's first move leads to). Mirrors CandidatesController's
 * `history`; the analysis board now gets the move list off this one search
 * instead of a second /candidates call.
 *
 * `pv` is the principal variation (the engine's predicted best line) as UCI
 * moves from this position, used by the analysis board's engine line. `movetime`
 * (optional, clamped 50..2000ms) lets a caller trade depth for latency — e.g. the
 * engine-vs-engine watch view polls a fast eval every ply; default is full power.
 *
 * `depth` (optional, clamped 1..40) searches to a fixed ply depth instead of by
 * time. The analysis board polls with increasing depths to "stream" a refining
 * evaluation (instant shallow guess, then deeper), and keeps climbing with larger
 * `movetime` ceilings the longer the user stays on one position. A time ceiling
 * still applies so a deep request can't hang; when the returned `depth` is less
 * than requested, the ceiling cut it short — the caller uses that (no further
 * deepening despite more budget) to decide it has settled. `depth` takes priority
 * over `movetime`, which then acts as that ceiling.
 */
class AnalyzeController extends Controller
{
    /**
     * Time-budgeted requests (depth === 0, e.g. the fast eval bar / EvE watch
     * view) have no "requested depth" to match a cache entry against. Treat
     * the cache as usable there only when the stored entry is comfortably
     * deep — deep enough that serving it is strictly better than a fresh
     * budgeted search (deeper AND instant), never a downgrade for a caller
     * that wanted something shallow and fast. 20 lines up with the analysis
     * ladder's own "settled eval" rung (frontend/src/pages/Analysis.tsx).
     */
    private const TIME_BUDGETED_CACHE_MIN_DEPTH = 20;

    public string $fen = '';

    public int $movetime = 0;

    public int $depth = 0;

    public int $multipv = 0;

    /** @var array<int, mixed> Prior-position FENs, root→previous (opening naming only). */
    public array $history = [];

    /**
     * Cache-lookup-only: serve `eval_cache` if it has something deep enough, and
     * NEVER start a search on a miss (`source: 'miss'`, no eval).
     *
     * This is what the analysis board sends once the user's local in-browser
     * engine is doing the searching. Without it, a client running its own engine
     * would still make the server run the full depth ladder for every position —
     * costing MORE server CPU than before the local engine existed, which is the
     * opposite of the point. Lichess gets this for free because their cloud eval
     * is a cache lookup; ours shares an endpoint with a real search, so the
     * distinction has to be explicit.
     */
    public bool $cacheOnly = false;

    public function __construct(
        private readonly EngineSelector $engine,
        private readonly AnticheatService $anticheat,
        private readonly EvalCacheService $evalCache,
    ) {
    }

    public function post(): JsonResponse
    {
        $this->validate([
            'fen' => 'required|string',
            'history' => 'array',
        ]);

        // Anti-cheat: a logged-in user analyzing a position while they have a live
        // game in progress is a strong engine-use tell. Advisory only — this
        // raises a flag for admin review, never blocks the analysis or bans.
        $this->anticheat->checkAnalysisDuringGame($this->currentUser(), $this->fen, 'analyze');

        $depth = $this->depth > 0 ? max(1, min(40, $this->depth)) : 0;
        // With a depth target, movetime is a safety ceiling (deep request can't
        // hang the pool); without one it's the search budget. The analysis board's
        // "keep deepening while parked on a position" ladder passes a large ceiling
        // on its deep rungs — allow up to 45s there — while non-depth callers (the
        // fast eval bar / watch view) stay clamped to 2s. The engine returns as soon
        // as it REACHES the target depth, so the big ceiling only bites on positions
        // too complex to get there.
        $movetime = $this->movetime > 0
            ? ($depth > 0 ? max(500, min(45000, $this->movetime)) : max(50, min(2000, $this->movetime)))
            : ($depth > 0 ? 4000 : 1500);
        $multipv = $this->multipv > 0 ? min(12, $this->multipv) : 0;
        // Coerce to a clean list of FEN strings — the engine skips any entry it
        // can't parse, so a junk element degrades the opening NAME, never the search.
        $history = array_values(array_map('strval', $this->history));

        $result = $this->resolveAnalysis($this->fen, $movetime, $depth, $multipv, $history, $this->cacheOnly);

        return JsonResponse::ok($result);
    }

    /**
     * The actual cache-or-search decision, factored out of {@see post()} so it
     * can be unit-tested without an HTTP harness (no `$this->request`, no
     * anticheat call — just the cache + engine dependencies). Public for that
     * reason; `post()` is still the only real caller.
     *
     * Cache HIT: `opening` is not stored in `eval_cache` (it's path-dependent —
     * the DEEPEST named position along `history` — and the cache key is a bare
     * position), so it is always resolved via the engine's search-free
     * `/opening` lookup ({@see EngineSelector::opening()}), for empty and
     * non-empty history alike.
     *
     * Do NOT shortcut `history === []` to `opening: null`. That looks safe and
     * is not: `Openings::classify` keys on the CURRENT position's own Zobrist,
     * so a named position resolves from the FEN alone with no history at all.
     * Measured against the live engine — /analyze on the Italian Game with no
     * history returns {C50, Italian Game} on the search path, so shortcutting
     * blanked the name on every cache hit.
     *
     * `ok: false` (endpoint missing on an older deployed engine, unreachable,
     * malformed) must NOT surface as `opening: null` — that would blank out a
     * correct name — so it falls through to a full search instead, exactly like
     * a cache miss. Against an engine without `/opening` that degrades to
     * today's behavior rather than serving a wrong field.
     *
     * Cache MISS: unchanged — search, then `put()`.
     *
     * @param list<string> $history Prior-position FENs, root->previous.
     * @return array<string, mixed> {eval, bestmove, pv, depth, opening, lines}
     */
    public function resolveAnalysis(
        string $fen,
        int $movetime,
        int $depth,
        int $multipv,
        array $history,
        bool $cacheOnly = false,
    ): array {
        $cacheable = $this->evalCache->isCacheable($fen, $history);

        if ($cacheable) {
            $minDepth = $depth > 0 ? $depth : self::TIME_BUDGETED_CACHE_MIN_DEPTH;
            $cached = $this->evalCache->get($fen, $minDepth, max(1, $multipv));
            if ($cached instanceof EvalCache) {
                $opening = $this->resolveCachedOpening($fen, $history);
                $lines = $cached->getLines();
                $hit = [
                    'eval' => ['type' => $cached->eval_type, 'value' => $cached->eval_value],
                    'bestmove' => $cached->bestmove,
                    'pv' => $cached->getPv(),
                    'depth' => $cached->depth,
                    'lines' => $lines !== [] ? $lines : null,
                    'source' => 'cache',
                ];

                if ($opening['ok']) {
                    $hit['opening'] = $opening['opening'];

                    return $hit;
                }

                // Opening resolution failed. Normally we fall through to a full
                // search, which resolves `opening` itself. Under cacheOnly we
                // must not — searching is the one thing the caller asked us not
                // to do. Return the eval and OMIT `opening` entirely: the client
                // treats an absent key as "no opinion" and keeps whatever name it
                // is already showing, whereas an explicit null would blank it.
                if ($cacheOnly) {
                    return $hit;
                }
            } elseif ($cacheOnly) {
                // Cache miss, and we are forbidden from searching. Before giving
                // up, consult the book: a pure Zobrist-keyed lookup
                // (EngineSelector::book(), no Search::Context on the engine
                // side), so it's allowed even under cacheOnly. A hit is the
                // ~100-Elo-over-our-search Stockfish-quality move — return it
                // AND write it into eval_cache (source 'book') so every later
                // visit to this position is a pure DB hit, book or not, with no
                // engine call at all. put() still enforces its own
                // never-downgrade ordering, so a depth-22 book entry can't
                // clobber an already-deeper stored row.
                $book = $this->engine->book($fen);
                if ($book['hit'] === true) {
                    $bookResult = [
                        'eval' => $book['eval'],
                        'bestmove' => $book['bestmove'],
                        'pv' => $book['pv'],
                        'depth' => $book['depth'],
                    ];
                    $this->evalCache->put($fen, $bookResult, 'book');

                    return [
                        'eval' => $book['eval'],
                        'bestmove' => $book['bestmove'],
                        'pv' => $book['pv'],
                        'depth' => $book['depth'],
                        'lines' => null,
                        'source' => 'book',
                    ];
                }

                // Book missed too. Say so plainly; the client's local engine
                // supplies the eval.
                return [
                    'eval' => null,
                    'bestmove' => null,
                    'pv' => null,
                    'depth' => null,
                    'lines' => null,
                    'source' => 'miss',
                ];
            }
        }

        if ($cacheOnly) {
            // Not cacheable at all (repetition / near the 50-move rule, where the
            // key cannot represent the position). Still no search.
            return [
                'eval' => null,
                'bestmove' => null,
                'pv' => null,
                'depth' => null,
                'lines' => null,
                'source' => 'miss',
            ];
        }

        $res = $this->engine->analyze($fen, $movetime, $depth, $multipv, $history);

        if ($cacheable) {
            $this->evalCache->put($fen, $res);
        }

        return [
            'eval' => $res['eval'] ?? null,
            'bestmove' => $res['bestmove'] ?? null,
            'pv' => $res['pv'] ?? null,
            'depth' => $res['depth'] ?? null,
            'opening' => $res['opening'] ?? null,
            'lines' => $res['lines'] ?? null,
            'source' => 'engine',
        ];
    }

    /**
     * @param list<string> $history
     * @return array{ok: bool, opening: array<string, mixed>|null}
     */
    private function resolveCachedOpening(string $fen, array $history): array
    {
        return $this->engine->opening($fen, $history);
    }

    /**
     * Resolve the optional logged-in user (session cookie for the SPA, or token
     * auth). Mirrors WsTicketController: $request->user is set only on the token
     * path, so fall back to the session user_id. Returns null when anonymous.
     *
     * @return array<string, mixed>|null
     */
    private function currentUser(): ?array
    {
        $user = $this->request->user ?? null;
        if (is_array($user) && !empty($user['id'])) {
            return $user;
        }

        $uid = $_SESSION['user_id'] ?? null;
        if ($uid) {
            $found = User::find((string) $uid);
            if ($found instanceof User) {
                return $found->jsonSerialize();
            }
        }

        return null;
    }
}
