<?php

namespace App\Services;

use BaseApi\App;
use App\Models\PremoveGame;
use App\Models\PremovePosition;
use App\Models\User;

/**
 * Premove Trainer game logic (docs/tasks/open/premove-trainer.md, the frozen
 * contract this class implements exactly). BaseAPI-only, no hub/Go changes —
 * see the contract §1 for why: solo-vs-engine already lives here, and this
 * mirrors {@see BotGameService}'s server-side clock discipline rather than
 * inventing a second one.
 *
 * The whole feature is one interaction: queue a chain of premoves blind,
 * release it, watch it play out with no feedback between moves. A single move
 * is just a chain of length 1 (contract §4). `release()` is the one code path
 * for that, used identically after a fresh deal and after a mid-chain collapse.
 */
class PremoveTrainerService
{
    /**
     * The rated format's clock length (ms) — a flat 10 seconds, 0 increment.
     * Stored on the row as the descriptive label {@see RATED_TIME_CONTROL}, NOT
     * parsed via BotGame::parseTimeControl() (that helper's "<base
     * minutes>+<increment seconds>" convention assumes minutes; ours is
     * seconds). Difficulty lives entirely in the position's rating, so one
     * fixed clock is the whole rating axis — see the contract §9.
     */
    private const RATED_CLOCK_MS = 15_000;

    /** Label stored on `time_control` for a rated-format attempt. Descriptive
     *  only (see RATED_CLOCK_MS) — not fed through BotGame::parseTimeControl(). */
    public const RATED_TIME_CONTROL = '15+0';

    /** Covers response transit + first paint so "the clock starts NOW" means
     *  when the player actually sees the board (contract §2.3). */
    private const START_GRACE_MS = 250;

    /** Think-time cap for the full-strength defender reply. Off-clock by
     *  construction (contract §2.1), so this can be generous; bounds one
     *  release request to roughly MAX_CHAIN * this at worst. */
    private const DEFENDER_MOVETIME_MS = 120;

    /** Playout cadence (ms/ply) the client MUST animate a rated release at —
     *  also the future-stamp multiplier (contract §2.2, §9). */
    private const PLY_MS_RATED = 320;

    /** Playout cadence (ms/ply) for a casual release — nothing at stake, so it
     *  moves faster. Casual never stamps a future last_move_at (no clock at
     *  all), so this is presentational only. */
    private const PLY_MS_CASUAL = 180;

    /**
     * Most premoves releasable at once. FLAT — deliberately identical for every
     * position, because a per-position cap would leak the answer: telling you
     * "you may queue 6" tells you it's a 6-move win.
     *
     * Being flat, it must therefore sit ABOVE anything the pool can require, or
     * it stops being a request bound and silently becomes a gameplay limit. The
     * pool caps conversions at MAX_CONVERSION_PLIES (30) = 15 player moves, so
     * this is 20: comfortably clear, and still bounded.
     */
    private const MAX_CHAIN = 20;

    /** Row bound: total plies (moves[] length) a single attempt may accumulate
     *  across its whole life, however many releases that takes. Both bounds are
     *  safety rails, not gameplay rules — a 10s clock ends a rated attempt long
     *  before either matters. */
    private const MAX_PLIES = 60;

    /** Slack allowed on the "the playout is still animating" check, for clock
     *  granularity only. An honest client always arrives late, never early. */
    private const EARLY_RELEASE_TOLERANCE_MS = 50;

    /** Fixed-opponent RD for the Glicko-2 update against a puzzle's rating —
     *  same reasoning as PuzzleController::PUZZLE_RD: Lichess puzzle ratings are
     *  settled over millions of attempts, so the "opponent" is treated as
     *  precisely known. */
    private const PREMOVE_RD = 60.0;

    /** Rating half-windows tried in order when picking a position — identical
     *  shape to PuzzleController::RATING_WINDOWS. The last is deliberately huge
     *  so an exhausted band near the target degrades to a different rating
     *  rather than a dead end. */
    private const RATING_WINDOWS = [300, 600, 1200, 10000];

    public function __construct(
        private readonly EngineSelector $engine,
        private readonly Glicko2Service $glicko,
    ) {
    }

    // --- Create ---------------------------------------------------------

