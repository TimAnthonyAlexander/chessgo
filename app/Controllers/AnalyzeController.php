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
 *   → { eval: {type:"cp"|"mate", value}, bestmove, pv: [uci...], depth, opening, lines }
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

        // `opening` is resolved by the engine from `history` (the DEEPEST named
        // position along the line — see the class doc comment) and is NOT stored
        // in eval_cache; the model deliberately has no `opening` field. A cache
        // hit therefore has nothing to answer `opening` with. Returning null on
        // every hit would be a visible regression for any call that legitimately
        // gets a non-null opening back — and the analysis board's ladder
        // (frontend/src/pages/Analysis.tsx) always sends `history` for every
        // non-root position, so "non-null opening" and "history non-empty"
        // coincide for all but a stray direct-FEN caller. So: only read from /
        // write to the cache when `history` is empty. That's still the single
        // highest-value case (every session's root/start-position lookups), and
        // it makes the cached `opening: null` provably correct rather than a
        // guess — with an empty history the engine's own opening lookup is a
        // pure function of the FEN, so it's stable across calls and, in
        // practice, null for anything that isn't itself a book position.
        $cacheable = $history === [] && $this->evalCache->isCacheable($this->fen, $history);

        if ($cacheable) {
            $minDepth = $depth > 0 ? $depth : self::TIME_BUDGETED_CACHE_MIN_DEPTH;
            $cached = $this->evalCache->get($this->fen, $minDepth, max(1, $multipv));
            if ($cached instanceof EvalCache) {
                $lines = $cached->getLines();

                return JsonResponse::ok([
                    'eval' => ['type' => $cached->eval_type, 'value' => $cached->eval_value],
                    'bestmove' => $cached->bestmove,
                    'pv' => $cached->getPv(),
                    'depth' => $cached->depth,
                    'opening' => null,
                    'lines' => $lines !== [] ? $lines : null,
                ]);
            }
        }

        $res = $this->engine->analyze($this->fen, $movetime, $depth, $multipv, $history);

        if ($cacheable) {
            $this->evalCache->put($this->fen, $res);
        }

        return JsonResponse::ok([
            'eval' => $res['eval'] ?? null,
            'bestmove' => $res['bestmove'] ?? null,
            'pv' => $res['pv'] ?? null,
            'depth' => $res['depth'] ?? null,
            'opening' => $res['opening'] ?? null,
            'lines' => $res['lines'] ?? null,
        ]);
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
