package nnue

import (
	"encoding/binary"
	"fmt"
	"math"
	"os"
	"sync/atomic"

	"github.com/timanthonyalexander/gomachine/internal/chess"
)

// EnrichedNet is the first "enriched" multilayer NNUE rung toward the Stormphrax-
// style frontier net (docs/NNUE/ENRICHED_MULTILAYER.md): the bare multilayer arch
// plus THREAT INPUTS — features that tell the net directly "which piece attacks
// which occupied square" instead of making it re-derive attacks from raw piece
// placement. Arch (trained by examples/chessgo_enriched.rs in bullet, QAT):
//
//	(768 psq + 9216 threats = 9984)  --FT--> H  x2
//	  --CReLU--> pairwise-mul   [H/2 per perspective, concat -> H]
//	  --L1(D2)--> SCReLU --L2(D3)--> SCReLU --> 1        x NB output buckets
//
// This is a SEPARATE eval architecture from both the single-layer Net (v6, shipped)
// and the bare MultiNet — selected only when an EnrichedNet is installed via
// SetEnriched. It is the FROM-SCRATCH reference forward (recompute the FT
// accumulator every node), which is the right shape for the speed-independent
// fixed-depth eval-quality gate: NO incremental threat-delta path and NO int8 yet
// (both are Stage-2 movetime work, built only if this rung wins its SPRT). The FT
// rebuild reuses the int16 SIMD addCol kernel so from-scratch stays fast enough to
// gate at fixed depth.
type EnrichedNet struct {
	H  int // FT hidden width per perspective (pre-pairwise)
	D2 int // tail layer-1 width
	D3 int // tail layer-2 width
	NB int // output buckets

	InputDim int // 768 + ThreatDim (the feature count)

	// Feature transformer, feature-major. W0/B0 are the float source; W0i/B0i are
	// the int16 (QA=ftQA) accumulator weights so the from-scratch rebuild uses the
	// fast SIMD addCol kernel.
	W0  []float32
	B0  []float32
	W0i []int16
	B0i []int16

	// Tail layers, per bucket, output-major: a layer mapping in->out stores
	// weight[(bucket*outDim + o)*inDim + i].
	L1W []float32 // NB * D2 * H   (post-pairwise input is H wide)
	L1B []float32 // NB * D2
	L2W []float32 // NB * D3 * D2
	L2B []float32 // NB * D3
	OW  []float32 // NB * D3
	OB  []float32 // NB

	CpScale float32

	// int8 L1 (PTQ, enriched_int8.go). When int8L1 is true, evalFromHalves runs the
	// dominant L1 matmul (pairwise u8 activations × int8 weights, the maddubs path)
	// instead of float — the speed lever that changes the enriched-÷-v6 cost ratio
	// (plain SIMD speeds both equally). L2/L3 stay float (negligible). The QAT net
	// trained the u8 activation grid (QACT=127), so this PTQ is near-lossless.
	int8L1 bool
	L1W8   []int8    // NB * D2 * H, per-output-row int8 quantized L1 weights
	L1Inv  []float32 // NB * D2, per-output descale 1/(int8QA·Sw[o])

	// int8 FT THREAT columns (enriched_int8.go). The threat weight table is the bulk
	// of the FT (9216 columns vs 768 base) and dominates the per-move accumulator
	// cost; storing it int8 (vs int16) halves the addCol memory traffic. The base
	// 768 columns stay int16 (larger magnitude). Lossless only when threat weights
	// are QAT'd into the int8 range at scale ftQA (|W|≤127/255); otherwise clamps.
	int8FT bool
	W0t8   []int8 // ThreatBlock * H, int8 threat columns at scale ftQA (clamped ±127)

	// moveAware makes the incremental Push compute the base+threat feature DELTA
	// directly from the move (affected-attacker diff, enriched_delta.go) instead of
	// re-enumerating the child's FULL feature set and multiset-diffing it. Profiling
	// the lean threats net at movetime showed the push is ~47% of engine CPU, of
	// which the full enumeration (~11%) + the O(active-features) count-array diff
	// (~13%) are pure overhead the move-aware path removes; only the actual column
	// add/subs (the true delta) remain. Bit-identical result — validated by the
	// NNUE_ASSERT from-scratch rebuild.
	moveAware bool

	// LEAN single-layer tail (enriched_lean path). When lean is true, the tail is
	// v6's FAST shape: SCReLU each FT half, concat (2H), one output dot per bucket —
	// NO pairwise, NO multilayer (L1W/L2W/OW unused). This banks the threat eval
	// lever on a cheap tail (the multilayer is a later +30-50 refinement behind int8).
	// TW is input-major [2H × NB]: weight for input i, bucket b at TW[i*NB + b].
	lean bool
	TW   []float32 // 2H * NB  (input-major tail weights)
	TB   []float32 // NB       (tail bias)
	// TWi is the int16 BUCKET-CONTIGUOUS [NB × 2H] quantization of TW at scale
	// leanTailQB. It lets evalFromHalvesLean run v6's single FUSED SIMD screluDot
	// per half (one clamp²·w integer pass) instead of the scalar screluActivateI16
	// + nOut=1 strided gemvF32 — the 44%-of-node tail hotspot the profiler found.
	// For leanPairwise, TWi is [NB × H] (the pairwise output is H-wide, not 2H).
	TWi []int16 // NB * (2H | H)  (bucket-contiguous int16 tail weights)

	// leanPairwise is the LEAN tail with a PAIRWISE FT head (chessgo_lean_pairwise.rs):
	// CReLU each FT half-pair and multiply → H/2 per perspective, concat → H, one output
	// dot per bucket. The FT/accumulator/threat-push/int8FT/move-aware path is
	// BYTE-IDENTICAL to lean (same InputDim→H, same threat scheme) — only the tail
	// forward differs (evalFromHalvesLeanPairwise). TW is input-major [H × NB]; TWi is
	// bucket-contiguous [NB × H]. Mutually exclusive with lean.
	leanPairwise bool
}

