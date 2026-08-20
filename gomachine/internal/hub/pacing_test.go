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
	floors := scheduleFloors(false) // backfill floors — not what this test is about
	var fullSum, sparseSum int64
	for i := 0; i < 2000; i++ {
		fullSum += botThinkDelay(tc, remaining, legal, ply, rating, 32, moveTraits{}, floors, 1, false).Milliseconds()
		sparseSum += botThinkDelay(tc, remaining, legal, ply, rating, 6, moveTraits{}, floors, 1, false).Milliseconds()
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

	floors := scheduleFloors(false) // backfill floors — not what this test is about
	mean := func(mv moveTraits) float64 {
		var sum int64
		const n = 20_000
		for i := 0; i < n; i++ {
			sum += botThinkDelay(tc, remaining, legal, ply, rating, pieces, mv, floors, 1, false).Milliseconds()
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

	floors := scheduleFloors(false) // backfill floors — not what this test is about
	var obviousSum, freeSum int64
	seen := map[int64]bool{}
	for i := 0; i < 4000; i++ {
		obviousSum += botThinkDelay(tc, remaining, legal, ply, rating, pieces, moveTraits{forced: true}, floors, 1, false).Milliseconds()
		d := botThinkDelay(tc, remaining, legal, ply, rating, pieces, moveTraits{}, floors, 1, false).Milliseconds()
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

// A critical-moment think (criticalMult > 1, as armCriticalThink would hand
// scheduleBotMove after a big eval swing) must produce a visibly longer mean
// think than an ordinary move in the same position, clock and time control.
func TestBotThinkDelayCriticalMomentLonger(t *testing.T) {
	tc := timeControl{Base: 300_000, Inc: 0} // 5+0
	const remaining, legal, ply, rating, pieces = int64(300_000), 25, 40, 1600, 24
	floors := scheduleFloors(false)

	mean := func(criticalMult float64) float64 {
		var sum int64
		const n = 20_000
		for i := 0; i < n; i++ {
			sum += botThinkDelay(tc, remaining, legal, ply, rating, pieces, moveTraits{}, floors, criticalMult, false).Milliseconds()
		}
		return float64(sum) / n
	}
	normal := mean(1)
	critical := mean(criticalThinkMultMin) // the low end of the band is still a hard multiplier
	if critical <= normal*1.5 {
		t.Errorf("critical-moment think not meaningfully longer: normal=%.0f critical=%.0f", normal, critical)
	}
}

// However large the critical-moment multiplier or the in-check inflation, the
// clock-safety cap must still bind: a single think may never exceed ~30% of the
// bot's remaining clock. Uses a short remaining clock (so the cap is the tight
// constraint, not maxThinkMs) and the top of the critical-mult band plus
// in-check, the most aggressive combination the pacing model can produce.
// The 30%-of-clock cap bounds the COMPUTED think. The floor is allowed to beat it,
// and must be — see botThinkDelay's floor comment: clamping the floor to the cap
// makes the clock decay geometrically and never reach zero, so no bot could ever
// lose on time. What must hold is that nothing exceeds the cap by MORE than the
// floor, i.e. the eval swing and the check multiplier can't compound into an
// unbounded think.
func TestBotThinkDelayCriticalMomentBoundedByCapOrFloor(t *testing.T) {
	tc := timeControl{Base: 300_000, Inc: 0} // 5+0
	const remaining, legal, ply, rating, pieces = int64(4_000), 25, 40, 1600, 24
	clockCap := remaining * 3 / 10
	for i := 0; i < 5000; i++ {
		floors := scheduleFloors(true) // filler: the highest floor band there is
		maxFloor := int64(float64(floors.normal) * inCheckMult)
		limit := clockCap
		if maxFloor > limit {
			limit = maxFloor
		}
		d := botThinkDelay(tc, remaining, legal, ply, rating, pieces, moveTraits{}, floors, criticalThinkMultMax, true).Milliseconds()
		if d > limit {
			t.Fatalf("think %dms exceeded both the clock cap (%dms) and the raised floor (%dms)", d, clockCap, maxFloor)
		}
	}
}

// The regression test for the whole point of the filler floor: a filler's clock
// must actually reach zero. An earlier revision clamped the floor to 30% of the
// remaining clock, which makes each move take 30% of what's left — a geometric
// decay that never reaches zero, so a Watch-lobby game could never be decided on
// time however high the floor was set.
func TestFillerClockCanRunOut(t *testing.T) {
	tc := timeControl{Base: 180_000, Inc: 0} // 3+0
	const legal, ply, rating, pieces = 25, 40, 1600, 24

	burn := func(floors thinkFloors, start int64, maxMoves int) (int, bool) {
		remaining := start
		for i := 0; i < maxMoves; i++ {
			d := botThinkDelay(tc, remaining, legal, ply, rating, pieces, moveTraits{}, floors, 1, false).Milliseconds()
			remaining -= d
			if remaining <= 0 {
				return i + 1, true
			}
		}
		return maxMoves, false
	}

	// A filler down to five seconds must flag within a plausible number of moves.
	moves, flagged := burn(scheduleFloors(true), 5_000, 200)
	if !flagged {
		t.Fatalf("filler never flagged from 5s over 200 moves — the clock is decaying geometrically")
	}
	if moves > 60 {
		t.Errorf("filler took %d moves to flag from 5s; the floor is not biting", moves)
	}

	// A human-facing backfill bot keeps the original, much lower floors, so it
	// hangs on far longer from the same clock — this is what stops the feature
	// gifting wins on time to humans.
	backfillMoves, _ := burn(scheduleFloors(false), 5_000, 400)
	if backfillMoves <= moves {
		t.Errorf("backfill bot flagged as fast as a filler (%d vs %d moves)", backfillMoves, moves)
	}
}

// A filler's mean think must be far longer than a human-facing backfill bot's,
// in the identical position/clock/time control — that's the entire point of the
// separate floor ladder (fillerFloors vs the backfill consts). Uses a tiny time
// control and a snap move (recapture) so the CENTRAL think collapses toward
// zero and the floor is what's actually being measured, not incidental jitter.
func TestBotThinkDelayFillerFloorFarHigherThanBackfill(t *testing.T) {
	tc := timeControl{Base: 6_000, Inc: 0} // tiny TC: central budget ~nothing, floor dominates
	const remaining, legal, ply, rating, pieces = int64(300_000), 25, 40, 1600, 24

	mean := func(filler bool) float64 {
		var sum int64
		const n = 20_000
		for i := 0; i < n; i++ {
			floors := scheduleFloors(filler) // re-picked each call: filler floors are randomized per move
			sum += botThinkDelay(tc, remaining, legal, ply, rating, pieces, moveTraits{recapture: true, capture: true}, floors, 1, false).Milliseconds()
		}
		return float64(sum) / n
	}
	backfill := mean(false)
	filler := mean(true)
	if filler < backfill*2 {
		t.Errorf("filler think not far longer than backfill: backfill=%.0f filler=%.0f", backfill, filler)
	}
}

// Being in check must lengthen the think relative to the same position and
// move out of check — both the central budget and the floor scale by
// inCheckMult, so this must hold even for a snap move where the floor usually
// dominates.
func TestBotThinkDelayInCheckLonger(t *testing.T) {
	tc := timeControl{Base: 300_000, Inc: 0} // 5+0
	const remaining, legal, ply, rating, pieces = int64(300_000), 25, 40, 1600, 24
	floors := scheduleFloors(false)

	mean := func(inCheck bool) float64 {
		var sum int64
		const n = 20_000
		for i := 0; i < n; i++ {
			sum += botThinkDelay(tc, remaining, legal, ply, rating, pieces, moveTraits{}, floors, 1, inCheck).Milliseconds()
		}
		return float64(sum) / n
	}
	notInCheck := mean(false)
	inCheck := mean(true)
	if inCheck <= notInCheck {
		t.Errorf("in-check think not longer: notInCheck=%.0f inCheck=%.0f", notInCheck, inCheck)
	}
}

// armCriticalThink must fire on a swing at or above criticalSwingCp and must
// NOT fire on an ordinary small move-to-move fluctuation — it's a detector for
// "something happened", not a trigger on every eval wobble.
func TestArmCriticalThinkSwingDetector(t *testing.T) {
	g := &game{}
	// A small, unremarkable fluctuation: must not arm anything.
	g.recordBotEval(chess.White, 20)
	g.recordBotEval(chess.White, 45) // +25cp, well under criticalSwingCp
	if g.criticalThinksOwed[chess.White] != 0 {
		t.Errorf("small swing armed a critical think: owed=%d", g.criticalThinksOwed[chess.White])
	}
	// A big swing (a blunder, from either side) must arm 1 or 2 owed thinks.
	g.recordBotEval(chess.White, 45-criticalSwingCp-1) // definitely crosses the threshold
	if owed := g.criticalThinksOwed[chess.White]; owed < 1 || owed > 2 {
		t.Errorf("big swing did not arm a valid critical-think count: owed=%d", owed)
	}
	// The other color's history is untouched by White's swing.
	if g.criticalThinksOwed[chess.Black] != 0 {
		t.Errorf("swing on White armed Black: owed=%d", g.criticalThinksOwed[chess.Black])
	}
	// consumeCriticalThink spends exactly one and returns a multiplier in band;
	// once exhausted it must report no effect (1).
	before := g.criticalThinksOwed[chess.White]
	mult := g.consumeCriticalThink(chess.White)
	if g.criticalThinksOwed[chess.White] != before-1 {
		t.Errorf("consumeCriticalThink did not decrement: before=%d after=%d", before, g.criticalThinksOwed[chess.White])
	}
	if mult < criticalThinkMultMin || mult > criticalThinkMultMax {
		t.Errorf("consumeCriticalThink multiplier out of band: %v", mult)
	}
}
