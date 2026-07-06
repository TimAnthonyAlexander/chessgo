package duckchess

import (
	"hash/fnv"
	"math/rand"
	"sort"
	"time"

	"github.com/timanthonyalexander/gomachine/internal/chess"
)

// mateScore is the magnitude of a king-capture (win/loss) score. Ply is subtracted
// so shorter wins (and longer losses) are preferred.
const mateScore = 1_000_000

// Limits configures a BestMove search. Zero-valued fields are "unset": Rating 0 /
// Level -1 mean "not provided"; Depth 0 / MoveTime 0 / Nodes 0 mean "no explicit
// cap" (defaults apply). Precedence: explicit Depth > Rating > Level > default.
type Limits struct {
	Rating   int
	Level    int
	Depth    int
	MoveTime time.Duration
	Nodes    uint64
}

// DefaultLimits returns unset limits (Level -1) so a caller can fill selectively.
func DefaultLimits() Limits { return Limits{Level: -1} }

// Result is the outcome of a BestMove search.
type Result struct {
	Move    PieceMove    // the chosen piece move
	Duck    chess.Square // where the duck is placed
	Score   int          // centipawns from the side-to-move perspective
	Mate    int          // signed mate-in-N (moves); 0 if not a forced king capture
	HasMove bool         // false when the side to move has no legal move (terminal)
}

// MoveString renders the composite move "<pieceUCI>:<duckSquare>".
func (r Result) MoveString() string {
	return r.Move.UCI() + ":" + r.Duck.String()
}

// scoredMove pairs a root move with its heuristic duck placement and search score.
type scoredMove struct {
	move  PieceMove
	duck  chess.Square
	score int
}

// searchConfig is the resolved per-search plan (after rating/level mapping).
type searchConfig struct {
	depth      int
	movetime   time.Duration
	nodes      uint64
	noise      int
	blunder    float64
	duckRandom float64 // probability of a sloppy (random) duck placement instead of the best block
}

// resolveConfig maps Limits to a concrete plan. Duck-Chess search is intentionally
// shallow (2..4 ply of piece moves), so depth is capped tightly.
func resolveConfig(lim Limits) searchConfig {
	cfg := searchConfig{depth: 3, movetime: time.Second, nodes: lim.Nodes}
	if lim.MoveTime > 0 {
		cfg.movetime = lim.MoveTime
	}
	switch {
	case lim.Depth > 0:
		cfg.depth = clampInt(lim.Depth, 1, 6)
	case lim.Rating > 0:
		applyRating(&cfg, lim.Rating)
	case lim.Level >= 0:
		// Map level 0..10 onto the rating ladder (700..3500) and reuse it.
		applyRating(&cfg, 700+clampInt(lim.Level, 0, 10)*280)
	}
	return cfg
}

// applyRating sets depth + weakening (noise/blunder/sloppy-duck) from a target Elo.
//
// Duck Chess is sharply tactical and the duck is a huge lever, so a shallow but
// clean search plays much stronger than its nominal Elo — depth alone at 2..4 made
// even 1500 feel like a titled player. The fix: a much steeper depth ladder (weak
// ratings barely look ahead), stronger eval noise / blunder rates, AND — the piece
// that was missing entirely — deliberately sloppy DUCK placement at lower ratings
// (the optimal block is what made low-rated bots place "brilliant" ducks). All of
// it fades to zero near master level.
func applyRating(cfg *searchConfig, rating int) {
	r := clampInt(rating, 700, 3500)
	switch {
	case r < 1600:
		cfg.depth = 1
	case r < 2200:
		cfg.depth = 2
	case r < 2800:
		cfg.depth = 3
	default:
		cfg.depth = 4
	}
	if r < 2800 {
		u := float64(2800-r) / float64(2800-700) // 0..1, 1 at the 700 floor
		// Weakening coefficients bumped (~+40%) — the duck bot played well ABOVE its
		// nominal rating (flawless duck blocks + clean eval even at shallow depth), so
		// a given rating now injects more eval noise, blunders more often, and places a
		// sloppy duck more often. Pure UX feel knob (not the competitive engine).
		cfg.noise = int(450.0 * u * u)
		cfg.blunder = 0.82 * u * u
		cfg.duckRandom = 0.92 * u * u
	}
}