// ThreatBlock is the threat feature-block size: (attacker 0..11, victim 0..11,
// victimSquare 0..63) = 12*12*64. MUST match examples/chessgo_enriched.rs.
const ThreatBlock = 12 * 12 * 64 // 9216

// maxEnrichedActive bounds active features per perspective (≤32 pieces + threat
// edges). Generous; a too-small stack buffer would silently truncate.
const maxEnrichedActive = 32 + 256

// NewEnrichedNet allocates a zeroed enriched net of the given tail dimensions.
func NewEnrichedNet(h, d2, d3, nb int) *EnrichedNet {
	if nb < 1 {
		nb = 1
	}
	in := InputDim + ThreatBlock
	return &EnrichedNet{
		H: h, D2: d2, D3: d3, NB: nb, InputDim: in,
		W0:      make([]float32, in*h),
		B0:      make([]float32, h),
		W0i:     make([]int16, in*h),
		B0i:     make([]int16, h),
		L1W:     make([]float32, nb*d2*h),
		L1B:     make([]float32, nb*d2),
		L2W:     make([]float32, nb*d3*d2),
		L2B:     make([]float32, nb*d3),
		OW:      make([]float32, nb*d3),
		OB:      make([]float32, nb),
		CpScale: 1,
	}
}

// SetMoveAware toggles the O(delta) move-aware incremental push (enriched_delta.go).
func (n *EnrichedNet) SetMoveAware(on bool) { n.moveAware = on }

// MoveAware reports whether the move-aware push is enabled.
func (n *EnrichedNet) MoveAware() bool { return n.moveAware }

// quantizeFT derives the int16 accumulator weights from the float FT at ftQA.
func (n *EnrichedNet) quantizeFT() {
	for i, v := range n.W0 {
		n.W0i[i] = int16(math.Round(float64(v * ftQA)))
	}
	for i, v := range n.B0 {
		n.B0i[i] = int16(math.Round(float64(v * ftQA)))
	}
}

// leanTailQB is the int16 scale for the lean tail weights (TW → TWi). 1024 keeps
// |TW·QB| well within int16 for bullet-scale tail weights; quantizeLeanTail
// returns a clamp count (>0 would mean saturation, which the closeness gate flags).
const leanTailQB = 1024

// quantizeLeanTail builds the bucket-contiguous int16 tail weights TWi from the
// input-major float TW, so evalFromHalvesLean uses the fused screluDot path. TW is
// input-major [2H × NB] (TW[i*NB+b]); TWi is bucket-contiguous [NB × 2H]
// (TWi[b*2H + i]). Returns the number of weights clamped (expected 0).
func (n *EnrichedNet) quantizeLeanTail() int {
	h2 := 2 * n.H
	n.TWi = make([]int16, n.NB*h2)
	clamped := 0
	for b := 0; b < n.NB; b++ {
		for i := 0; i < h2; i++ {
			q := math.Round(float64(n.TW[i*n.NB+b]) * leanTailQB)
			if q > 32767 {
				q = 32767
				clamped++
			} else if q < -32767 {
				q = -32767
				clamped++
			}
			n.TWi[b*h2+i] = int16(q)
		}
	}
	return clamped
}

