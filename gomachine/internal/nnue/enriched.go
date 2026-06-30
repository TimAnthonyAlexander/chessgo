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

// quantizeFT derives the int16 accumulator weights from the float FT at ftQA.
func (n *EnrichedNet) quantizeFT() {
	for i, v := range n.W0 {
		n.W0i[i] = int16(math.Round(float64(v * ftQA)))
	}
	for i, v := range n.B0 {
		n.B0i[i] = int16(math.Round(float64(v * ftQA)))
	}
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

// buildAcc rebuilds the two absolute-color accumulator halves from scratch via the
// int16 SIMD addCol kernel (the from-scratch reference path).
func (n *EnrichedNet) buildAcc(accW, accB []int16, pos *chess.Position) {
	h := n.H
	copy(accW, n.B0i)
	copy(accB, n.B0i)
	var buf [maxEnrichedActive]uint16
	for _, f := range appendEnrichedFeatures(buf[:0], pos, chess.White) {
		addCol(accW, n.W0i[int(f)*h:int(f)*h+h])
	}
	for _, f := range appendEnrichedFeatures(buf[:0], pos, chess.Black) {
		addCol(accB, n.W0i[int(f)*h:int(f)*h+h])
	}
}

// enrichedScratch holds the per-eval tail working buffers so the hot
// (incremental) path reuses them instead of allocating ~4 slices per node.
type enrichedScratch struct {
	hidden []float32 // H  (pairwise: [stm_pair | opp_pair])
	l1     []float32 // D2
	l2     []float32 // D3
}

func (n *EnrichedNet) newScratch() enrichedScratch {
	return enrichedScratch{
		hidden: make([]float32, n.H),
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
	h := n.H
	half := h / 2
	hidden := sc.hidden // [stm_pair | opp_pair], each H/2 -> total H
	pairwiseHalf(hidden[:half], stm)
	pairwiseHalf(hidden[half:], opp)

	// Tail layer 1: hidden[H] -> l1[D2], SCReLU.
	l1 := sc.l1
	w1 := n.L1W[bk*n.D2*h : (bk+1)*n.D2*h]
	b1 := n.L1B[bk*n.D2 : (bk+1)*n.D2]
	for o := 0; o < n.D2; o++ {
		l1[o] = screluF(b1[o] + dotF32(hidden, w1[o*h:o*h+h]))
	}

	// Tail layer 2: l1[D2] -> l2[D3], SCReLU.
	l2 := sc.l2
	w2 := n.L2W[bk*n.D3*n.D2 : (bk+1)*n.D3*n.D2]
	b2 := n.L2B[bk*n.D3 : (bk+1)*n.D3]
	for o := 0; o < n.D3; o++ {
		l2[o] = screluF(b2[o] + dotF32(l1, w2[o*n.D2:o*n.D2+n.D2]))
	}

	// Output layer: l2[D3] -> 1, linear.
	ow := n.OW[bk*n.D3 : (bk+1)*n.D3]
	y := n.OB[bk] + dotF32(l2, ow)
	return int(math.Round(float64(y * n.CpScale)))
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

	// Tail layer 1: bullet l1w [in=H x out=NB*D2] -> L1W [bucket][D2 x H].
	for i := 0; i < h; i++ {
		for b := 0; b < nb; b++ {
			for o := 0; o < d2; o++ {
				n.L1W[(b*d2+o)*h+i] = l1w[i*(nb*d2)+b*d2+o]
			}
		}
	}
	copy(n.L1B, l1b) // l1b[b*D2+o] == L1B[b*D2+o]

	// Tail layer 2: bullet l2w [in=D2 x out=NB*D3] -> L2W [bucket][D3 x D2].
	for i := 0; i < d2; i++ {
		for b := 0; b < nb; b++ {
			for o := 0; o < d3; o++ {
				n.L2W[(b*d3+o)*d2+i] = l2w[i*(nb*d3)+b*d3+o]
			}
		}
	}
	copy(n.L2B, l2b)

	// Output: bullet l3w [in=D3 x out=NB] -> OW [bucket][D3].
	for i := 0; i < d3; i++ {
		for b := 0; b < nb; b++ {
			n.OW[b*d3+i] = l3w[i*nb+b]
		}
	}
	copy(n.OB, l3b)

	n.CpScale = bulletSCALE // 400
	n.quantizeFT()
	return n, nil
}
