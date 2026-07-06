package nnue

import (
	"os"
	"sort"
	"testing"

	"github.com/timanthonyalexander/gomachine/internal/chess"
)

// ============================================================================
// DYNAMIC king-bucket verification battery. Each test empirically kills a bug
// class by dumping data + diffing against an INDEPENDENT reference (a Go replica
// of the Rust bullet map_features, with its OWN ray-based attack generation — it
// does NOT call chess.PseudoAttacks, so the parity checks catch both an
// index-formula bug and an attack-geometry disagreement).
//
// Run: GOEXPERIMENT=simd ~/go/bin/go1.27rc1 test ./internal/nnue/ -run KBVerify -v
// (scalar `go test` is fine too — these are logic-only.)
// ============================================================================

// ---- Independent Rust map_features replica (CPU-only, own attack gen) -------

// rustKbucket replicates chessgo_lean_threats.rs kbucket(sq).
func rustKbucket(sq int) int {
	r := sq >> 3
	f := sq & 7
	return (r>>1)*4 + (f >> 1)
}

// rustRay replicates the Rust ray(): slide from sq in (df,dr) until off-board or
// a blocker (inclusive). occ is a 64-bit occupancy (bit s set == occupied).
func rustRay(sq int, occ uint64, df, dr int) uint64 {
	var bb uint64
	f := sq%8 + df
	r := sq/8 + dr
	for f >= 0 && f < 8 && r >= 0 && r < 8 {
		s := r*8 + f
		bb |= 1 << uint(s)
		if occ&(1<<uint(s)) != 0 {
			break
		}
		f += df
		r += dr
	}
	return bb
}

// rustPieceAttacks replicates Rust piece_attacks(pc, sq, occ). pc is bullet-nibble
// encoded: type = pc&7 (0=P,1=N,2=B,3=R,4=Q,5=K), color bit = pc&8.
func rustPieceAttacks(pc uint8, sq int, occ uint64) uint64 {
	switch pc & 7 {
	case 0: // pawn
		return rustPawnAttacks(pc&8 > 0, sq)
	case 1: // knight
		return rustLeaper(sq, [][2]int{{1, 2}, {2, 1}, {2, -1}, {1, -2}, {-1, -2}, {-2, -1}, {-2, 1}, {-1, 2}})
	case 2: // bishop
		return rustBishop(sq, occ)
	case 3: // rook
		return rustRook(sq, occ)
	case 4: // queen
		return rustBishop(sq, occ) | rustRook(sq, occ)
	case 5: // king
		return rustLeaper(sq, [][2]int{{1, 0}, {1, 1}, {0, 1}, {-1, 1}, {-1, 0}, {-1, -1}, {0, -1}, {1, -1}})
	}
	return 0
}

func rustLeaper(sq int, deltas [][2]int) uint64 {
	var bb uint64
	f0, r0 := sq%8, sq/8
	for _, d := range deltas {
		f, r := f0+d[0], r0+d[1]
		if f >= 0 && f < 8 && r >= 0 && r < 8 {
			bb |= 1 << uint(r*8+f)
		}
	}
	return bb
}

func rustPawnAttacks(black bool, sq int) uint64 {
	var bb uint64
	f0, r0 := sq%8, sq/8
	dr := 1
	if black {
		dr = -1
	}
	for _, df := range []int{-1, 1} {
		f, r := f0+df, r0+dr
		if f >= 0 && f < 8 && r >= 0 && r < 8 {
			bb |= 1 << uint(r*8+f)
		}
	}
	return bb
}

func rustBishop(sq int, occ uint64) uint64 {
	return rustRay(sq, occ, 1, 1) | rustRay(sq, occ, 1, -1) | rustRay(sq, occ, -1, 1) | rustRay(sq, occ, -1, -1)
}
func rustRook(sq int, occ uint64) uint64 {
	return rustRay(sq, occ, 1, 0) | rustRay(sq, occ, -1, 0) | rustRay(sq, occ, 0, 1) | rustRay(sq, occ, 0, -1)
}

// boardNibbles extracts a bullet-style piece-on-square array (255=empty) and the
// occupancy from a Go position, driven only by PieceOn — no Go attack tables.
func boardNibbles(pos *chess.Position) (at [64]uint8, occ uint64) {
	for s := 0; s < 64; s++ {
		at[s] = 255
		pc := pos.PieceOn(chess.Square(s))
		if pc == chess.NoPiece {
			continue
		}
		nib := uint8(pc.Type())
		if pc.Color() == chess.Black {
			nib |= 8
		}
		at[s] = nib
		occ |= 1 << uint(s)
	}
	return
}