    /**
     * Deal a new attempt. `$format` is 'rated' (real clock, isolated Glicko
     * category if logged in) or 'casual' (no clock, no rating, one shot).
     *
     * @throws NoPuzzleAvailableException if the pool has nothing left for this
     *   user at any rating (contract §3.4 — the caller should answer 503).
     */
    public function create(?User $user, string $format): PremoveGame
    {
        $rated = $format === 'rated';

        // Anonymous players pivot on the ordinary new-account rating, matching
        // PuzzleController's anonymous default.
        $pivotTarget = $user instanceof User ? $user->rating_premove : 1500;

        $position = $this->pickPosition($pivotTarget, $user?->id);
        if (!$position instanceof PremovePosition) {
            throw new NoPuzzleAvailableException();
        }

        // Unlike the puzzle pool this replaced, a generated position needs no
        // setup move: `fen` IS the position the player starts from, and its side
        // to move is by construction the winning side (contract §3.1).
        $playerColor = $position->side_to_move === 'b' ? 'b' : 'w';

        $game = new PremoveGame();
        $game->user_id = $user?->id;
        $game->position_id = $position->id;
        $game->rated = $user instanceof User && $rated;
        $game->time_control = $rated ? self::RATED_TIME_CONTROL : null;
        $game->player_color = $playerColor;
        $game->start_fen = $position->fen;
        $game->fen = $position->fen;
        $game->side_to_move = $playerColor;
        // Analytics only, never sent to the client — telling the player how long
        // the conversion is would hand them a third of the work.
        $game->chain_target = (int) ceil($position->conversion_plies / 2);
        $game->opponent_rating = $position->rating;
        $game->setMoves([]);
        $game->setChains([]);

        if ($rated) {
            // Clock behavior follows the FORMAT, not whether this attempt will
            // actually be graded — an anonymous player still gets the real clock
            // (contract §6), just no Glicko update at the end.
            $game->clock_ms = self::RATED_CLOCK_MS;
            $game->last_move_at = (string) (self::nowMs() + self::START_GRACE_MS);
        }

        $game->status = 'ongoing';
        $game->save();

        return $game;
    }

    // --- Release ----------------------------------------------------------