// appendEnrichedFeatures appends the active feature indices of pos from persp's
// point of view: the base 768 (one per piece) followed by the threat features
// (one per attacker -> occupied-square edge). MUST emit byte-identical indices to
// the Rust map_features in examples/chessgo_enriched.rs:
//
//	a   = relColor(attacker)*6 + type(attacker)
//	v   = relColor(attacked)*6 + type(attacked)
//	tsq = orient(attackedSq)                       // persp==White ? sq : sq^56
//	idx = 768 + (a*12 + v)*64 + tsq
//
// relColor is 0 for persp's own pieces, 1 for the enemy's — exactly the base-768
// convention. The threat geometry is computed on the real board (orientation-
// independent); only the index encoding is reoriented per perspective.
func appendEnrichedFeatures(dst []uint16, pos *chess.Position, persp chess.Color) []uint16 {
	// base 768 (shared with the v6/MultiNet feature set).
	dst = AppendFeatures(dst, pos, persp)

	occ := pos.Occupied()
	flip := persp == chess.Black
	for pc := chess.WhitePawn; pc <= chess.BlackKing; pc++ {
		bb := pos.PieceBB(pc)
		if bb == 0 {
			continue
		}
		var aRel uint16
		if pc.Color() != persp {
			aRel = 1
		}
		a := aRel*6 + uint16(pc.Type())
		for bb != 0 {
			sq := bb.PopLSB()
			targets := chess.PseudoAttacks(pc, sq, occ) & occ
			for targets != 0 {
				tsq := targets.PopLSB()
				victim := pos.PieceOn(tsq)
				var vRel uint16
				if victim.Color() != persp {
					vRel = 1
				}
				v := vRel*6 + uint16(victim.Type())
				rtsq := uint16(tsq)
				if flip {
					rtsq ^= 56
				}
				dst = append(dst, uint16(InputDim)+(a*12+v)*64+rtsq)
			}
		}
	}
	return dst
}

// appendEnrichedFeaturesBoth is the hot-path twin of appendEnrichedFeatures: it
// enumerates the threat geometry ONCE (the magic-bitboard PseudoAttacks per piece
// is the per-node cost) and emits BOTH perspectives' index lists from it, instead
// of recomputing attacks per perspective. dstW gets White-persp indices (tsq as-is),
// dstB Black-persp (tsq^56); attacker/victim relColor is recomputed per side. The
// base 768 stays two AppendFeatures calls (cheap piece-placement). Output is
// byte-identical (per perspective) to appendEnrichedFeatures — the NNUE_ASSERT gate
// (which rebuilds via appendEnrichedFeatures) verifies this.
func appendEnrichedFeaturesBoth(dstW, dstB []uint16, pos *chess.Position) ([]uint16, []uint16) {
	dstW = AppendFeatures(dstW, pos, chess.White)
	dstB = AppendFeatures(dstB, pos, chess.Black)

	occ := pos.Occupied()
	for pc := chess.WhitePawn; pc <= chess.BlackKing; pc++ {
		bb := pos.PieceBB(pc)
		if bb == 0 {
			continue
		}
		var aRelW, aRelB uint16
		if pc.Color() != chess.White {
			aRelW = 1
		}
		if pc.Color() != chess.Black {
			aRelB = 1
		}
		aW := aRelW*6 + uint16(pc.Type())
		aB := aRelB*6 + uint16(pc.Type())
		for bb != 0 {
			sq := bb.PopLSB()
			targets := chess.PseudoAttacks(pc, sq, occ) & occ
			for targets != 0 {
				tsq := targets.PopLSB()
				victim := pos.PieceOn(tsq)
				var vRelW, vRelB uint16
				if victim.Color() != chess.White {
					vRelW = 1
				}
				if victim.Color() != chess.Black {
					vRelB = 1
				}
				vW := vRelW*6 + uint16(victim.Type())
				vB := vRelB*6 + uint16(victim.Type())
				t := uint16(tsq)
				dstW = append(dstW, uint16(InputDim)+(aW*12+vW)*64+t)
				dstB = append(dstB, uint16(InputDim)+(aB*12+vB)*64+(t^56))
			}
		}
	}
	return dstW, dstB
}

