<?php

namespace App\Controllers;

use BaseApi\App;
use BaseApi\Controllers\Controller;
use BaseApi\Http\JsonResponse;
use App\Models\Puzzle;
use App\Models\PuzzleAttempt;
use App\Models\User;
use App\Services\EloService;
use App\Services\GomachineClient;

/**
 * Puzzle training (Lichess-style), see docs/SPEC.md §Puzzles.
 *
 * GET  /puzzles/next          — serve a puzzle near the solver's rating_puzzle.
 *                               The solution line is NEVER sent to the client.
 * POST /puzzles/{id}/move     — submit one player move; validated against the
 *                               stored line by INDEX (the solution stays here).
 *
 * Optional session: a logged-in user gets rating-matched + de-duplicated puzzles
 * and an isolated rating_puzzle update; an anonymous solver still plays, casually
 * (no rating, no attempt record). Game ratings (bullet/blitz/rapid/classical)
 * are never touched — puzzle Elo is a wholly separate category.
 *
 * Lichess solution convention: puzzle.fen is BEFORE the opponent's setup move;
 * moves[0] is that move (auto-played), then the line alternates. The player
 * answers the ODD indices.
 */
class PuzzleController extends Controller
{
    /** A non-scripted move counts as a solve if it's within this many centipawns
     *  of the scripted move (engine-judged). 50cp ≈ "no meaningful difference". */
    private const EQUIV_MARGIN_CP = 50;

    /** Think time for the equivalence eval. Short — it only runs when the player
     *  deviates, and a couple hundred ms is plenty to rank candidate moves. */
    private const EVAL_MOVETIME_MS = 350;

    /** Bound from path {id} = Puzzle::ext_id (post route only). */
    public string $id = '';

    /** Bound from ?theme= (get route only). Empty = any theme. */
    public string $theme = '';

    public function __construct(
        private readonly GomachineClient $engine,
        private readonly EloService $elo,
    ) {}

    public function get(): JsonResponse
    {
        $user = $this->resolveUser();
        $target = $user instanceof User ? $user->rating_puzzle : 1500;
        $theme = trim($this->theme);

        $seen = [];
        if ($user instanceof User) {
            $rows = App::db()->raw(
                'SELECT puzzle_id FROM puzzle_attempt WHERE user_id = ?',
                [$user->id],
            );
            foreach ($rows as $r) {
                $seen[$r['puzzle_id']] = true;
            }
        }

        $puzzle = $this->pickPuzzle($target, $theme, $seen);
        if (!$puzzle instanceof Puzzle) {
            return JsonResponse::notFound('No puzzle available for that filter');
        }

        $solution = $puzzle->getMoves();
        if (count($solution) < 2) {
            return JsonResponse::error('Malformed puzzle', 500);
        }

        // Auto-play the opponent's setup move; the player solves from the result.
        $applied = $this->engine->move($puzzle->fen, $solution[0]);
        if (empty($applied['legal'])) {
            return JsonResponse::error('Malformed puzzle', 500);
        }
        $playerFen = $applied['newFen'];
        $legal = $this->engine->legalMoves($playerFen);

        return JsonResponse::ok([
            'id' => $puzzle->id,
            'rating' => $puzzle->rating,
            'start_fen' => $puzzle->fen,
            'opponent_move' => $solution[0],
            'fen' => $playerFen,
            'color' => $applied['sideToMove'] ?? 'w',
            'legal_moves' => $legal['moves'] ?? [],
            'ply' => 1,
        ]);
    }

