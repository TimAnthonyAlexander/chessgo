package nnue

import (
	"os"
	"testing"

	"github.com/timanthonyalexander/gomachine/internal/chess"
)

// TestGoldenEval pins the COMPOSED centipawn output of the prod full-threats NNUE
// eval against frozen expected values, over a diverse FEN set that exercises every
// output bucket. This is the one parity no other test covers as a single number:
// feature extraction, the int16 king-bucket + int16 threat FT accumulator, the
// SCReLU/pairwise activation, the output-bucket selection (occ-2)/4, the int8-L1
// multilayer tail, and the eval_scale=400 → centipawn conversion — all composed.
//
// EXACT composed arithmetic reproduced here (Go source, file:line):
//
//	feature idx : base = bucket*768 + [0/384 by color] + 64*type + (sq^orient^mir)  ∈ [0,12288)
//	              threat = PsqSize(12288) + sfThreatIndex(...)                        ∈ [12288,92144)
//	              (kingbucket.go PsqSize=16*768; threats_sf.go sfThreatIndex)
//	accumulator : acc_i = B0i + Σ_f W0i[f][i], W0i = round(W0*ftQA), ftQA=255       (enriched.go quantizeFT, buildAcc)
//	              stm/opp halves chosen by side-to-move                              (enriched.go:525-528)
//	pairwise    : for the prod int8 tail — pairwiseU8: CReLU each half-pair to
//	              [0,ftQA], /ftQA∈[0,1], multiply, round·int8QA(=127) → u8           (enriched_int8.go:100-101, kernels.go)
//	tail L1     : l1[o] = SCReLU( dotU8I8(aq,w8[o])·L1Inv[o] + b1[o] ),
//	              L1Inv = 1/(int8QA·enrichedL1QB), enrichedL1QB=QW=64               (enriched_int8.go:113-115,55)
//	tail L2     : l2[o] = SCReLU( gemvF32(l1,L2W) + b2[o] )                          (enriched_int8.go:119-124)
//	output      : y = OB[bk] + gemvF32(l2,OW);  cp = round(y · CpScale)             (enriched_int8.go:125-128)
//	CpScale     : 400 == bullet eval_scale (SCALE) (bulletimport.go:17, enriched.go:784)
//	output bkt  : (popcount(occ)-2)/ceil(32/NB), NB=8 → /4, clamp[0,7]              (multilayer.go:141 materialBucket == net.go outputBucket == Rust MaterialCount<8>)
//
// SOURCING METHOD — (B) REGRESSION-LOCK (change-detector), NOT an independent oracle.
// The expected values below were captured from THIS Go Eval on the shipped prod net
// (data/nnue/kb-mirror.bin, the SF full-threats net chessgo_threats_sf_640). They are
// FROZEN: any future accidental change to the bucket formula, eval_scale, a quant
// scale (ftQA/int8QA/QW), the activation, or a weight-layout/transpose bug will shift
// these numbers and break this test. It does NOT independently prove Go matches the
// Rust trainer's float forward — only that the composed Go path does not silently drift.
//
// Why not (A) an independent Rust oracle: the Rust trainer
// (~/nnue-training/bullet/examples/chessgo_ml_threats_sf.rs) has NO single-FEN eval
// entrypoint — it is a GPU trainer whose main() streams ~40 GB of /dev/shm binpacks
// through a metal/cuda graph. Producing raw_output(fen)×400 would mean building bullet
// (metal/cuda features) and re-implementing its forward on the folded export — neither
// is runnable in this environment. The Go↔Rust FEATURE-emission parity IS already
// pinned byte-exact by TestSFThreatCrossCheck / TestSFThreatDumpForRust (Go) +
// cross_check_dump (Rust) over 500+ positions; the semantic equivalence of the eval
// FORMULA (activation/scale/bucket/quant) is documented above and matched constant-for-
// constant (ftQA=255=QA, int8QA=127=QACT, QW=64, SCALE=400, MaterialCount<8>). This
// freeze fills the remaining gap: the composed OUTPUT value.
//
// If the net file is absent (it is gitignored, 180 MB), the test SKIPS — matching how
// the crosscheck-dump tests gate on their fixture.

// goldenTol is the accepted |Go − frozen| deviation in centipawns. On the exact scalar
// build these values were frozen from, the match is bit-exact (tol 0 would pass); 5 cp
// absorbs the tiny float-reassociation differences a SIMD gemv build can introduce in
// the L2/output float tail. Small enough that any real bucket/scale/quant/layout
// regression (tens–hundreds of cp) still trips it.
const goldenTol = 5

// goldenNetPath is the prod net, cwd-relative to this package dir (internal/nnue/).
const goldenNetPath = "../../data/nnue/kb-mirror.bin"

type goldenCase struct {
	fen  string
	want int
}