// ftAdd / ftSub apply feature f's FT column to the int16 accumulator, dispatching
// base columns (int16) and — when int8FT is on — threat columns (int8, widened) to
// the matching kernel. InputDim (the package const, 768) is the threat offset:
// f < 768 is a base piece-square feature, f >= 768 a threat feature.
func (n *EnrichedNet) ftAdd(acc []int16, f int) {
	h := n.H
	if n.int8FT && f >= InputDim {
		o := (f - InputDim) * h
		addColI8(acc, n.W0t8[o:o+h])
		return
	}
	addCol(acc, n.W0i[f*h:f*h+h])
}

func (n *EnrichedNet) ftSub(acc []int16, f int) {
	h := n.H
	if n.int8FT && f >= InputDim {
		o := (f - InputDim) * h
		subColI8(acc, n.W0t8[o:o+h])
		return
	}
	subCol(acc, n.W0i[f*h:f*h+h])
}

// buildAcc rebuilds the two absolute-color accumulator halves from scratch (the
// from-scratch reference path), dispatching base/threat columns via ftAdd.
func (n *EnrichedNet) buildAcc(accW, accB []int16, pos *chess.Position) {
	copy(accW, n.B0i)
	copy(accB, n.B0i)
	var buf [maxEnrichedActive]uint16
	for _, f := range appendEnrichedFeatures(buf[:0], pos, chess.White) {
		n.ftAdd(accW, int(f))
	}
	for _, f := range appendEnrichedFeatures(buf[:0], pos, chess.Black) {
		n.ftAdd(accB, int(f))
	}
}

// enrichedScratch holds the per-eval tail working buffers so the hot
// (incremental) path reuses them instead of allocating ~4 slices per node.
type enrichedScratch struct {
	hidden []float32 // H  (pairwise: [stm_pair | opp_pair]) — float path
	aq     []uint8   // H  (pairwise u8 activation) — int8 path
	l1     []float32 // D2
	l2     []float32 // D3
}

func (n *EnrichedNet) newScratch() enrichedScratch {
	return enrichedScratch{
		hidden: make([]float32, 2*n.H), // 2H covers lean (concat); pairwise uses first H
		aq:     make([]uint8, n.H),
		l1:     make([]float32, n.D2),
		l2:     make([]float32, n.D3),
	}
}

// Eval returns the enriched net's static eval of pos in centipawns, side-to-move
// relative (from-scratch). Allocates per call — used by the reference/gate path;
// the hot search path uses EnrichedStack with reused scratch.
func (n *EnrichedNet) Eval(pos *chess.Position) int {
	h := n.H
	accW := make([]int16, h)
	accB := make([]int16, h)
	n.buildAcc(accW, accB, pos)

	stm, opp := accW, accB
	if pos.SideToMove() == chess.Black {
		stm, opp = accB, accW
	}
	sc := n.newScratch()
	return n.evalFromHalves(stm, opp, materialBucket(pos, n.NB), &sc)
}

// pairwiseHalf applies CReLU then pairwise multiplication to one oriented int16
// accumulator half (length H), writing H/2 float activations to out. The int16
// value is the FT activation × ftQA, so CReLU is clamp(v,0,ftQA)/ftQA in [0,1].
func pairwiseHalf(out []float32, half []int16) {
	hh := len(half) / 2
	const inv = 1.0 / float32(ftQA)
	for i := 0; i < hh; i++ {
		a := half[i]
		if a < 0 {
			a = 0
		} else if a > ftQA {
			a = ftQA
		}
		b := half[i+hh]
		if b < 0 {
			b = 0
		} else if b > ftQA {
			b = ftQA
		}
		out[i] = (float32(a) * inv) * (float32(b) * inv)
	}
}

