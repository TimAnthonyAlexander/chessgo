package crazyhouse

import (
	"hash/fnv"
	"math/rand"
	"sort"
	"time"

	"github.com/timanthonyalexander/gomachine/internal/chess"
)

// mateScore is the magnitude of a checkmate score; ply is subtracted so shorter
// mates are preferred. scoreInf bounds the alpha-beta window.
const (
	mateScore = 1_000_000
	scoreInf  = 2_000_000
)

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
	Move    string // chosen move in UCI ("e2e4", "e7e8q" or a drop "P@e4")
	Score   int    // centipawns from the side-to-move perspective
	Mate    int    // signed mate-in-N (moves); 0 if not a forced mate
	HasMove bool   // false when the side to move has no legal move (terminal)
}

// MoveString renders the chosen move (already UCI).
func (r Result) MoveString() string { return r.Move }

// scoredMove pairs a root move with its search score.
type scoredMove struct {
	move  Move
	score int
}

// searchConfig is the resolved per-search plan (after rating/level mapping).
type searchConfig struct {
	depth    int
	movetime time.Duration
	nodes    uint64
	noise    int
	blunder  float64
}

// resolveConfig maps Limits to a concrete plan.
func resolveConfig(lim Limits) searchConfig {
	cfg := searchConfig{depth: 4, movetime: time.Second, nodes: lim.Nodes}
	if lim.MoveTime > 0 {
		cfg.movetime = lim.MoveTime
	}
	switch {
	case lim.Depth > 0:
		cfg.depth = clampInt(lim.Depth, 1, 8)
	case lim.Rating > 0:
		applyRating(&cfg, lim.Rating)
	case lim.Level >= 0:
		applyRating(&cfg, 700+clampInt(lim.Level, 0, 10)*280)
	}
	return cfg
}