// rustMapFeatures replicates map_features(): returns the White-perspective (stm /
// first-arg) and Black-perspective (ntm / second-arg) feature-index sets exactly
// as the Rust trainer emits them. Independent of chess.PseudoAttacks.
func rustMapFeatures(pos *chess.Position) (stm, ntm []int) {
	at, occ := boardNibbles(pos)

	// king squares
	wk, bk := -1, -1
	for s := 0; s < 64; s++ {
		if at[s] == 255 {
			continue
		}
		if at[s]&7 == 5 {
			if at[s]&8 > 0 {
				bk = s
			} else {
				wk = s
			}
		}
	}
	const BASE = 768
	const PSQ = 16 * BASE // 12288
	offStm := rustKbucket(wk) * BASE
	offNtm := rustKbucket(bk^56) * BASE

	// base 768, king-bucketed
	for s := 0; s < 64; s++ {
		if at[s] == 255 {
			continue
		}
		pc := at[s]
		c := 0
		if pc&8 > 0 {
			c = 1
		}
		t := 64 * int(pc&7)
		stmOwn := [2]int{0, 384}[c]
		ntmOwn := [2]int{384, 0}[c]
		stm = append(stm, offStm+stmOwn+t+s)
		ntm = append(ntm, offNtm+ntmOwn+t+(s^56))
	}

	// threats
	for s := 0; s < 64; s++ {
		if at[s] == 255 {
			continue
		}
		pc := at[s]
		cAtt := 0
		if pc&8 > 0 {
			cAtt = 1
		}
		tAtt := int(pc & 7)
		targets := rustPieceAttacks(pc, s, occ) & occ
		for targets != 0 {
			tsq := trailingZeros64(targets)
			targets &= targets - 1
			victim := at[tsq]
			cVic := 0
			if victim&8 > 0 {
				cVic = 1
			}
			tVic := int(victim & 7)

			aStm := cAtt*6 + tAtt
			vStm := cVic*6 + tVic
			stm = append(stm, PSQ+(aStm*12+vStm)*64+tsq)

			aNtm := (1-cAtt)*6 + tAtt
			vNtm := (1-cVic)*6 + tVic
			ntm = append(ntm, PSQ+(aNtm*12+vNtm)*64+(tsq^56))
		}
	}
	return stm, ntm
}

func trailingZeros64(x uint64) int {
	n := 0
	for x&1 == 0 {
		x >>= 1
		n++
	}
	return n
}

// goFeatureSet returns Go's appendEnrichedFeatures indices for a perspective.
func goFeatureSet(pos *chess.Position, persp chess.Color) []int {
	var buf [maxEnrichedActive]uint16
	raw := appendEnrichedFeatures(buf[:0], pos, persp)
	out := make([]int, len(raw))
	for i, v := range raw {
		out[i] = int(v)
	}
	return out
}

func sortedCopy(x []int) []int {
	c := append([]int(nil), x...)
	sort.Ints(c)
	return c
}

// setDiff returns elements only in a and only in b (as multisets → sorted).
func setDiff(a, b []int) (onlyA, onlyB []int) {
	sa, sb := sortedCopy(a), sortedCopy(b)
	i, j := 0, 0
	for i < len(sa) && j < len(sb) {
		switch {
		case sa[i] == sb[j]:
			i++
			j++
		case sa[i] < sb[j]:
			onlyA = append(onlyA, sa[i])
			i++
		default:
			onlyB = append(onlyB, sb[j])
			j++
		}
	}
	onlyA = append(onlyA, sa[i:]...)
	onlyB = append(onlyB, sb[j:]...)
	return
}

// ---- CHECK 1: bucket table diff (all 64 squares) ---------------------------

func TestKBVerify1BucketTable(t *testing.T) {
	var goT, rustT [64]int
	mismatch := 0
	for sq := 0; sq < 64; sq++ {
		goT[sq] = int(kingBucketTable[sq])
		rustT[sq] = rustKbucket(sq)
		if goT[sq] != rustT[sq] {
			mismatch++
			t.Errorf("sq %d: Go bucket %d != Rust bucket %d", sq, goT[sq], rustT[sq])
		}
	}
	// Pretty rank-major dump (rank 8 at top, a-file left) for the report.
	dump := func(name string, tab [64]int) {
		t.Logf("%s (rank8 top):", name)
		for r := 7; r >= 0; r-- {
			row := ""
			for f := 0; f < 8; f++ {
				row += pad2(tab[r*8+f])
			}
			t.Logf("  rank %d: %s", r+1, row)
		}
	}
	dump("Go kingBucketTable", goT)
	dump("Rust kbucket      ", rustT)
	if mismatch == 0 {
		t.Logf("PASS check1: all 64 squares identical (0 mismatches)")
	} else {
		t.Fatalf("FAIL check1: %d mismatched squares", mismatch)
	}
}