    public function post(): JsonResponse
    {
        $body = $this->request->body ?? [];
        $move = (string) ($body['move'] ?? '');
        $fen = (string) ($body['fen'] ?? '');
        $ply = (int) ($body['ply'] ?? 0);

        if ($move === '' || strlen($move) > 5) {
            return JsonResponse::badRequest('move is required (UCI)');
        }
        if ($fen === '') {
            return JsonResponse::badRequest('fen is required');
        }

        $puzzle = Puzzle::find($this->id);
        if (!$puzzle instanceof Puzzle) {
            return JsonResponse::notFound('Puzzle not found');
        }

        $solution = $puzzle->getMoves();
        $count = count($solution);
        // Player moves are the odd indices of the solution line.
        if ($ply < 1 || $ply >= $count || $ply % 2 === 0) {
            return JsonResponse::badRequest('Invalid ply');
        }

        $user = $this->resolveUser();
        $exact = ($move === $solution[$ply]);
        $finalPly = ($ply + 1 >= $count);

        // The played move isn't the scripted one — but on "best move" puzzles
        // (endgames, advantage/crushing …) other moves are often just as winning,
        // and a mate-in-N has many mating moves. Ask the engine whether the move is
        // OBJECTIVELY as good; if so, count it as a solve (Lichess does the same).
        $alternative = false;
        if (!$exact) {
            if (!$this->isAcceptableAlternative($fen, $move, $solution[$ply], $finalPly)) {
                return JsonResponse::ok([
                    'correct' => false,
                    'complete' => true,
                    'solved' => false,
                    'solution' => array_values(array_slice($solution, $ply)),
                    'themes' => $puzzle->getThemes(),
                    'rating' => $this->applyResult($user, $puzzle, false),
                ]);
            }
            $alternative = true;
        }

        // Solved when the move is the scripted final move, OR an accepted
        // equivalent/mating alternative (which always ends the puzzle).
        if ($alternative || $finalPly) {
            $applied = $this->engine->move($fen, $move);

            return JsonResponse::ok([
                'correct' => true,
                'complete' => true,
                'solved' => true,
                'alternative' => $alternative,
                'status' => $applied['status'] ?? 'ongoing',
                'fen' => $applied['newFen'] ?? $fen,
                'themes' => $puzzle->getThemes(),
                'rating' => $this->applyResult($user, $puzzle, true),
            ]);
        }

        // Correct, more to go: apply the player move + the scripted reply.
        $afterPlayer = $this->engine->move($fen, $move);
        if (empty($afterPlayer['legal'])) {
            return JsonResponse::badRequest('Illegal move for position');
        }
        $reply = $solution[$ply + 1];
        $afterReply = $this->engine->move($afterPlayer['newFen'], $reply);
        $legal = $this->engine->legalMoves($afterReply['newFen'] ?? $fen);

        return JsonResponse::ok([
            'correct' => true,
            'complete' => false,
            'opponent_move' => $reply,
            'fen' => $afterReply['newFen'] ?? $fen,
            'legal_moves' => $legal['moves'] ?? [],
            'ply' => $ply + 2,
        ]);
    }

    /**
     * Is $played objectively as good as the scripted $solutionMove from $fen?
     *
     * Two acceptances, both chess-correct:
     *   1. Any move that delivers immediate checkmate (a mate-in-N has many mates).
     *   2. On the FINAL player move only, a move whose resulting eval is within
     *      EQUIV_MARGIN_CP of the scripted move's (so "best move" puzzles stop
     *      punishing equally-winning alternatives).
     *
     * Intermediate deviations are never accepted (we can't follow the scripted
     * reply after one), and those plies are almost always genuine only-moves.
     */
    private function isAcceptableAlternative(string $fen, string $played, string $solutionMove, bool $finalPly): bool
    {
        $applied = $this->engine->move($fen, $played);
        if (empty($applied['legal'])) {
            return false; // illegal / not a real move → just wrong
        }
        if (($applied['status'] ?? '') === 'checkmate') {
            return true; // any mate counts
        }
        if (!$finalPly) {
            return false;
        }

        $afterSolution = $this->engine->move($fen, $solutionMove);
        if (empty($afterSolution['legal'])) {
            return false; // malformed solution → fall back to strict matching
        }
        // If the scripted move mates outright, only a mating move is acceptable —
        // and any such move was already accepted above. (A mated position also has
        // no eval to compare, so this avoids a false "equally good" accept.)
        if (($afterSolution['status'] ?? '') === 'checkmate') {
            return false;
        }

        $oursPlayed = $this->ourEvalCp((string) $applied['newFen']);
        $oursSolution = $this->ourEvalCp((string) $afterSolution['newFen']);

        return $oursPlayed >= $oursSolution - self::EQUIV_MARGIN_CP;
    }

    /**
     * Evaluate the position AFTER our move, in centipawns from OUR perspective
     * (the engine reports it from the side-to-move = the opponent, so we negate).
     * Mate scores collapse to large magnitudes so they dominate + order by speed.
     */
    private function ourEvalCp(string $fenAfterOurMove): int
    {
        $res = $this->engine->analyze($fenAfterOurMove, self::EVAL_MOVETIME_MS);
        $eval = is_array($res['eval'] ?? null) ? $res['eval'] : ['type' => 'cp', 'value' => 0];
        $value = (int) ($eval['value'] ?? 0);

        if (($eval['type'] ?? 'cp') === 'mate') {
            // Opponent-POV mate distance → ours is the negation; closer mate = larger.
            $ours = -$value;
            $base = 1_000_000;

            return $ours >= 0 ? $base - $ours : -$base - $ours;
        }

        return -$value; // cp: opponent POV → ours
    }