    /**
     * Release a whole chain of premoves and play it out. Returns the plies to
     * animate (`playout`) and, if the chain collapsed against an illegal
     * assumption, the 0-based index it collapsed at.
     *
     * @param list<string> $chain 4-char from+to UCI strings, 1..MAX_CHAIN.
     * @return array{playout: list<array<string, mixed>>, collapsedAt: ?int}
     * @throws \InvalidArgumentException on a malformed chain or a finished game
     *   (contract §8 — the caller should answer 422).
     */
    public function release(PremoveGame $game, array $chain): array
    {
        if ($game->status !== 'ongoing') {
            throw new \InvalidArgumentException('game is already over');
        }
        $this->validateChain($chain);

        $timed = $this->isTimed($game);

        // Clock check: elapsed is snapshotted ONCE, right here, before any
        // engine call — engine think time inside the playout below must never
        // touch it (contract §2.1). A flag ends the attempt outright; the
        // submitted chain is discarded untouched.
        if ($timed) {
            // You cannot act on a position you have not been shown. `last_move_at`
            // is stamped INTO THE FUTURE by the animation length (§2.2), so a
            // release that arrives before it means the client skipped the
            // playback. Without this guard `max(0, ...)` clamps elapsed to zero
            // and every such release is FREE: a script firing back-to-back
            // releases keeps its clock at the starting value forever, grinding
            // unlimited attempts and only ever spending real time on the one that
            // mates. (Verified before the guard: 9 releases, clock never moved.)
            //
            // An honest client is never early — it starts animating on receipt
            // and the last ply lands one full animation AFTER the stamp, so any
            // network latency only pushes it later. The tolerance is for clock
            // granularity, not for slack.
            // Only an ANIMATION stamp is guarded. `last_move_at` is also stamped
            // slightly ahead at creation (START_GRACE_MS), and that one is a
            // legitimate head start, not a playback to sit through — gating on it
            // too would reject the player's very first release. A game with no
            // moves yet has never animated anything, and cannot loop: a release
            // that plays nothing stamps `now + 0`, so the next one is charged
            // normally.
            $notBefore = $game->last_move_at !== null ? (int) $game->last_move_at : 0;
            if ($game->getMoves() !== [] && self::nowMs() + self::EARLY_RELEASE_TOLERANCE_MS < $notBefore) {
                throw new \InvalidArgumentException('the previous moves are still playing out');
            }

            $elapsed = $game->last_move_at !== null
                ? max(0, self::nowMs() - (int) $game->last_move_at)
                : 0;
            $remaining = ($game->clock_ms ?? 0) - $elapsed;
            if ($remaining <= 0) {
                $game->clock_ms = 0;
                $game->status = 'lost';
                $game->end_reason = 'flagged';
                $this->settleRating($game);
                $game->save();

                return ['playout' => [], 'collapsedAt' => null];
            }
            $game->clock_ms = $remaining;
        }

        $moves = $game->getMoves();
        $history = $this->buildHistory($game);
        $fen = $game->fen;
        $playout = [];
        $collapsedAt = null;
        $terminal = false;

        $hitPlyBound = false;
        foreach ($chain as $i => $rawUci) {
            if (count($moves) >= self::MAX_PLIES) {
                $hitPlyBound = true;
                break;
            }

            $uci = $this->resolvePromotion($fen, $rawUci);
            $result = $this->engine->move($fen, $uci, $history);
            if (empty($result['legal'])) {
                // The defender didn't play what we assumed. A first-move collapse
                // is a legitimate, instructive outcome, not an error.
                $collapsedAt = $i;
                break;
            }

            $history[] = $fen;
            $fen = is_string($result['newFen'] ?? null) ? $result['newFen'] : $fen;
            $entry = [
                'ply' => count($moves) + 1,
                'uci' => $uci,
                'san' => is_string($result['san'] ?? null) ? $result['san'] : $uci,
                'fen' => $fen,
                'by' => 'player',
            ];
            $moves[] = $entry;
            $playout[] = $entry;

            $status = is_string($result['status'] ?? null) ? $result['status'] : 'ongoing';
            if ($this->isTerminalStatus($status)) {
                $this->applyTerminal($game, $status, 'player');
                $terminal = true;
                break;
            }

            // Full-strength defender: the un-weakened /bestmove path (no
            // rating/level/worst in limits — EngineSelector::analyze(), not
            // bestMove()), capped at DEFENDER_MOVETIME_MS. Full strength in a
            // mate position naturally plays the longest defense, which is what
            // makes a deviation instructive rather than random (contract §5).
            $reply = $this->engine->analyze($fen, self::DEFENDER_MOVETIME_MS, 0, 0, $history);
            $replyUci = is_string($reply['bestmove'] ?? null) ? $reply['bestmove'] : '';
            if ($replyUci === '') {
                break; // no legal reply found — shouldn't happen pre-terminal; stop the playout
            }
            $replyResult = $this->engine->move($fen, $replyUci, $history);

            $history[] = $fen;
            $fen = is_string($replyResult['newFen'] ?? null) ? $replyResult['newFen'] : $fen;
            $replyEntry = [
                'ply' => count($moves) + 1,
                'uci' => $replyUci,
                'san' => is_string($replyResult['san'] ?? null) ? $replyResult['san'] : $replyUci,
                'fen' => $fen,
                'by' => 'engine',
            ];
            $moves[] = $replyEntry;
            $playout[] = $replyEntry;

            $replyStatus = is_string($replyResult['status'] ?? null) ? $replyResult['status'] : 'ongoing';
            if ($this->isTerminalStatus($replyStatus)) {
                $this->applyTerminal($game, $replyStatus, 'engine');
                $terminal = true;
                break;
            }
        }

        $game->setMoves($moves);
        $game->fen = $fen;
        $parts = explode(' ', $fen);
        $game->side_to_move = (($parts[1] ?? 'w') === 'b') ? 'b' : 'w';

        $chains = $game->getChains();
        $chains[] = array_values($chain);
        $game->setChains($chains);

        if (!$terminal) {
            if (!$timed) {
                // Casual: one shot. Either the chain ran dry or it collapsed —
                // both are a loss (this is a mate trainer; anything short of
                // mate is the same result, contract §5).
                $game->status = 'lost';
                $game->end_reason = $collapsedAt !== null ? 'chain-broke' : 'unresolved';
            } elseif ($hitPlyBound) {
                // The row bound is reached. Ending here is not cosmetic: leaving a
                // rated attempt `ongoing` at MAX_PLIES wedges it permanently —
                // every later release returns an empty playout, no win/loss/flag is
                // ever recorded, and the row sits live forever.
                $game->status = 'lost';
                $game->end_reason = 'unresolved';
            } else {
                // Rated: stays ongoing. Future-stamp last_move_at so the client's
                // playout animation is never silently charged to the player's
                // clock (contract §2.2) — deterministic, server-side, no extra
                // round trip.
                $game->status = 'ongoing';
                $plyMs = self::PLY_MS_RATED;
                $game->last_move_at = (string) (self::nowMs() + count($playout) * $plyMs);
            }
        }

        if ($game->status !== 'ongoing') {
            $this->settleRating($game);
        }

        $game->save();

        return ['playout' => $playout, 'collapsedAt' => $collapsedAt];
    }