func pad2(n int) string {
	s := " "
	if n >= 10 {
		s = ""
	}
	return s + itoa(n) + " "
}
func itoa(n int) string {
	if n == 0 {
		return "0"
	}
	neg := n < 0
	if neg {
		n = -n
	}
	var b []byte
	for n > 0 {
		b = append([]byte{byte('0' + n%10)}, b...)
		n /= 10
	}
	if neg {
		b = append([]byte{'-'}, b...)
	}
	return string(b)
}

// ---- CHECK 2: cross-bucket king eval (feature-SET) parity ------------------

func TestKBVerify2CrossBucketParity(t *testing.T) {
	cases := []struct{ name, fen string }{
		// both kings off home; white king g1 (bucket 2), black king c8 (oriented c1
		// → bucket 1): DIFFERENT buckets.
		{"castled-vs-queenside", "2k5/pp3ppp/2n5/3p4/3P4/2N5/PP3PPP/6K1 w - - 0 1"},
		// white king e4 (central, bucket 9), black king e5 — different buckets.
		{"kings-central-diff", "8/8/3q4/4k3/4K3/3Q4/8/8 w - - 0 1"},
		// white king a1 (bucket 0), black king h8 (oriented h1 → bucket 3).
		{"opposite-corners", "7k/8/8/3b4/3B4/8/8/K7 w - - 0 1"},
		{"startpos", chess.StartFEN},
	}
	fail := false
	for _, c := range cases {
		pos, err := chess.ParseFEN(c.fen)
		if err != nil {
			t.Fatalf("%s: %v", c.name, err)
		}
		wkB := rustKbucket(int(pos.KingSquare(chess.White)))
		bkB := rustKbucket(int(pos.KingSquare(chess.Black)) ^ 56)
		rStm, rNtm := rustMapFeatures(pos)
		gStm := goFeatureSet(pos, chess.White)
		gNtm := goFeatureSet(pos, chess.Black)
		oaW, obW := setDiff(gStm, rStm)
		oaB, obB := setDiff(gNtm, rNtm)
		okW := len(oaW) == 0 && len(obW) == 0
		okB := len(oaB) == 0 && len(obB) == 0
		t.Logf("%-22s wkBucket=%d bkBucket=%d | White-persp set-eq=%v (Go=%d Rust=%d) Black-persp set-eq=%v (Go=%d Rust=%d)",
			c.name, wkB, bkB, okW, len(gStm), len(rStm), okB, len(gNtm), len(rNtm))
		if !okW {
			fail = true
			t.Errorf("%s White-persp mismatch: onlyGo=%v onlyRust=%v", c.name, oaW, obW)
		}
		if !okB {
			fail = true
			t.Errorf("%s Black-persp mismatch: onlyGo=%v onlyRust=%v", c.name, oaB, obB)
		}
	}
	if !fail {
		t.Logf("PASS check2: Go feature set == Rust feature set for every perspective incl. cross-bucket kings")
	}
}

// ---- CHECK 3: bucket-crossing refresh (raw accumulator, byte-exact) --------

