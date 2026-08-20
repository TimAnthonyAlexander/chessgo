package hub

import (
	"testing"

	"github.com/timanthonyalexander/gomachine/internal/chess"
)

// boardPieceCount must count only on-board pieces, ignoring empty-run digits,
// rank separators, the trailing FEN fields, and any Crazyhouse [pocket] — across
// every variant that shares the placement field.
func TestBoardPieceCount(t *testing.T) {
	cases := []struct {
		name string
		fen  string
		want int
	}{
		{"opening", chess.StartFEN, 32},
		{"bare kings", "8/8/8/4k3/8/8/4K3/8 w - - 0 1", 2},
		{"KPvK", "8/8/8/4k3/8/4P3/4K3/8 w - - 0 1", 3},
		{"rook endgame", "8/8/8/4k3/8/8/4KP2/6r1 w - - 0 1", 4},
		// A Crazyhouse pocket must NOT inflate the on-board count.
		{"crazyhouse pocket excluded", "4k3/8/8/8/8/8/8/4K3[PPnq] w - - 0 1", 2},
	}
	for _, c := range cases {
		if got := boardPieceCount(c.fen); got != c.want {
			t.Errorf("%s: boardPieceCount(%q) = %d, want %d", c.name, c.fen, got, c.want)
		}
	}
}

// materialSpeedFactor must be ~1.0 at a full board, clamp to 0.40 at/under the
// sparse floor, and stay monotonic in between — fewer pieces never plays slower.
func TestMaterialSpeedFactor(t *testing.T) {
	if f := materialSpeedFactor(32); f < 0.999 || f > 1.001 {
		t.Errorf("full board factor = %v, want ~1.0", f)
	}
	if f := materialSpeedFactor(8); f < 0.399 || f > 0.401 {
		t.Errorf("sparse floor factor = %v, want ~0.40", f)
	}
	if f := materialSpeedFactor(2); f != materialSpeedFactor(8) {
		t.Errorf("below the floor must clamp: %v != %v", f, materialSpeedFactor(8))
	}
	if materialSpeedFactor(40) != materialSpeedFactor(32) {
		t.Error("above a full board must clamp to 1.0")
	}
	prev := 0.0
	for pc := 8; pc <= 32; pc++ {
		f := materialSpeedFactor(pc)
		if f < prev {
			t.Errorf("factor decreased as material grew (pc=%d: %v < %v)", pc, f, prev)
		}
		prev = f
	}
}

// A sparse endgame must yield a shorter think than a full board at the same clock,
// time control, and rating — the "fewer pieces, faster moves" guarantee, verified
// end-to-end through botThinkDelay (opening speed-up excluded by using ply>opening).
func TestBotThinkDelayFasterWithLessMaterial(t *testing.T) {
	tc := timeControl{Base: 300_000, Inc: 0} // 5+0
	const remaining, legal, ply, rating = int64(300_000), 20, 40, 1800
	// Average over many samples to see past botThinkDelay's per-call jitter.
	var fullSum, sparseSum int64
	for i := 0; i < 2000; i++ {
		fullSum += botThinkDelay(tc, remaining, legal, ply, rating, 32, moveTraits{}).Milliseconds()
		sparseSum += botThinkDelay(tc, remaining, legal, ply, rating, 6, moveTraits{}).Milliseconds()
	}
	if sparseSum >= fullSum {
		t.Errorf("sparse endgame not faster: sparseSum=%d fullSum=%d", sparseSum, fullSum)
	}
}

// pieceAtFEN must read the right glyph off the placement field across variants —
// including a Crazyhouse pocket + promoted marker, which must not shift files.
func TestPieceAtFEN(t *testing.T) {
	const mid = "r1bqkb1r/pppp1ppp/2n2n2/4p3/2B1P3/5N2/PPPP1PPP/RNBQK2R w KQkq - 4 4"
	cases := []struct {
		name string
		fen  string
		sq   string
		want byte
	}{
		{"start white pawn", chess.StartFEN, "e2", 'P'},
		{"start black rook", chess.StartFEN, "a8", 'r'},
		{"start empty", chess.StartFEN, "e4", 0},
		{"midgame knight", mid, "f6", 'n'},
		{"midgame bishop", mid, "c4", 'B'},
		{"midgame empty", mid, "d4", 0},
		{"crazyhouse promoted marker", "4k3/8/8/8/8/8/6Q~1/4K3[Pp] b - - 0 1", "g2", 'Q'},
		{"crazyhouse pocket not on board", "4k3/8/8/8/8/8/6Q~1/4K3[Pp] b - - 0 1", "h2", 0},
		{"off board", chess.StartFEN, "j9", 0},
	}
	for _, c := range cases {
		if got := pieceAtFEN(c.fen, c.sq); got != c.want {
			t.Errorf("%s: pieceAtFEN(%q,%q) = %q, want %q", c.name, c.fen, c.sq, got, c.want)
		}
	}
}