    // --- Presentation -------------------------------------------------------

    /**
     * Build the API representation shared by create/release/get (contract §8):
     * the current position, its legal moves (while ongoing), the clock, and —
     * for a release — the plies to animate. The puzzle's `id` and solution
     * never appear here; only the whitelisted fields below are ever emitted.
     *
     * @param list<array<string, mixed>>|null $playout Present only for a release response.
     * @return array<string, mixed>
     */
    public function present(PremoveGame $game, ?array $playout = null, ?int $collapsedAt = null): array
    {
        $timed = $this->isTimed($game);
        $data = $game->jsonSerialize(); // decodes moves/chains, strips position_id

        $legalMoves = [];
        if ($game->status === 'ongoing') {
            $legal = $this->engine->legalMoves($game->fen);
            $legalMoves = $legal['moves'] ?? [];
        }

        $resumeAt = ($game->status === 'ongoing' && $timed && $game->last_move_at !== null)
            ? (int) $game->last_move_at
            : null;

        $out = [
            'id' => $game->id,
            'format' => $timed ? 'rated' : 'casual',
            'rated' => $game->rated,
            'player_color' => $game->player_color,
            'fen' => $game->fen,
            'side_to_move' => $game->side_to_move,
            'legal_moves' => $legalMoves,
            'status' => $game->status,
            'end_reason' => $game->end_reason,
            'clock_ms' => $game->clock_ms,
            'resume_at' => $resumeAt,
            'ply_ms' => $timed ? self::PLY_MS_RATED : self::PLY_MS_CASUAL,
            // Sent, never mirrored client-side. A hardcoded copy on the page
            // silently drifted below this and capped players at 12 while the
            // server allowed 20 — the same duplicated-constant trap ply_ms is
            // sent to avoid.
            'max_chain' => self::MAX_CHAIN,
            'moves' => $data['moves'],
        ];

        $rating = $this->ratingBlock($game);
        if ($rating !== null) {
            $out['rating'] = $rating;
        }

        if ($playout !== null) {
            $out['playout'] = $playout;
            $out['collapsed_at'] = $collapsedAt;
        }

        return $out;
    }

    /**
     * The `rating` block (contract §8): `{before, provisional}` while still
     * ongoing/unsettled, `{before, after, delta, provisional}` once settled.
     * Omitted entirely (null) for a casual or anonymous attempt.
     */
    private function ratingBlock(PremoveGame $game): ?array
    {
        if (!$game->rated || $game->user_id === null) {
            return null;
        }

        if ($game->rating_after !== null) {
            return [
                'before' => $game->rating_before,
                'after' => $game->rating_after,
                'delta' => $game->rating_delta,
                'provisional' => $this->userIsProvisional($game->user_id),
            ];
        }

        $user = User::find($game->user_id);
        if (!$user instanceof User) {
            return null;
        }

        return [
            'before' => $user->rating_premove,
            'provisional' => ((float) $user->rd_premove) > Glicko2Service::PROVISIONAL_RD,
        ];
    }

    private function userIsProvisional(string $userId): bool
    {
        $user = User::find($userId);

        return $user instanceof User && ((float) $user->rd_premove) > Glicko2Service::PROVISIONAL_RD;
    }

    // --- Rating -------------------------------------------------------------

