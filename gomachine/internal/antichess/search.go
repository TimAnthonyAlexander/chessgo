package antichess

import (
	"hash/fnv"
	"math/rand"
	"sort"
	"time"

	"github.com/timanthonyalexander/gomachine/internal/chess"
)

// winScore is the magnitude of a forced-win score (the side to move runs out
// of pieces/moves); ply is subtracted so a faster win (slower loss) is
// preferred. This is the "-emergency-inproc" fallback only — zugzwang's
// dedicated /antichess/bestmove endpoint owns real Antichess strength; this
// shallow search exists purely so a live game never freezes if zugzwang is
// briefly unreachable.
const (
	winScore = 1_000_000
	scoreInf = 2_000_000
)

// Limits configures a BestMove search. Zero-valued fields are "unset": Rating
// 0 / Level -1 mean "not provided"; Depth 0 / MoveTime 0 / Nodes 0 mean "no
// explicit cap" (defaults apply).
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
	Move    string // chosen move in UCI ("e2e4", "e7e8q", or the king-promo "a7a8k")
	Score   int    // centipawns from the side-to-move perspective
	Mate    int    // signed forced-win-in-N (moves); 0 if not a forced win
	HasMove bool   // false when the side to move has no legal move (terminal)
}

// MoveString renders the chosen move (already UCI).
func (r Result) MoveString() string { return r.Move }

type scoredMove struct {
	move  Move
	score int
}

type searchConfig struct {
	depth    int
	movetime time.Duration
	nodes    uint64
	noise    int
	blunder  float64
}

// resolveConfig maps Limits to a concrete plan. Antichess is dominated by the
// forced-capture rule (most positions have very few candidate moves), so a
// shallow depth is both cheap and reasonable for this fallback path.
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
		applyRating(&cfg, 700+clampInt(lim.Level, 0, 10)*280)
	}
	return cfg
}

// applyRating sets depth + weakening (eval noise / blunder rate) from a target Elo.
func applyRating(cfg *searchConfig, rating int) {
	r := clampInt(rating, 700, 3500)
	switch {
	case r < 1800:
		cfg.depth = 1
	case r < 2400:
		cfg.depth = 2
	case r < 3000:
		cfg.depth = 3
	default:
		cfg.depth = 4
	}
	if r < 3000 {
		u := float64(3000-r) / float64(3000-700) // 0..1, 1 at the 700 floor
		cfg.noise = int(400.0 * u * u)
		cfg.blunder = 0.70 * u * u
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

type searcher struct {
	nodes    uint64
	maxNodes uint64
	deadline time.Time
	stopped  bool
}

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

// BestMove searches for the best move via shallow alpha-beta with an
// inverted-material eval (see evaluate), then applies deterministic
// weakening derived from the rating/level so a lower rating plays worse
// REPRODUCIBLY. When there is exactly one legal move (common, since the
// forced-capture rule frequently leaves no choice), it is returned
// immediately without searching.
func BestMove(s State, lim Limits) Result {
	root := s.LegalMoves()
	if len(root) == 0 {
		return Result{HasMove: false}
	}
	if len(root) == 1 {
		return Result{Move: root[0].UCI(), HasMove: true}
	}

	cfg := resolveConfig(lim)
	e := &searcher{maxNodes: cfg.nodes}
	if cfg.movetime > 0 {
		e.deadline = time.Now().Add(cfg.movetime)
	}

	orderMoves(&s, root)
	scored := make([]scoredMove, 0, len(root))
	alpha, beta := -scoreInf, scoreInf
	for _, m := range root {
		child := s.MakeMove(m)
		sc := -e.negamax(&child, cfg.depth-1, -beta, -alpha, 1)
		scored = append(scored, scoredMove{move: m, score: sc})
		if sc > alpha {
			alpha = sc
		}
	}

	sort.SliceStable(scored, func(i, j int) bool {
		if scored[i].score != scored[j].score {
			return scored[i].score > scored[j].score
		}
		return scored[i].move.UCI() < scored[j].move.UCI()
	})

	rng := rand.New(rand.NewSource(int64(seedFor(&s))))
	chosen := scored[weakenPick(scored, cfg, rng)]
	return Result{
		Move:    chosen.move.UCI(),
		Score:   chosen.score,
		Mate:    mateDistance(chosen.score),
		HasMove: true,
	}
}

// negamax is a shallow alpha-beta over legal moves. A side with zero legal
// moves has WON (Antichess's inverted terminal condition), scored as an
// immediate win for the side to move at this node.
func (e *searcher) negamax(s *State, depth, alpha, beta, ply int) int {
	e.nodes++
	if e.stop() {
		return s.evaluate()
	}
	moves := s.LegalMoves()
	if len(moves) == 0 {
		return winScore - ply // the side to move here has no legal move -> it WINS
	}
	if depth <= 0 {
		return s.evaluate()
	}

	orderMoves(s, moves)
	best := -scoreInf
	for _, m := range moves {
		child := s.MakeMove(m)
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

// orderMoves sorts captures first (highest-value victim first) to sharpen
// alpha-beta cutoffs; under the forced-capture rule a non-terminal node's move
// list is either all captures or all quiet moves, so this mostly matters
// among captures.
func orderMoves(s *State, moves []Move) {
	sort.SliceStable(moves, func(i, j int) bool {
		return moveOrderScore(s, moves[i]) > moveOrderScore(s, moves[j])
	})
}

func moveOrderScore(s *State, m Move) int {
	if m.EP {
		return captureValue(chess.Pawn)
	}
	if victim := s.board[m.To]; victim != chess.NoPiece {
		return captureValue(victim.Type())
	}
	return 0
}

// weakenPick returns the index of the root move to play, mirroring Duck/
// Crazyhouse's weakening scheme: bounded deterministic noise re-ranks the
// candidates, and with probability cfg.blunder it deliberately drops to a
// slightly weaker one — never noising away a forced win.
func weakenPick(results []scoredMove, cfg searchConfig, rng *rand.Rand) int {
	if cfg.noise <= 0 && cfg.blunder <= 0 {
		return 0
	}
	if len(results) > 0 && mateDistance(results[0].score) > 0 {
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

// seedFor derives a deterministic RNG seed from the position's FEN.
func seedFor(s *State) uint64 {
	h := fnv.New64a()
	_, _ = h.Write([]byte(s.FEN()))
	return h.Sum64()
}

// mateDistance converts a search score into a signed forced-win-in-N (moves),
// or 0 when the score is not a forced win/loss.
func mateDistance(score int) int {
	const threshold = winScore - 10000
	if score >= threshold {
		plies := winScore - score
		return (plies + 1) / 2
	}
	if score <= -threshold {
		plies := winScore + score
		return -((plies + 1) / 2)
	}
	return 0
}