// evalFromHalves runs the pairwise FT activation and the multilayer tail (SCReLU
// hidden layers, linear output) for the given output bucket, into the caller's
// reused scratch (no allocation).
func (n *EnrichedNet) evalFromHalves(stm, opp []int16, bk int, sc *enrichedScratch) int {
	if n.leanPairwise {
		return n.evalFromHalvesLeanPairwise(stm, opp, bk, sc)
	}
	if n.lean {
		return n.evalFromHalvesLean(stm, opp, bk, sc)
	}
	if n.int8L1 {
		return n.evalFromHalvesInt8(stm, opp, bk, sc)
	}
	h := n.H
	half := h / 2
	hidden := sc.hidden // [stm_pair | opp_pair], each H/2 -> total H
	pairwiseHalf(hidden[:half], stm)
	pairwiseHalf(hidden[half:], opp)

	// Output-stationary GEMV tail (input-major weights, per-bucket sub-row). One
	// pass per layer, no per-output reduction — see gemvF32. Bias + SCReLU applied
	// after each GEMV.
	d2, d3, nb := n.D2, n.D3, n.NB

	// Tail layer 1: hidden[H] -> l1[D2], SCReLU.
	l1 := sc.l1
	gemvF32(l1, hidden, n.L1W, nb*d2, bk*d2)
	b1 := n.L1B[bk*d2 : bk*d2+d2]
	for o := range l1 {
		l1[o] = screluF(l1[o] + b1[o])
	}

	// Tail layer 2: l1[D2] -> l2[D3], SCReLU.
	l2 := sc.l2
	gemvF32(l2, l1, n.L2W, nb*d3, bk*d3)
	b2 := n.L2B[bk*d3 : bk*d3+d3]
	for o := range l2 {
		l2[o] = screluF(l2[o] + b2[o])
	}

	// Output layer: l2[D3] -> 1, linear.
	var y1 [1]float32
	gemvF32(y1[:], l2, n.OW, nb, bk)
	y := n.OB[bk] + y1[0]
	return int(math.Round(float64(y * n.CpScale)))
}

// evalFromHalvesLean is v6's FAST single-layer tail on the threat FT: SCReLU each
// oriented int16 accumulator half (→float, like v6), concat to 2H, then one output
// dot for the bucket (TW input-major [2H × NB], via gemvF32 stride NB / off bk) +
// bias. No pairwise, no multilayer — this is the cheap tail that banks the threat
// eval lever (the multilayer is a later refinement behind int8).
func (n *EnrichedNet) evalFromHalvesLean(stm, opp []int16, bk int, sc *enrichedScratch) int {
	_ = sc // fused integer path needs no scratch
	h := n.H
	base := bk * 2 * h
	// One fused SIMD pass per half: Σ clamp(acc_i,0,ftQA)²·TWi_i (the same math as
	// the old screluActivateI16 + strided gemvF32, but v6's hot kernel). The float
	// tail dot = out/(ftQA²·leanTailQB); cp = round((TB + dot)·CpScale).
	out := screluDot(stm, n.TWi[base:base+h], int32(ftQA))
	out += screluDot(opp, n.TWi[base+h:base+2*h], int32(ftQA))
	y := float64(n.TB[bk]) + float64(out)/(float64(ftQA)*float64(ftQA)*leanTailQB)
	return int(math.Round(y * float64(n.CpScale)))
}

// ImportBulletLeanNet reads a bullet float32 export of the LEAN single-layer threats
// arch (examples/chessgo_lean_threats.rs). Save order: l0w l0b l1w l1b (LE f32).
// The FT (l0w/l0b) is identical to the enriched FT (feature-major). The tail l1w is
// input-major [2H × NB] (l1w[i*NB + b]); l1b is [NB]. CpScale = 400.
func ImportBulletLeanNet(path string, h, nb int) (*EnrichedNet, error) {
	raw, err := os.ReadFile(path)
	if err != nil {
		return nil, fmt.Errorf("nnue: read bullet lean net: %w", err)
	}
	in := InputDim + ThreatBlock
	nL0w := in * h
	nL0b := h
	nL1w := 2 * h * nb
	nL1b := nb
	want := nL0w + nL0b + nL1w + nL1b
	if len(raw) < want*4 {
		return nil, fmt.Errorf(
			"nnue: bullet lean net is %d bytes (%d f32) < %d f32 needed for H=%d NB=%d",
			len(raw), len(raw)/4, want, h, nb)
	}
	f := make([]float32, want)
	for i := 0; i < want; i++ {
		f[i] = math.Float32frombits(binary.LittleEndian.Uint32(raw[i*4 : i*4+4]))
	}
	off := 0
	take := func(n int) []float32 { s := f[off : off+n]; off += n; return s }
	l0w := take(nL0w)
	l0b := take(nL0b)
	l1w := take(nL1w)
	l1b := take(nL1b)

	n := NewEnrichedNet(h, 0, 0, nb) // D2/D3 unused for lean
	copy(n.W0, l0w)
	copy(n.B0, l0b)
	n.lean = true
	n.TW = make([]float32, 2*h*nb)
	n.TB = make([]float32, nb)
	copy(n.TW, l1w) // input-major [2H × NB], straight
	copy(n.TB, l1b)
	n.CpScale = bulletSCALE // 400
	n.quantizeFT()
	n.quantizeLeanTail() // build the fused int16 tail (TWi)
	n.moveAware = true   // strictly better + bit-exact (see enriched_delta.go); default on
	return n, nil
}