func TestKBVerify3RefreshOnBucketCross(t *testing.T) {
	n := loadSmokeOrRandom(t)
	st := n.NewStack(4)

	// d1(sq3,bucket1) -> e1(sq4,bucket2): CROSSES. e1(sq4,b2) -> f1(sq5,b2): STAYS.
	type tc struct {
		name       string
		fen        string
		fromSq     chess.Square
		toSq       chess.Square
		wantCross  bool
	}
	cases := []tc{
		{"d1->e1 CROSS b1->b2", "4k3/8/8/8/8/8/8/3K4 w - - 0 1", chess.Square(3), chess.Square(4), true},
		{"e1->f1 SAME  b2==b2", "4k3/8/8/8/8/8/8/4K3 w - - 0 1", chess.Square(4), chess.Square(5), false},
	}
	fail := false
	for _, c := range cases {
		pos, err := chess.ParseFEN(c.fen)
		if err != nil {
			t.Fatalf("%s: %v", c.name, err)
		}
		// find the legal king move matching from->to
		var ml chess.MoveList
		pos.GenerateLegal(&ml)
		var mv chess.Move
		found := false
		for i := 0; i < ml.Len(); i++ {
			m := ml.Get(i)
			if m.From() == c.fromSq && m.To() == c.toSq {
				mv = m
				found = true
				break
			}
		}
		if !found {
			t.Fatalf("%s: move %v->%v not legal in %q", c.name, c.fromSq, c.toSq, c.fen)
		}
		crosses := kingMoveNeedsRefresh(pos, mv)
		if crosses != c.wantCross {
			fail = true
			t.Errorf("%s: kingMoveNeedsRefresh=%v want %v", c.name, crosses, c.wantCross)
		}

		// incremental: Reset(parent) then Push(move)
		st.Reset(pos)
		st.Push(pos, mv)
		incW := append([]int16(nil), st.data[st.sp].w...)
		incB := append([]int16(nil), st.data[st.sp].b...)

		// from-scratch: child position
		child := *pos
		var u chess.Undo
		child.DoMove(mv, &u)
		freshW := make([]int16, n.H)
		freshB := make([]int16, n.H)
		n.buildAcc(freshW, freshB, &child)

		diffs := 0
		firstJ := -1
		for j := 0; j < n.H; j++ {
			if incW[j] != freshW[j] || incB[j] != freshB[j] {
				diffs++
				if firstJ < 0 {
					firstJ = j
				}
			}
		}
		if diffs == 0 {
			t.Logf("%-22s crossesBucket=%v : incremental == from-scratch (%d int16 halves byte-exact)", c.name, crosses, 2*n.H)
		} else {
			fail = true
			t.Errorf("%-22s crossesBucket=%v : %d/%d int16 differ; first j=%d incW=%d freshW=%d incB=%d freshB=%d",
				c.name, crosses, diffs, n.H, firstJ, incW[firstJ], freshW[firstJ], incB[firstJ], freshB[firstJ])
		}
		st.Pop()
	}
	if !fail {
		t.Logf("PASS check3: refresh fires on bucket crossing AND same-bucket delta is exact")
	}
}

// ---- CHECK 4: dense-threat parity (indices >= PsqSize) ---------------------

func TestKBVerify4DenseThreatParity(t *testing.T) {
	// A dense tactical middlegame: many pieces mutually attacking occupied squares.
	fens := []string{
		"r3k2r/p1ppqpb1/bn2pnp1/3PN3/1p2P3/2N2Q1p/PPPBBPPP/R3K2R w KQkq - 0 1", // kiwipete
		"r1bq1rk1/pp2bppp/2n1pn2/2pp4/3P1B2/2PBPN2/PP1N1PPP/R2Q1RK1 w - - 0 1", // closed dense center
	}
	fail := false
	for _, fen := range fens {
		pos, err := chess.ParseFEN(fen)
		if err != nil {
			t.Fatalf("%v", err)
		}
		rStm, rNtm := rustMapFeatures(pos)
		gStm := goFeatureSet(pos, chess.White)
		gNtm := goFeatureSet(pos, chess.Black)
		// isolate threat features (>= PsqSize)
		filt := func(x []int) []int {
			var o []int
			for _, v := range x {
				if v >= PsqSize {
					o = append(o, v)
				}
			}
			return o
		}
		gtW, rtW := filt(gStm), filt(rStm)
		gtB, rtB := filt(gNtm), filt(rNtm)
		oaW, obW := setDiff(gtW, rtW)
		oaB, obB := setDiff(gtB, rtB)
		okW := len(oaW) == 0 && len(obW) == 0
		okB := len(oaB) == 0 && len(obB) == 0
		t.Logf("threats White=%d Black=%d | White set-eq=%v Black set-eq=%v | %s",
			len(gtW), len(gtB), okW, okB, fen)
		if !okW {
			fail = true
			t.Errorf("White threat mismatch: onlyGo=%v onlyRust=%v", oaW, obW)
		}
		if !okB {
			fail = true
			t.Errorf("Black threat mismatch: onlyGo=%v onlyRust=%v", oaB, obB)
		}
	}
	if !fail {
		t.Logf("PASS check4: dense threat-feature sets identical (Go vs independent Rust replica)")
	}
}

// ---- CHECK 5: output-bucket formula ----------------------------------------