func clampInt(v, lo, hi int) int {
	if v < lo {
		return lo
	}
	if v > hi {
		return hi
	}
	return v
}

// searcher carries the mutable search budget/state.
type searcher struct {
	nodes    uint64
	maxNodes uint64
	deadline time.Time
	stopped  bool
}

// stop reports whether the node/time budget is exhausted (checked cheaply).
func (e *searcher) stop() bool {
	if e.stopped {
		return true
	}
	if e.maxNodes > 0 && e.nodes >= e.maxNodes {
		e.stopped = true
		return true
	}
	if !e.deadline.IsZero() && e.nodes&1023 == 0 && time.Now().After(e.deadline) {
		e.stopped = true
		return true
	}
	return false
}

// BestMove searches for the best composite move. It plays an immediate king
// capture when available, otherwise runs a shallow alpha-beta over piece moves
// (with heuristic duck placement), then applies deterministic weakening derived
// from the rating/level so a lower rating plays worse REPRODUCIBLY.
func BestMove(s State, lim Limits) Result {
	moves := s.LegalPieceMoves()
	if len(moves) == 0 {
		return Result{HasMove: false}
	}

	// Instant win: capture the enemy king now.
	for _, m := range moves {
		if s.capturesEnemyKing(m) {
			mid, _ := s.doPieceMove(m)
			return Result{Move: m, Duck: chooseDuck(&mid, s.side), Score: mateScore, Mate: 1, HasMove: true}
		}
	}

	cfg := resolveConfig(lim)
	e := &searcher{maxNodes: cfg.nodes}
	if cfg.movetime > 0 {
		e.deadline = time.Now().Add(cfg.movetime)
	}

	orderMoves(&s, moves)

	results := make([]scoredMove, 0, len(moves))
	alpha, beta := -mateScore*2, mateScore*2
	for _, m := range moves {
		mid, _ := s.doPieceMove(m)
		duck := chooseDuck(&mid, s.side)
		child, _ := s.MakeMove(m, duck)
		sc := -e.negamax(&child, cfg.depth-1, -beta, -alpha, 1)
		results = append(results, scoredMove{move: m, duck: duck, score: sc})
		if sc > alpha {
			alpha = sc
		}
	}

	// Rank best-first (deterministic tie-break by UCI so identical scores are
	// stable across runs).
	sort.SliceStable(results, func(i, j int) bool {
		if results[i].score != results[j].score {
			return results[i].score > results[j].score
		}
		return results[i].move.UCI() < results[j].move.UCI()
	})

	// One deterministic RNG (seeded from the position) drives both the move-level
	// weakening and the sloppy duck placement, so replays are identical.
	rng := rand.New(rand.NewSource(int64(seedFor(&s))))
	chosen := results[weakenPick(results, cfg, rng)]

	// Sloppy duck placement: at lower ratings, sometimes drop the duck on a random
	// empty square instead of the optimal block — a big part of why low-rated bots
	// felt unbeatable was flawless duck defense. Never do this in a forced-win line
	// (a random duck could throw away the mate).
	duckSq := chosen.duck
	if cfg.duckRandom > 0 && mateDistance(chosen.score) == 0 && rng.Float64() < cfg.duckRandom {
		mid, _ := s.doPieceMove(chosen.move)
		if alt, ok := randomDuckSquare(&mid, rng); ok {
			duckSq = alt
		}
	}

	return Result{
		Move:    chosen.move,
		Duck:    duckSq,
		Score:   chosen.score,
		Mate:    mateDistance(chosen.score),
		HasMove: true,
	}
}

// randomDuckSquare returns a uniformly random legal duck square (empty, and not the
// duck's current square) in the post-piece-move state, or false if none exists.
func randomDuckSquare(mid *State, rng *rand.Rand) (chess.Square, bool) {
	occ := mid.occupied()
	prev := mid.duck
	cands := make([]chess.Square, 0, 48)
	for sq := chess.Square(0); sq < 64; sq++ {
		if !occ.Has(sq) && sq != prev {
			cands = append(cands, sq)
		}
	}
	if len(cands) == 0 {
		return chess.SqNone, false
	}
	return cands[rng.Intn(len(cands))], true
}