// classifyMove must flag forced replies and recaptures (the snap band), and read
// captures and pawn moves off the pre-move position.
func TestClassifyMove(t *testing.T) {
	const mid = "r1bqkb1r/pppp1ppp/2n2n2/4p3/2B1P3/5N2/PPPP1PPP/RNBQK2R w KQkq - 4 4"
	// White pawn on e5 with Black having just pushed d7-d5: e5xd6 e.p.
	const ep = "rnbqkbnr/ppp1pppp/8/3pP3/8/8/PPPP1PPP/RNBQKBNR w KQkq d6 0 3"
	// Chess960: castling is encoded king-takes-own-rook.
	const c960 = "rk6/8/8/8/8/8/8/RK6 w - - 0 1"
	cases := []struct {
		name       string
		fen        string
		moveUCI    string
		lastMoveTo string
		legalCount int
		want       moveTraits
	}{
		{"forced", chess.StartFEN, "a2a3", "", 1,
			moveTraits{forced: true, pawnMove: true}},
		{"recapture", mid, "f3e5", "e5", 20,
			moveTraits{recapture: true, capture: true}},
		{"quiet piece move", mid, "b1c3", "e5", 30, moveTraits{}},
		{"quiet pawn push", chess.StartFEN, "e2e4", "", 20,
			moveTraits{pawnMove: true}},
		{"piece capture, not a recapture", mid, "c4f7", "e5", 30,
			moveTraits{capture: true}},
		{"pawn capture", mid, "d2d4", "", 30, moveTraits{pawnMove: true}},
		{"en passant", ep, "e5d6", "d5", 25,
			moveTraits{capture: true, pawnMove: true}},
		{"chess960 castling is not a capture", c960, "b1a1", "", 10, moveTraits{}},
		{"crazyhouse drop", "4k3/8/8/8/8/8/8/4K3[P] w - - 0 1", "P@e4", "", 20, moveTraits{}},
	}
	for _, c := range cases {
		if got := classifyMove(c.fen, c.moveUCI, c.lastMoveTo, c.legalCount); got != c.want {
			t.Errorf("%s: classifyMove(%q,%q,%d) = %+v, want %+v",
				c.name, c.moveUCI, c.lastMoveTo, c.legalCount, got, c.want)
		}
	}
}

// The move-kind pacing ladder: a snap (forced/recapture) is fastest, a plain
// capture clearly quicker than a quiet move, and a pawn move quicker again.
func TestBotThinkDelayMoveKindLadder(t *testing.T) {
	tc := timeControl{Base: 300_000, Inc: 0} // 5+0
	const remaining, legal, ply, rating, pieces = int64(300_000), 25, 40, 1600, 24

	mean := func(mv moveTraits) float64 {
		var sum int64
		const n = 20_000
		for i := 0; i < n; i++ {
			sum += botThinkDelay(tc, remaining, legal, ply, rating, pieces, mv).Milliseconds()
		}
		return float64(sum) / n
	}
	quiet := mean(moveTraits{})
	pawn := mean(moveTraits{pawnMove: true})
	capture := mean(moveTraits{capture: true})
	snap := mean(moveTraits{recapture: true, capture: true})

	if !(snap < capture && capture < pawn && pawn < quiet) {
		t.Errorf("move-kind pacing out of order: snap=%.0f capture=%.0f pawn=%.0f quiet=%.0f",
			snap, capture, pawn, quiet)
	}
}

// A snap move must, on average, be played much faster than a free choice in the
// same position — and humanTempoJitter must actually spread times out.
func TestBotThinkDelayObviousAndJitter(t *testing.T) {
	tc := timeControl{Base: 300_000, Inc: 0} // 5+0
	const remaining, legal, ply, rating, pieces = int64(300_000), 25, 40, 1600, 24

	var obviousSum, freeSum int64
	seen := map[int64]bool{}
	for i := 0; i < 4000; i++ {
		obviousSum += botThinkDelay(tc, remaining, legal, ply, rating, pieces, moveTraits{forced: true}).Milliseconds()
		d := botThinkDelay(tc, remaining, legal, ply, rating, pieces, moveTraits{}).Milliseconds()
		freeSum += d
		seen[d] = true
	}
	if obviousSum >= freeSum {
		t.Errorf("obvious moves not faster: obviousSum=%d freeSum=%d", obviousSum, freeSum)
	}
	// Fat-tailed jitter ⇒ many distinct think times, not a near-constant value.
	if len(seen) < 100 {
		t.Errorf("think time too constant: only %d distinct values over 4000 samples", len(seen))
	}
}