// applyRating sets depth + weakening (eval noise / blunder rate) from a target Elo.
// Crazyhouse is sharply tactical, so a shallow but clean search already plays
// strongly; weaker ratings look ahead less and blunder more, fading to zero near
// master level.
func applyRating(cfg *searchConfig, rating int) {
	r := clampInt(rating, 700, 3500)
	switch {
	case r < 1600:
		cfg.depth = 2
	case r < 2200:
		cfg.depth = 3
	case r < 2800:
		cfg.depth = 4
	default:
		cfg.depth = 5
	}
	if r < 2800 {
		u := float64(2800-r) / float64(2800-700) // 0..1, 1 at the 700 floor
		cfg.noise = int(300.0 * u * u)
		cfg.blunder = 0.5 * u * u
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

// BestMove searches for the best move via iterative-deepening alpha-beta with a
// capture/check quiescence, then applies deterministic weakening derived from the
// rating/level so a lower rating plays worse REPRODUCIBLY.
func BestMove(s State, lim Limits) Result {
	root := s.LegalMoves()
	if len(root) == 0 {
		return Result{HasMove: false}
	}

	cfg := resolveConfig(lim)
	e := &searcher{maxNodes: cfg.nodes}
	if cfg.movetime > 0 {
		e.deadline = time.Now().Add(cfg.movetime)
	}

	orderMoves(&s, root)
	var completed []scoredMove // scored root moves from the last fully searched depth
	for depth := 1; depth <= cfg.depth; depth++ {
		scored := make([]scoredMove, 0, len(root))
		aborted := false
		// Each root move is searched with a FULL window so its returned value is its
		// true score (rankable + safe for mate detection), not an alpha-beta bound.
		for _, m := range root {
			child := s.advance(m)
			sc := -e.negamax(&child, depth-1, -scoreInf, scoreInf, 1)
			if e.stopped {
				aborted = true
				break
			}
			scored = append(scored, scoredMove{move: m, score: sc})
		}
		if aborted {
			break
		}
		sort.SliceStable(scored, func(i, j int) bool {
			if scored[i].score != scored[j].score {
				return scored[i].score > scored[j].score
			}
			return scored[i].move.UCI() < scored[j].move.UCI()
		})
		completed = scored
		root = movesOf(scored) // search the best move first next iteration
		if mateDistance(scored[0].score) > 0 {
			break // a forced mate is found; no deeper search needed
		}
		if e.stop() {
			break
		}
	}

	if len(completed) == 0 {
		return Result{Move: root[0].UCI(), HasMove: true} // time too short to finish depth 1
	}

	rng := rand.New(rand.NewSource(int64(seedFor(&s))))
	chosen := completed[weakenPick(completed, cfg, rng)]
	return Result{
		Move:    chosen.move.UCI(),
		Score:   chosen.score,
		Mate:    mateDistance(chosen.score),
		HasMove: true,
	}
}

// movesOf projects the move list out of a scored (already best-first) slice.
func movesOf(scored []scoredMove) []Move {
	moves := make([]Move, len(scored))
	for i, sm := range scored {
		moves[i] = sm.move
	}
	return moves
}

// negamax is alpha-beta over all legal moves (piece moves and drops). Terminal
// positions resolve to a mate (loss for the side to move) or a stalemate draw;
// leaves fall into quiescence.
func (e *searcher) negamax(s *State, depth, alpha, beta, ply int) int {
	e.nodes++
	if e.stop() {
		return 0
	}
	moves := s.LegalMoves()
	if len(moves) == 0 {
		if s.pos.InCheck() {
			return -mateScore + ply // checkmated
		}
		return 0 // stalemate
	}
	if depth <= 0 {
		return e.quiesce(s, alpha, beta, ply)
	}

	orderMoves(s, moves)
	best := -scoreInf
	for _, m := range moves {
		child := s.advance(m)
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

// quiesce resolves tactical noise at the leaves: captures (and, while in check,
// every legal reply so a check is never left hanging) are searched to a quiet
// position before evaluating. Drops are not expanded here (only in the main
// search) to keep the quiescence bounded.
func (e *searcher) quiesce(s *State, alpha, beta, ply int) int {
	e.nodes++
	if e.stop() {
		return 0
	}

	if s.pos.InCheck() {
		moves := s.LegalMoves()
		if len(moves) == 0 {
			return -mateScore + ply
		}
		orderMoves(s, moves)
		best := -scoreInf
		for _, m := range moves {
			child := s.advance(m)
			sc := -e.quiesce(&child, -beta, -alpha, ply+1)
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

	standPat := s.evaluate()
	if standPat >= beta {
		return beta
	}
	if standPat > alpha {
		alpha = standPat
	}
	caps := s.captureMoves()
	orderMoves(s, caps)
	for _, m := range caps {
		child := s.advance(m)
		sc := -e.quiesce(&child, -beta, -alpha, ply+1)
		if sc >= beta {
			return beta
		}
		if sc > alpha {
			alpha = sc
		}
	}
	return alpha
}

// captureMoves returns the legal capturing piece moves (drops never capture; en
// passant is omitted — rare and not worth the extra probe in quiescence).
func (s *State) captureMoves() []Move {
	var caps []Move
	for _, m := range s.LegalMoves() {
		if !m.IsDrop && s.pos.PieceOn(m.To) != chess.NoPiece {
			caps = append(caps, m)
		}
	}
	return caps
}

// orderMoves sorts moves best-first to sharpen alpha-beta cutoffs.
func orderMoves(s *State, moves []Move) {
	sort.SliceStable(moves, func(i, j int) bool {
		return moveOrderScore(s, moves[i]) > moveOrderScore(s, moves[j])
	})
}

// moveOrderScore ranks a move for ordering: winning captures (MVV-LVA) first, then
// checking drops, then promotions, then other drops, then quiet moves.
func moveOrderScore(s *State, m Move) int {
	if m.IsDrop {
		if s.dropGivesCheck(m) {
			return 900
		}
		return 100 + pocketValue[m.Drop]/10
	}
	if victim := s.pos.PieceOn(m.To); victim != chess.NoPiece {
		attacker := s.pos.PieceOn(m.From)
		return 10000 + captureValue(victim.Type())*8 - pieceValue[attacker.Type()]
	}
	if m.Promo != chess.NoPieceType {
		return 800
	}
	return 0
}

// dropGivesCheck reports whether dropping m's piece on m.To attacks the enemy king
// (used for move ordering). The dropped piece is not on the board yet, so its
// attack is computed directly from the target square.
func (s *State) dropGivesCheck(m Move) bool {
	us := s.pos.SideToMove()
	ek := s.pos.KingSquare(us.Opposite())
	if ek == chess.SqNone {
		return false
	}
	occ := s.pos.Occupied() | m.To.BB()
	return chess.PseudoAttacks(chess.MakePiece(us, m.Drop), m.To, occ).Has(ek)
}

// weakenPick returns the index of the root move to play. With no weakening it is
// always 0 (the best). Otherwise it adds bounded, deterministic eval noise to
// re-rank candidates and, with probability cfg.blunder, drops to a slightly weaker
// one — never noising away a forced mate. Randomness is seeded from the position.
func weakenPick(results []scoredMove, cfg searchConfig, rng *rand.Rand) int {
	if cfg.noise <= 0 && cfg.blunder <= 0 {
		return 0
	}
	if len(results) > 0 && mateDistance(results[0].score) > 0 {
		return 0 // keep a forced win
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

	pick := js[0].idx
	if cfg.blunder > 0 && len(js) > 1 && rng.Float64() < cfg.blunder {
		n := 3
		if len(js)-1 < n {
			n = len(js) - 1
		}
		pick = js[1+rng.Intn(n)].idx
	}
	return pick
}

// seedFor derives a deterministic RNG seed from the position (Crazyhouse FEN).
func seedFor(s *State) uint64 {
	h := fnv.New64a()
	_, _ = h.Write([]byte(s.FEN()))
	return h.Sum64()
}

// mateDistance converts a search score into a signed mate-in-N (moves), or 0 when
// the score is not a forced mate.
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