// negamax is a shallow alpha-beta over PIECE moves. King captures resolve as
// terminal wins; a side with no legal move loses; duck placement at each ply is
// the chooseDuck heuristic (not searched).
func (e *searcher) negamax(s *State, depth, alpha, beta, ply int) int {
	e.nodes++
	if e.stop() {
		return s.evaluate()
	}

	moves := s.LegalPieceMoves()
	if len(moves) == 0 {
		return -mateScore + ply // side to move is stuck -> it loses
	}
	for _, m := range moves {
		if s.capturesEnemyKing(m) {
			return mateScore - ply // capture the enemy king now -> win
		}
	}
	if depth <= 0 {
		return s.evaluate()
	}

	orderMoves(s, moves)
	best := -mateScore * 2
	for _, m := range moves {
		mid, _ := s.doPieceMove(m)
		duck := chooseDuck(&mid, s.side)
		child, _ := s.MakeMove(m, duck)
		sc := -e.negamax(&child, depth-1, -beta, -alpha, ply+1)
		if sc > best {
			best = sc
		}
		if best > alpha {
			alpha = best
		}
		if alpha >= beta {
			break
		}
	}
	return best
}

// orderMoves sorts captures first (MVV-style) to sharpen alpha-beta cutoffs.
func orderMoves(s *State, moves []PieceMove) {
	sort.SliceStable(moves, func(i, j int) bool {
		return moveOrderScore(s, moves[i]) > moveOrderScore(s, moves[j])
	})
}

func moveOrderScore(s *State, m PieceMove) int {
	victim := s.board[m.To]
	if victim == chess.NoPiece {
		if m.EP {
			return pieceValue[chess.Pawn]
		}
		return 0
	}
	return captureValue(victim.Type())
}

// weakenPick returns the index of the move to play. With no weakening it is always
// 0 (the best). Otherwise it adds bounded, deterministic eval noise to re-rank the
// candidates and, with probability cfg.blunder, deliberately drops to a slightly
// weaker one. Randomness is seeded from the position so replays are identical.
func weakenPick(results []scoredMove, cfg searchConfig, rng *rand.Rand) int {
	if cfg.noise <= 0 && cfg.blunder <= 0 {
		return 0
	}

	type jittered struct {
		idx   int
		score int
	}
	js := make([]jittered, len(results))
	for i, r := range results {
		noise := 0
		if cfg.noise > 0 {
			noise = rng.Intn(2*cfg.noise+1) - cfg.noise
		}
		js[i] = jittered{idx: i, score: r.score + noise}
	}
	sort.SliceStable(js, func(a, b int) bool { return js[a].score > js[b].score })

	// Never noise away a forced win/loss: if the true best is a mate, keep it.
	if len(results) > 0 && mateDistance(results[0].score) > 0 {
		return 0
	}

	pick := js[0].idx
	if cfg.blunder > 0 && len(js) > 1 && rng.Float64() < cfg.blunder {
		// Drop to one of the next few candidates.
		n := 3
		if len(js)-1 < n {
			n = len(js) - 1
		}
		pick = js[1+rng.Intn(n)].idx
	}
	return pick
}

// seedFor derives a deterministic RNG seed from the position (FEN + duck + side).
func seedFor(s *State) uint64 {
	h := fnv.New64a()
	_, _ = h.Write([]byte(s.FEN()))
	_, _ = h.Write([]byte(s.DuckString()))
	return h.Sum64()
}

// mateDistance converts a search score into a signed mate-in-N (moves), or 0 when
// the score is not a forced king capture.
func mateDistance(score int) int {
	const threshold = mateScore - 10000
	if score >= threshold {
		plies := mateScore - score
		return (plies + 1) / 2
	}
	if score <= -threshold {
		plies := mateScore + score
		return -((plies + 1) / 2)
	}
	return 0
}