    /**
     * Pick an unseen puzzle near $target. Uses a random rating pivot + indexed
     * range scan (NOT ORDER BY RAND(), which is O(n) at millions of rows),
     * widening the window until something unseen turns up.
     *
     * @param array<string,bool> $seen
     */
    private function pickPuzzle(int $target, string $theme, array $seen): ?Puzzle
    {
        $window = 300;
        for ($i = 0; $i < 4; $i++, $window += 300) {
            $lo = max(0, $target - $window);
            $hi = $target + $window;
            $pivot = random_int($lo, $hi);

            foreach ([['>=', 'ASC'], ['<=', 'DESC']] as [$cmp, $dir]) {
                foreach ($this->candidateIds($theme, $lo, $hi, $pivot, $cmp, $dir) as $id) {
                    if (isset($seen[$id])) {
                        continue;
                    }
                    $p = Puzzle::find($id);
                    if ($p instanceof Puzzle) {
                        return $p;
                    }
                }
            }
        }

        return null;
    }

    /**
     * @return list<string> candidate puzzle UUIDs. $cmp/$dir are fixed literals
     *                      (never user input), safe to interpolate.
     */
    private function candidateIds(string $theme, int $lo, int $hi, int $pivot, string $cmp, string $dir): array
    {
        if ($theme !== '') {
            $sql = "SELECT puzzle_id AS id FROM puzzle_theme
                    WHERE theme = ? AND rating BETWEEN ? AND ? AND rating $cmp ?
                    ORDER BY rating $dir LIMIT 30";
            $rows = App::db()->raw($sql, [$theme, $lo, $hi, $pivot]);
        } else {
            $sql = "SELECT id FROM puzzle
                    WHERE rating BETWEEN ? AND ? AND rating $cmp ?
                    ORDER BY rating $dir LIMIT 30";
            $rows = App::db()->raw($sql, [$lo, $hi, $pivot]);
        }

        return array_values(array_column($rows, 'id'));
    }

    /**
     * Apply the rated outcome for a logged-in solver, ONCE per puzzle (the first
     * attempt is the rated one). Updates the isolated rating_puzzle only.
     *
     * @return array{value:int,delta:int,games:int}|null null when anonymous.
     */
    private function applyResult(?User $user, Puzzle $puzzle, bool $solved): ?array
    {
        if (!$user instanceof User) {
            return null;
        }

        $alreadyPlayed = App::db()->scalar(
            'SELECT 1 FROM puzzle_attempt WHERE user_id = ? AND puzzle_id = ? LIMIT 1',
            [$user->id, $puzzle->id],
        );
        if ($alreadyPlayed) {
            return ['value' => $user->rating_puzzle, 'delta' => 0, 'games' => $user->games_puzzle];
        }

        $before = $user->rating_puzzle;
        $after = $this->elo->newRating($before, $puzzle->rating, $solved ? 1.0 : 0.0, $user->games_puzzle);

        $user->rating_puzzle = $after;
        $user->games_puzzle = $user->games_puzzle + 1;
        $user->save();

        $attempt = new PuzzleAttempt();
        $attempt->user_id = $user->id;
        $attempt->puzzle_id = $puzzle->id;
        $attempt->solved = $solved;
        $attempt->rating_before = $before;
        $attempt->rating_after = $after;
        $attempt->save();

        return ['value' => $after, 'delta' => $after - $before, 'games' => $user->games_puzzle];
    }

    /**
     * Resolve the optional authenticated user: token-auth payload first, then the
     * SPA session — mirroring WsTicketController.
     */
    private function resolveUser(): ?User
    {
        $u = $this->request->user ?? null;
        $uid = null;
        if (is_array($u) && !empty($u['id'])) {
            $uid = (string) $u['id'];
        } elseif (!empty($_SESSION['user_id'])) {
            $uid = (string) $_SESSION['user_id'];
        }

        if ($uid === null) {
            return null;
        }
        $found = User::find($uid);

        return $found instanceof User ? $found : null;
    }
}