// --- Default (process-wide) enriched net, atomically swappable ---

var defaultEnrichedNet atomic.Pointer[EnrichedNet]

// SetEnriched installs n as the process-wide default enriched net (nil clears it).
// When set, the searcher routes its static eval through n's from-scratch forward.
func SetEnriched(n *EnrichedNet) { defaultEnrichedNet.Store(n) }

// DefaultEnriched returns the installed default enriched net, or nil.
func DefaultEnriched() *EnrichedNet { return defaultEnrichedNet.Load() }

// ImportBulletEnrichedNet reads a bullet float32 export of the enriched arch
// (examples/chessgo_enriched.rs) and builds an EnrichedNet. bullet save order:
// l0w l0b l1w l1b l2w l2b l3w l3b (little-endian f32). Affine weights are stored
// INPUT-major [in x out]; output-bucketed layers interleave buckets in the output
// dimension (out = bucket*outPerBucket + o). The FT (l0w) copies straight
// (feature-major == bullet input-major); the tail layers are transposed to our
// output-major [out x in] and de-bucketed. CpScale = 400.
func ImportBulletEnrichedNet(path string, h, d2, d3, nb int) (*EnrichedNet, error) {
	raw, err := os.ReadFile(path)
	if err != nil {
		return nil, fmt.Errorf("nnue: read bullet enriched net: %w", err)
	}

	in := InputDim + ThreatBlock
	nL0w := in * h
	nL0b := h
	nL1w := h * (nb * d2)
	nL1b := nb * d2
	nL2w := d2 * (nb * d3)
	nL2b := nb * d3
	nL3w := d3 * nb
	nL3b := nb
	want := nL0w + nL0b + nL1w + nL1b + nL2w + nL2b + nL3w + nL3b

	if len(raw) < want*4 {
		return nil, fmt.Errorf(
			"nnue: bullet enriched net is %d bytes (%d f32) < %d f32 needed for H=%d D2=%d D3=%d NB=%d",
			len(raw), len(raw)/4, want, h, d2, d3, nb)
	}

	f := make([]float32, want)
	for i := 0; i < want; i++ {
		f[i] = math.Float32frombits(binary.LittleEndian.Uint32(raw[i*4 : i*4+4]))
	}
	off := 0
	take := func(n int) []float32 { s := f[off : off+n]; off += n; return s }
	l0w := take(nL0w)
	l0b := take(nL0b)
	l1w := take(nL1w)
	l1b := take(nL1b)
	l2w := take(nL2w)
	l2b := take(nL2b)
	l3w := take(nL3w)
	l3b := take(nL3b)

	n := NewEnrichedNet(h, d2, d3, nb)
	copy(n.W0, l0w) // FT: bullet input-major == feature-major
	copy(n.B0, l0b)

	// Tail weights: keep bullet's NATIVE INPUT-MAJOR layout (no transpose) — that's
	// exactly what the output-stationary gemvF32 tail wants. For input i and output
	// bucket b, the D2/D3/1 weights are the contiguous sub-row at [i*stride + b*span].
	//   L1W [H × NB*D2]   l1w[i*(NB*D2) + b*D2 + o]   (stride NB*D2, off b*D2)
	//   L2W [D2 × NB*D3]  l2w[i*(NB*D3) + b*D3 + o]   (stride NB*D3, off b*D3)
	//   OW  [D3 × NB]     l3w[i*NB + b]               (stride NB,    off b)
	copy(n.L1W, l1w)
	copy(n.L1B, l1b)
	copy(n.L2W, l2w)
	copy(n.L2B, l2b)
	copy(n.OW, l3w)
	copy(n.OB, l3b)

	n.CpScale = bulletSCALE // 400
	n.quantizeFT()
	return n, nil
}