func TestKBVerify5OutputBucket(t *testing.T) {
	// bullet MaterialCount<N>: divisor = ceil(32/N); bucket = (popcount-2)/divisor.
	rustBucket := func(pop, nb int) int {
		divisor := (32 + nb - 1) / nb // 32.div_ceil(N)
		return (pop - 2) / divisor
	}
	fens := []struct{ name, fen string }{
		{"startpos (32)", chess.StartFEN},
		{"KQvK (3-piece)", "8/8/8/4k3/8/8/3QK3/8 w - - 0 1"},
		{"KPvK (3-piece)", "8/8/8/4k3/8/4P3/4K3/8 w - - 0 1"},
		{"5-piece", "8/8/4k3/8/8/2B1N3/4K3/6q1 w - - 0 1"},
		{"midgame ~20", "r1bq1rk1/pp3ppp/2n1pn2/3p4/3P4/2N1PN2/PP3PPP/R1BQ1RK1 w - - 0 1"},
	}
	nb := 8
	fail := false
	for _, c := range fens {
		pos, err := chess.ParseFEN(c.fen)
		if err != nil {
			t.Fatalf("%s: %v", c.name, err)
		}
		pop := pos.Occupied().Count()
		g := materialBucket(pos, nb)
		r := rustBucket(pop, nb)
		ok := g == r
		t.Logf("%-16s popcount=%2d | Go bucket=%d Rust bucket=%d match=%v", c.name, pop, g, r, ok)
		if !ok {
			fail = true
			t.Errorf("%s: Go %d != Rust %d", c.name, g, r)
		}
	}
	if !fail {
		t.Logf("PASS check5: Go materialBucket == bullet MaterialCount<8> across piece counts")
	}
}

// ---- CHECK 6: quant-scale consistency across phases ------------------------

func TestKBVerify6QuantScale(t *testing.T) {
	n := loadSmokeOrRandomStrict(t) // needs real weights; skips if smoke absent
	n.SetMoveAware(true)
	cases := []struct{ name, fen string }{
		{"startpos", chess.StartFEN},
		{"midgame", "r1bq1rk1/pp3ppp/2n1pn2/3p4/3P4/2N1PN2/PP3PPP/R1BQ1RK1 w - - 0 1"},
		{"endgame KRvK", "8/8/8/4k3/8/8/3RK3/8 w - - 0 1"},
		{"endgame KPvKP", "8/8/4k3/8/8/4K3/4P3/8 w - - 0 1"},
		// material-imbalance sanity: white up a full queen from startpos
		{"white +Q", "rnb1kbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1"},
	}
	for _, c := range cases {
		pos, err := chess.ParseFEN(c.fen)
		if err != nil {
			t.Fatalf("%s: %v", c.name, err)
		}
		cp := n.Eval(pos)
		t.Logf("%-14s eval=%+6d cp (stm-relative)  pop=%d", c.name, cp, pos.Occupied().Count())
	}
	t.Logf("NOTE check6: inspect magnitudes — startpos≈0, +Q strongly positive, endgames not blown up.")
}

// ---- net loading helpers ---------------------------------------------------

const smokeNetPath = "/private/tmp/claude-501/-Users-tim-alexander-chessgo/e637bd51-b7c2-476a-8019-56b4f592d1f0/scratchpad/kb_fact_smoke.bin"

// loadSmokeOrRandom loads the smoke net if present (prod config), else a random
// net — either is valid for the bit-exact accumulator checks (weight-independent).
func loadSmokeOrRandom(t *testing.T) *EnrichedNet {
	if _, err := os.Stat(smokeNetPath); err == nil {
		n, err := ImportBulletLeanNet(smokeNetPath, 512, 8)
		if err != nil {
			t.Fatalf("import smoke: %v", err)
		}
		n.QuantizeFTInt8()
		n.SetMoveAware(true)
		return n
	}
	n := NewEnrichedNet(512, 16, 32, 8)
	n.lean = true
	for i := range n.W0i {
		n.W0i[i] = int16((i*2654435761)%512 - 256)
	}
	for i := range n.B0i {
		n.B0i[i] = int16((i*40503)%512 - 256)
	}
	n.QuantizeFTInt8()
	n.SetMoveAware(true)
	return n
}

// loadSmokeOrRandomStrict requires the smoke net (real weights) for eval realism.
func loadSmokeOrRandomStrict(t *testing.T) *EnrichedNet {
	if _, err := os.Stat(smokeNetPath); err != nil {
		t.Skipf("smoke net absent (%s) — check6 needs real weights", smokeNetPath)
	}
	n, err := ImportBulletLeanNet(smokeNetPath, 512, 8)
	if err != nil {
		t.Fatalf("import smoke: %v", err)
	}
	n.QuantizeFTInt8()
	return n
}