// goldenCases: 38 diverse legal positions — openings/high-material, castled
// middlegames, opposite-side king safety, both sides to move, heavy tactical
// imbalances, rook/minor/pawn endgames, and 5-piece-or-fewer positions — chosen so
// materialBucket spans ALL of bucket 0..7 (verified in the test below). Expected
// values are FROZEN Go Eval outputs (prod int8-L1 multilayer config).
var goldenCases = []goldenCase{
	{"rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1", 69},                 // occ=32 bk=7
	{"rnbqkbnr/pppppppp/8/8/4P3/8/PPPP1PPP/RNBQKBNR b KQkq e3 0 1", -56},             // occ=32 bk=7
	{"r1bqkbnr/pppp1ppp/2n5/1B2p3/4P3/5N2/PPPP1PPP/RNBQK2R b KQkq - 3 3", 33},        // occ=32 bk=7
	{"rnbqkb1r/pp2pppp/3p1n2/2p5/4P3/2N2N2/PPPP1PPP/R1BQKB1R w KQkq - 0 5", 213},     // occ=32 bk=7
	{"r1bq1rk1/pp2bppp/2n1pn2/2pp4/3P1B2/2NBPN2/PPP2PPP/R2Q1RK1 w - - 0 8", 6},       // occ=32 bk=7
	{"r2q1rk1/pp1bbppp/2np1n2/4p3/2B1P3/2NP1N2/PPP2PPP/R1BQ1RK1 w - - 0 9", 475},     // occ=31 bk=7
	{"r1bqk2r/ppp2ppp/2np1n2/2b1p3/2B1P3/2NP1N2/PPP2PPP/R1BQK2R w KQkq - 0 6", 39},   // occ=32 bk=7
	{"2rq1rk1/pp1bbppp/2np1n2/4p3/4P3/1NNP2P1/PPP1QPBP/R1B2RK1 b - - 0 11", -323},    // occ=31 bk=7
	{"r3k2r/pbpnqppp/1p2pn2/3p4/2PP4/2NBPN2/PP1BQPPP/R3K2R w KQkq - 0 10", 1086},     // occ=31 bk=7
	{"r1b1k2r/ppppnppp/2n2q2/2b5/3NP3/2P5/PP3PPP/RNBQKB1R w KQkq - 0 7", -21},        // occ=30 bk=7
	{"rnbq1rk1/ppp1ppbp/3p1np1/8/2PPP3/2N2N2/PP2BPPP/R1BQK2R b KQ - 0 6", -156},      // occ=32 bk=7
	{"r1bqr1k1/pp1nbppp/2p2n2/3p4/3P4/2NBPN2/PPQ2PPP/R1B2RK1 b - - 0 11", -6},        // occ=30 bk=7
	{"r3r1k1/1pq2ppp/p1np1n2/2p1p3/4P3/1BPPBN2/PP1Q1PPP/R3R1K1 w - - 0 15", 1235},    // occ=29 bk=6
	{"2r3k1/1p3ppp/p1n1p3/3pP3/1b1P4/2N1BN2/PP3PPP/2R3K1 w - - 0 18", 1590},          // occ=23 bk=5
	{"6k1/5ppp/8/8/8/8/1R3PPP/6K1 w - - 0 40", 1836},                                 // occ=9  bk=1
	{"r5k1/5ppp/8/8/8/8/5PPP/R5K1 w - - 0 35", 1},                                    // occ=10 bk=2
	{"8/5ppk/8/8/8/8/1R3PPK/8 b - - 0 45", -1988},                                    // occ=7  bk=1
	{"6k1/5ppp/8/8/3B4/8/5PPP/6K1 w - - 0 40", 1736},                                 // occ=9  bk=1
	{"6k1/5ppp/8/3n4/8/8/5PPP/6K1 b - - 0 40", 2204},                                 // occ=9  bk=1
	{"8/8/4k3/8/8/2B1N3/4K3/8 w - - 0 60", 1487},                                     // occ=4  bk=0
	{"8/5ppp/8/8/8/8/5PPP/6K1 w - - 0 50", -7},                                       // occ=7  bk=1
	{"8/p7/8/8/8/8/P7/4K1k1 w - - 0 55", -5},                                         // occ=4  bk=0
	{"4k3/8/8/4P3/8/8/8/4K3 w - - 0 60", 1},                                          // occ=3  bk=0
	{"8/8/8/4k3/8/8/8/R3K3 w - - 0 70", 2057},                                        // occ=3  bk=0
	{"8/8/8/3k4/8/8/8/3QK3 w - - 0 70", 1864},                                        // occ=3  bk=0
	{"8/8/4k3/8/8/4K3/8/6Q1 b - - 0 70", -1984},                                      // occ=3  bk=0
	{"8/8/8/8/8/5k2/6p1/6K1 w - - 0 80", -33},                                        // occ=3  bk=0
	{"r4rk1/1pp2ppp/p1np1n2/8/2PPP3/2N1BN2/PP3PPP/R4RK1 w - - 0 14", 1235},           // occ=26 bk=6
	{"r1bqkb1r/pp3ppp/2n1pn2/2pp4/3P4/2PBPN2/PP1N1PPP/R1BQK2R w KQkq - 0 8", 22},     // occ=32 bk=7
	{"2kr3r/ppp1qppp/2n1bn2/3p4/3P4/2NBPN2/PPPQ1PPP/2KR3R w - - 0 11", 491},          // occ=29 bk=6
	// bucket 4 (occ 18-21)
	{"r4rk1/5ppp/p1n1p3/3p4/3P4/2N1P3/PP3PPP/R4RK1 w - - 0 20", 723},                 // occ=21 bk=4
	{"2r3k1/5ppp/p3p3/1p1p4/3P4/1P2P3/P4PPP/2R3K1 w - - 0 24", 57},                   // occ=18 bk=4
	{"6k1/2r2ppp/p3p3/1p1pP3/3P4/1P3N2/P4PPP/2R3K1 b - - 0 26", -1071},               // occ=19 bk=4
	{"4rrk1/5ppp/p3pn2/1p6/3P4/1P2PN2/P4PPP/2R2RK1 b - - 0 21", -668},                // occ=21 bk=4
	// bucket 3 (occ 14-17)
	{"6k1/5ppp/p3p3/1p6/3P4/1P2P3/P4PPP/2R3K1 w - - 0 28", 1819},                     // occ=16 bk=3
	{"2r3k1/5pp1/p3p2p/8/3P4/1P2P3/P4PPP/2R3K1 b - - 0 30", -1210},                   // occ=16 bk=3
	{"6k1/5ppp/p3p3/8/3P4/4PN2/P4PPP/6K1 w - - 0 32", 1539},                          // occ=14 bk=3
	{"6k1/1r3pp1/p3p2p/8/3P4/1P2PN2/P4PPP/6K1 b - - 0 31", 537},                      // occ=16 bk=3
}