    /**
     * Apply the Glicko-2 update exactly once, only for a logged-in rated
     * attempt (`$game->rated`), mirroring PuzzleController::applyResult() —
     * one Glicko-2 game against the puzzle's own (fixed) rating as the
     * opponent. A row is one attempt, so there is no `alreadyPlayed` guard to
     * write (contract §6): reaching here at all means this is the one and only
     * settlement for this row.
     */
    private function settleRating(PremoveGame $game): void
    {
        if (!$game->rated || $game->user_id === null) {
            return;
        }
        $user = User::find($game->user_id);
        if (!$user instanceof User) {
            return;
        }

        $before = $user->rating_premove;
        $won = $game->status === 'won'; // anything short of mate is a loss (contract §5)

        $idleDays = 0.0;
        if (is_string($user->rated_at_premove) && $user->rated_at_premove !== '') {
            $idleDays = max(0.0, (time() - strtotime($user->rated_at_premove)) / 86400.0);
        }

        $rd = $this->glicko->inflateRd((float) $user->rd_premove, $idleDays);
        [$newRating, $newRd, $newVol] = $this->glicko->update(
            (float) $before,
            $rd,
            (float) $user->vol_premove,
            [['rating' => (float) $game->opponent_rating, 'rd' => self::PREMOVE_RD, 'score' => $won ? 1.0 : 0.0]],
        );

        $after = (int) round($newRating);
        $user->rating_premove = $after;
        $user->rd_premove = $newRd;
        $user->vol_premove = $newVol;
        $user->rated_at_premove = date('Y-m-d H:i:s');
        $user->games_premove = $user->games_premove + 1;
        $user->save();

        $game->rating_before = $before;
        $game->rating_after = $after;
        $game->rating_delta = $after - $before;
    }

    // --- Terminal mapping -----------------------------------------------

    /** ongoing never terminal; checkmate/stalemate/draw-* always are. */
    private function isTerminalStatus(string $status): bool
    {
        return $status === 'checkmate' || $status === 'stalemate' || str_starts_with($status, 'draw');
    }

    /** Contract §5 terminal mapping table. `$by` is who delivered `$status`. */
    private function applyTerminal(PremoveGame $game, string $status, string $by): void
    {
        if ($status === 'checkmate') {
            if ($by === 'player') {
                $game->status = 'won';
                $game->end_reason = 'checkmate';
            } else {
                $game->status = 'lost';
                $game->end_reason = 'mated';
            }

            return;
        }
        if ($status === 'stalemate') {
            $game->status = 'lost';
            $game->end_reason = 'stalemate';

            return;
        }
        // draw-* (insufficient material, fivefold, seventy-five-move — see
        // zugzwang rules.cpp:196-236): this is a mate trainer, so any draw is a
        // loss, same as any other non-mate outcome.
        $game->status = 'lost';
        $game->end_reason = 'draw';
    }

    // --- Chain / history helpers ---------------------------------------

    /** @param list<string> $chain
     * @throws \InvalidArgumentException */
    private function validateChain(array $chain): void
    {
        if ($chain === [] || count($chain) > self::MAX_CHAIN) {
            throw new \InvalidArgumentException('chain must have 1..' . self::MAX_CHAIN . ' moves');
        }
        foreach ($chain as $m) {
            if (!is_string($m) || preg_match('/^[a-h][1-8][a-h][1-8]$/', $m) !== 1) {
                throw new \InvalidArgumentException('chain moves must be 4-character UCI (from+to)');
            }
        }
    }

    /**
     * Repetition history is derived, not stored separately (contract §5):
     * [start_fen, ...moves.map(fen)] minus the last entry (the current `fen`
     * is passed to the engine separately, not as part of its own history).
     *
     * @return list<string>
     */
    private function buildHistory(PremoveGame $game): array
    {
        $fens = array_map(
            static fn (array $m): string => is_string($m['fen'] ?? null) ? $m['fen'] : '',
            $game->getMoves(),
        );
        $all = array_merge([$game->start_fen], $fens);
        array_pop($all);

        return array_values($all);
    }