// loadGoldenNet loads the prod net in the EXACT config loadDefaultKBNet ships for the
// full-threats (multilayer) net: multilayer import + int8 L1 tail + move-aware +
// split-refresh + direct-apply + finny. Returns nil (caller skips) if the net is absent.
func loadGoldenNet(t *testing.T) *EnrichedNet {
	t.Helper()
	if _, err := os.Stat(goldenNetPath); err != nil {
		return nil
	}
	n, err := LoadKBNet(goldenNetPath, leanH, leanD2, leanD3, leanNB)
	if err != nil {
		t.Fatalf("LoadKBNet(%s): %v", goldenNetPath, err)
	}
	if n.IsLean() {
		t.Fatalf("%s imported as LEAN — expected the multilayer full-threats net", goldenNetPath)
	}
	// EXACT prod multilayer config (cmd/gomachine/bench.go loadDefaultKBNet).
	n.QuantizeForInt8()
	n.SetMoveAware(true)
	n.SetSplitRefresh(true)
	n.SetDirectApply(true)
	n.SetFinny(true)
	return n
}

// prod arch dims (mirror of cmd/gomachine/bench.go leanEnriched* constants).
const (
	leanH  = 512
	leanD2 = 16
	leanD3 = 32
	leanNB = 8
)

func TestGoldenEval(t *testing.T) {
	n := loadGoldenNet(t)
	if n == nil {
		t.Skipf("prod net %s absent (gitignored 180 MB) — skipping golden eval lock", goldenNetPath)
	}

	seenBucket := [leanNB]bool{}
	for _, c := range goldenCases {
		pos, err := chess.ParseFEN(c.fen)
		if err != nil {
			t.Fatalf("ParseFEN(%q): %v", c.fen, err)
		}
		bk := materialBucket(pos, n.NB)
		seenBucket[bk] = true

		got := n.Eval(pos)
		if d := got - c.want; d < -goldenTol || d > goldenTol {
			t.Errorf("Eval drift: fen=%q got=%d want=%d (Δ=%+d, bucket=%d) — a bucket/scale/quant/activation/layout change?",
				c.fen, got, c.want, d, bk)
		}
	}

	// Breadth guard: the golden set must exercise every output bucket, so a
	// bucket-specific tail regression (e.g. wrong per-bucket weight slice) can't hide
	// in an untested bucket.
	for b := 0; b < leanNB; b++ {
		if !seenBucket[b] {
			t.Errorf("golden set never exercises output bucket %d — add a FEN with that piece count", b)
		}
	}
}

// TestGoldenEvalIncrementalMatchesScratch pins that the INCREMENTAL accumulator path
// (EnrichedStack: split-refresh + finny + direct-apply, as prod search uses) composes
// the identical centipawn value as the from-scratch EnrichedNet.Eval for every golden
// FEN. This guards the second eval entrypoint (the hot search path) against the same
// class of composed-value drift, and against the accumulator-layout bugs that only the
// incremental path can have.
func TestGoldenEvalIncrementalMatchesScratch(t *testing.T) {
	n := loadGoldenNet(t)
	if n == nil {
		t.Skipf("prod net %s absent — skipping incremental golden lock", goldenNetPath)
	}
	st := n.NewStack(8)
	for _, c := range goldenCases {
		pos, err := chess.ParseFEN(c.fen)
		if err != nil {
			t.Fatalf("ParseFEN(%q): %v", c.fen, err)
		}
		st.Reset(pos)
		scratch := n.Eval(pos)
		incr := st.Eval(pos)
		if scratch != incr {
			t.Errorf("scratch/incremental eval mismatch: fen=%q scratch=%d incremental=%d",
				c.fen, scratch, incr)
		}
	}
}