    /**
     * If `$uci` is a 4-char from+to move and the piece on `from` is a pawn
     * landing on the back rank, resolve the promotion piece to a queen — the
     * premove chain's client sends bare 4-char strings (no promotion suffix,
     * matching useBoardInteraction's premove semantics), and the server always
     * resolves any promotion to a queen (contract §5). This reads the FEN's
     * board field to answer "is this a pawn move to rank 1/8" — a data lookup,
     * not chess rules; the engine still validates and applies the move.
     */
    private function resolvePromotion(string $fen, string $uci): string
    {
        if (strlen($uci) !== 4) {
            return $uci;
        }
        $toRank = $uci[3];
        if ($toRank !== '1' && $toRank !== '8') {
            return $uci;
        }
        $piece = $this->pieceAt($fen, substr($uci, 0, 2));
        if ($piece === null || strtolower($piece) !== 'p') {
            return $uci;
        }

        return $uci . 'q';
    }

    /** The FEN board-field character at `$square` (e.g. "e2"), or null if the
     *  square is empty or the FEN is malformed. */
    private function pieceAt(string $fen, string $square): ?string
    {
        if (strlen($square) !== 2) {
            return null;
        }
        $placement = explode(' ', $fen)[0] ?? '';
        $rows = explode('/', $placement);
        if (count($rows) < 8) {
            return null;
        }
        $file = ord($square[0]) - ord('a');
        $rank = (int) $square[1];
        if ($file < 0 || $file > 7 || $rank < 1 || $rank > 8) {
            return null;
        }
        $row = $rows[8 - $rank] ?? '';
        $col = 0;
        foreach (str_split($row) as $ch) {
            if (ctype_digit($ch)) {
                $col += (int) $ch;
                continue;
            }
            if ($col === $file) {
                return $ch;
            }
            $col++;
        }

        return null;
    }

    private function isTimed(PremoveGame $game): bool
    {
        return $game->time_control !== null;
    }

    /** Now, in epoch milliseconds — see PremoveGame::$last_move_at for why. */
    private static function nowMs(): int
    {
        return (int) round(microtime(true) * 1000);
    }

    // --- Position picking (contract §3.4) ------------------------------

    /**
     * Pick a position near `$target` that this user has not already attempted.
     *
     * Same widening-window indexed scan the puzzle trainer uses (random pivot
     * inside each window, randomized direction, SQL NOT EXISTS de-dup) — but
     * against `premove_position`, which is generated, not mined. There is no
     * theme draw any more: the pool's difficulty axis IS the position's rating,
     * which is itself derived from conversion length and breadth, so a rating
     * window already selects for "how hard is this to convert".
     *
     * De-dup is against this user's own `premove_game` rows. Anonymous players
     * skip it and may see repeats.
     */
    private function pickPosition(int $target, ?string $userId): ?PremovePosition
    {
        foreach (self::RATING_WINDOWS as $window) {
            $lo = max(0, $target - $window);
            $hi = $target + $window;
            $pivot = random_int($lo, $hi);

            $dirs = [['>=', 'ASC'], ['<=', 'DESC']];
            if (random_int(0, 1) === 1) {
                $dirs = array_reverse($dirs);
            }

            foreach ($dirs as [$cmp, $dir]) {
                $id = $this->nearestUnseenPositionId($userId, $lo, $hi, $pivot, $cmp, $dir);
                if ($id === null) {
                    continue;
                }
                $p = PremovePosition::find($id);
                if ($p instanceof PremovePosition) {
                    return $p;
                }
            }
        }

        return null;
    }

    /**
     * Nearest position to `$pivot` in the given direction that `$userId` has
     * never been dealt. `$cmp`/`$dir` are fixed literals (never user input), so
     * they are safe to interpolate; everything else is bound.
     */
    private function nearestUnseenPositionId(
        ?string $userId,
        int $lo,
        int $hi,
        int $pivot,
        string $cmp,
        string $dir,
    ): ?string {
        $where = ['p.rating BETWEEN ? AND ?', "p.rating $cmp ?"];
        $params = [$lo, $hi, $pivot];

        if ($userId !== null) {
            $where[] = 'NOT EXISTS (
                          SELECT 1 FROM premove_game g
                          WHERE g.user_id = ? AND g.position_id = p.id
                        )';
            $params[] = $userId;
        }

        $sql = "SELECT p.id AS id FROM premove_position p
                WHERE " . implode(' AND ', $where) . "
                ORDER BY p.rating $dir LIMIT 1";

        $rows = App::db()->raw($sql, $params);

        return isset($rows[0]['id']) ? (string) $rows[0]['id'] : null;
    }
}
