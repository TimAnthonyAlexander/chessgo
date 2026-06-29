package nnue

import (
	"bytes"
	"encoding/binary"
	"errors"
	"fmt"
	"io"
	"math"
	"math/rand"
	"os"
	"sync/atomic"

	assets "github.com/timanthonyalexander/gomachine"
	"github.com/timanthonyalexander/gomachine/internal/chess"
)

// Net is a (768→256)×2→1 perspective network. W0 is the feature transformer
// stored feature-major (W0[feat*L1 : feat*L1+L1] is one feature's column, so an
// accumulator add is a contiguous slice add — the shape the incremental update
// wants). The downstream layer W1/B1 maps the concatenated [stm, opp] accumulator
// (after SCReLU — clamp to [0,1] then square) to one scalar, which CpScale
// converts to centipawns.
//
// Phase B: the net carries BOTH a float view (W0..CpScale — the reference /
// from-scratch path, kept for comparison) AND an integer view (W0i..B1i, the
// fast incremental path). On load they are kept consistent: a GNN2 (integer) net
// loads its ints verbatim (bit-exact to bullet) and dequantizes them into the
// floats; a GNN1 (float) net loads its floats and quantizes them into the ints.
// quantized records which side is authoritative (true → ints are bullet-exact).
type Net struct {
	// HL is this net's hidden-layer width (the per-perspective accumulator size).
	// It is NOT a compile-time constant: nets of different widths (e.g. a 256-wide
	// and a 512-wide net) can be loaded into the same process at once (the
	// net-vs-net SPRT does exactly this). All per-net inference derives its loop
	// bounds and slice sizes from HL, never from the package L1 default.
	HL int

	// NB is the number of output buckets (phase heads selected by piece count).
	// NB==1 is the legacy single-head net (GNN1/GNN2); NB>1 is the bucketed net
	// (GNN3). The feature transformer (W0/B0) is shared across buckets; only the
	// output layer (W1/B1) is per-bucket, so inference selects one bucket's weights
	// and costs the same as a single head (no NPS tax).
	NB int

	W0      []float32 // InputDim*HL, feature-major
	B0      []float32 // HL
	W1      []float32 // NB*2*HL, bucket-contiguous (bucket b at [b*2*HL : (b+1)*2*HL])
	B1      []float32 // NB (one output bias per bucket)
	CpScale float32   // raw output → centipawns

	// Integer view (Phase B). QA scales the feature transformer (W0i/B0i), QB the
	// output weights (W1i); B1i is the raw output bias (scaled by QA*QB); Scale is
	// bullet's eval_scale. The int forward computes the exact rational eval:
	//   A[i]=B0i[i]+ΣW0i[f][i]; c=clamp(A,0,QA); OUT=Σc²·W1i; eval=round(Scale·(B1i·QA+OUT)/(QA²·QB)).
	W0i       []int16 // InputDim*L1, feature-major
	B0i       []int16 // L1
	W1i       []int16 // NB*2*HL, bucket-contiguous (matches W1)
	B1i       []int32 // NB (one output bias per bucket, scaled by QA*QB)
	QA        int32
	QB        int32
	Scale     int32
	quantized bool // true when the ints came straight from bullet (G2 bit-exact)
}

// NewNet allocates a zeroed net of the DEFAULT width (L1=256), for back-compat
// with existing tests and the legacy Go trainer. New code that may see other
// widths should use NewNetSize.
func NewNet() *Net { return NewNetSize(L1) }

// NewNetSize allocates a zeroed single-bucket net with hidden-layer width hl.
func NewNetSize(hl int) *Net { return NewNetSizeBuckets(hl, 1) }

// NewNetSizeBuckets allocates a zeroed net with hidden-layer width hl and nb
// output buckets (weights left at 0; the trainer/importer fills them). CpScale
// defaults to 1; the integer view defaults to bullet's scales so a freshly-
// quantized net is self-consistent.
func NewNetSizeBuckets(hl, nb int) *Net {
	if nb < 1 {
		nb = 1
	}
	return &Net{
		HL:      hl,
		NB:      nb,
		W0:      make([]float32, InputDim*hl),
		B0:      make([]float32, hl),
		W1:      make([]float32, nb*2*hl),
		B1:      make([]float32, nb),
		CpScale: 1,
		W0i:     make([]int16, InputDim*hl),
		B0i:     make([]int16, hl),
		W1i:     make([]int16, nb*2*hl),
		B1i:     make([]int32, nb),
		QA:      bulletQA,
		QB:      bulletQB,
		Scale:   bulletSCALE,
	}
}

// outputBucket selects pos's piece-count output bucket, matching bullet's
// MaterialCount<NB>: divisor = ceil(32/NB), bucket = (popcount(occ)-2)/divisor,
// clamped to [0, NB-1]. NB<=1 always returns bucket 0.
func (n *Net) outputBucket(pos *chess.Position) int {
	if n.NB <= 1 {
		return 0
	}
	divisor := (32 + n.NB - 1) / n.NB // ceil(32/NB); =4 for NB=8
	b := (pos.Occupied().Count() - 2) / divisor
	if b < 0 {
		b = 0
	} else if b >= n.NB {
		b = n.NB - 1
	}
	return b
}

// RandomNet returns a small-random-weight net of the default width (256).
func RandomNet(seed int64) *Net { return RandomNetSize(seed, L1) }

// RandomNetSize returns a small-random-weight net of width hl for tests.
func RandomNetSize(seed int64, hl int) *Net {
	rng := rand.New(rand.NewSource(seed))
	n := NewNetSize(hl)
	for i := range n.W0 {
		n.W0[i] = float32(rng.NormFloat64()) * 0.1
	}
	for i := range n.B0 {
		n.B0[i] = float32(rng.NormFloat64()) * 0.1
	}
	for i := range n.W1 {
		n.W1[i] = float32(rng.NormFloat64()) * 0.1
	}
	n.CpScale = 100
	n.quantizeFromFloat() // populate the integer view for the int forward path
	return n
}

// Eval returns the network's static evaluation of pos in centipawns, from the
// side-to-move's perspective (negamax convention). This is the slow Phase-1
// path: it rebuilds both accumulators from scratch every call.
func (n *Net) Eval(pos *chess.Position) int {
	hl := n.HL
	acc := make([]float32, 2*hl)
	copy(acc[:hl], n.B0)  // stm half
	copy(acc[hl:], n.B0)  // opp half

	stm := pos.SideToMove()
	var buf [maxActive]uint16

	for _, f := range AppendFeatures(buf[:0], pos, stm) {
		col := n.W0[int(f)*hl : int(f)*hl+hl]
		for j := 0; j < hl; j++ {
			acc[j] += col[j]
		}
	}
	for _, f := range AppendFeatures(buf[:0], pos, stm.Opposite()) {
		col := n.W0[int(f)*hl : int(f)*hl+hl]
		for j := 0; j < hl; j++ {
			acc[hl+j] += col[j]
		}
	}

	bucket := n.outputBucket(pos)
	w1 := n.W1[bucket*2*hl : bucket*2*hl+2*hl]
	y := n.B1[bucket]
	for i := 0; i < 2*hl; i++ {
		h := acc[i] // SCReLU: clamp(x, 0, 1) then square
		if h < 0 {
			h = 0
		} else if h > 1 {
			h = 1
		}
		y += h * h * w1[i]
	}
	return int(math.Round(float64(y * n.CpScale)))
}

// --- Serialization ---
//
// GNN1 (Version 1, Arch 0): little-endian float32 — the original Phase-1 format.
// GNN2 (Version 2, Arch 1): the integer (Phase B) format — QA/QB/Scale then the
// int16 W0i/B0i/W1i and int32 B1i. GNN2 stores bullet's quantised weights
// verbatim (bit-exact), so it is the canonical shipping format; GNN1 stays
// readable for older nets (it is quantised on load so the int path still runs).

var magic = [4]byte{'G', 'N', 'N', '1'}

type fileHeader struct {
	Magic   [4]byte
	Version uint32
	Arch    uint32 // 0 = float32 perspective net (GNN1); 1 = int (GNN2)
	InDim   uint32
	L1      uint32
}

// Write serializes the net to w. A quantized net is written as GNN2 (integer),
// preserving bit-exact bullet weights; a float-only net is written as GNN1.
func (n *Net) Write(w io.Writer) error {
	if n.quantized {
		if n.NB > 1 {
			return n.writeGNN3(w)
		}
		return n.writeGNN2(w)
	}
	// GNN1 float format is single-bucket only (the legacy Go-trainer / test path).
	hdr := fileHeader{Magic: magic, Version: 1, Arch: 0, InDim: InputDim, L1: uint32(n.HL)}
	if err := binary.Write(w, binary.LittleEndian, hdr); err != nil {
		return err
	}
	for _, blob := range [][]float32{n.W0, n.B0, n.W1} {
		if err := binary.Write(w, binary.LittleEndian, blob); err != nil {
			return err
		}
	}
	if err := binary.Write(w, binary.LittleEndian, n.B1[0]); err != nil {
		return err
	}
	return binary.Write(w, binary.LittleEndian, n.CpScale)
}

// writeGNN2 serializes the integer view (bit-exact bullet weights).
func (n *Net) writeGNN2(w io.Writer) error {
	hdr := fileHeader{Magic: magic, Version: 2, Arch: 1, InDim: InputDim, L1: uint32(n.HL)}
	if err := binary.Write(w, binary.LittleEndian, hdr); err != nil {
		return err
	}
	if err := binary.Write(w, binary.LittleEndian, []int32{n.QA, n.QB, n.Scale, n.B1i[0]}); err != nil {
		return err
	}
	for _, blob := range [][]int16{n.W0i, n.B0i, n.W1i} {
		if err := binary.Write(w, binary.LittleEndian, blob); err != nil {
			return err
		}
	}
	return nil
}

// writeGNN3 serializes a bucketed integer net (NB>1). Layout after the fixed
// header: [NB, QA, QB, Scale] int32, then NB int32 output biases (B1i), then the
// int16 blobs W0i (InputDim*HL), B0i (HL), W1i (NB*2*HL bucket-contiguous).
func (n *Net) writeGNN3(w io.Writer) error {
	hdr := fileHeader{Magic: magic, Version: 3, Arch: 1, InDim: InputDim, L1: uint32(n.HL)}
	if err := binary.Write(w, binary.LittleEndian, hdr); err != nil {
		return err
	}
	if err := binary.Write(w, binary.LittleEndian, []int32{int32(n.NB), n.QA, n.QB, n.Scale}); err != nil {
		return err
	}
	if err := binary.Write(w, binary.LittleEndian, n.B1i); err != nil { // NB int32
		return err
	}
	for _, blob := range [][]int16{n.W0i, n.B0i, n.W1i} {
		if err := binary.Write(w, binary.LittleEndian, blob); err != nil {
			return err
		}
	}
	return nil
}

// Save writes the net to a file path.
func (n *Net) Save(path string) error {
	f, err := os.Create(path)
	if err != nil {
		return err
	}
	if err := n.Write(f); err != nil {
		f.Close()
		return err
	}
	return f.Close()
}

// ReadNet deserializes a net from r, validating magic/version/arch. GNN1 nets
// are quantised on load; GNN2 nets are dequantised on load — either way both the
// float and integer views are populated and consistent.
func ReadNet(r io.Reader) (*Net, error) {
	var hdr fileHeader
	if err := binary.Read(r, binary.LittleEndian, &hdr); err != nil {
		return nil, err
	}
	if hdr.Magic != magic {
		return nil, errors.New("nnue: bad magic (not a GNN net file)")
	}
	if hdr.InDim != InputDim {
		return nil, fmt.Errorf("nnue: input-dim mismatch in=%d (want %d)", hdr.InDim, InputDim)
	}
	hl := int(hdr.L1)
	if hl <= 0 || hl > 8192 { // sanity: any real hidden width is well within this
		return nil, fmt.Errorf("nnue: implausible hidden width L1=%d", hdr.L1)
	}
	switch hdr.Version {
	case 1:
		return readGNN1(r, hl)
	case 2:
		return readGNN2(r, hl)
	case 3:
		return readGNN3(r, hl)
	default:
		return nil, fmt.Errorf("nnue: unsupported version %d", hdr.Version)
	}
}

// readGNN1 reads the float format, then quantises so the int path runs too.
func readGNN1(r io.Reader, hl int) (*Net, error) {
	n := NewNetSize(hl)
	for _, blob := range [][]float32{n.W0, n.B0, n.W1} {
		if err := binary.Read(r, binary.LittleEndian, blob); err != nil {
			return nil, err
		}
	}
	if err := binary.Read(r, binary.LittleEndian, &n.B1[0]); err != nil {
		return nil, err
	}
	if err := binary.Read(r, binary.LittleEndian, &n.CpScale); err != nil {
		return nil, err
	}
	n.quantizeFromFloat() // populate the int view (lossy for arbitrary floats)
	n.quantized = false    // floats are authoritative here, not bullet-exact ints
	return n, nil
}

// readGNN2 reads the integer format (bullet-exact), then dequantises to floats.
func readGNN2(r io.Reader, hl int) (*Net, error) {
	n := NewNetSize(hl)
	var scales [4]int32 // QA, QB, Scale, B1i
	if err := binary.Read(r, binary.LittleEndian, &scales); err != nil {
		return nil, err
	}
	n.QA, n.QB, n.Scale, n.B1i[0] = scales[0], scales[1], scales[2], scales[3]
	if n.QA == 0 || n.QB == 0 {
		return nil, fmt.Errorf("nnue: GNN2 bad scales QA=%d QB=%d", n.QA, n.QB)
	}
	for _, blob := range [][]int16{n.W0i, n.B0i, n.W1i} {
		if err := binary.Read(r, binary.LittleEndian, blob); err != nil {
			return nil, err
		}
	}
	n.dequantizeToFloat() // populate the float view (reference / comparison path)
	n.quantized = true
	return n, nil
}

// readGNN3 reads the bucketed integer format (see writeGNN3), then dequantises to
// floats for the reference view.
func readGNN3(r io.Reader, hl int) (*Net, error) {
	var head [4]int32 // NB, QA, QB, Scale
	if err := binary.Read(r, binary.LittleEndian, &head); err != nil {
		return nil, err
	}
	nb := int(head[0])
	if nb <= 0 || nb > 64 {
		return nil, fmt.Errorf("nnue: GNN3 implausible bucket count NB=%d", nb)
	}
	n := NewNetSizeBuckets(hl, nb)
	n.QA, n.QB, n.Scale = head[1], head[2], head[3]
	if n.QA == 0 || n.QB == 0 {
		return nil, fmt.Errorf("nnue: GNN3 bad scales QA=%d QB=%d", n.QA, n.QB)
	}
	if err := binary.Read(r, binary.LittleEndian, n.B1i); err != nil { // NB int32
		return nil, err
	}
	for _, blob := range [][]int16{n.W0i, n.B0i, n.W1i} {
		if err := binary.Read(r, binary.LittleEndian, blob); err != nil {
			return nil, err
		}
	}
	n.dequantizeToFloat()
	n.quantized = true
	return n, nil
}

// LoadNet reads a net from a file path.
func LoadNet(path string) (*Net, error) {
	f, err := os.Open(path)
	if err != nil {
		return nil, err
	}
	defer f.Close()
	return ReadNet(f)
}

// --- Default (process-wide) net, atomically swappable for SMP safety ---

var defaultNet atomic.Pointer[Net]

// SetNet installs n as the process-wide default net (nil clears it).
func SetNet(n *Net) { defaultNet.Store(n) }

// Default returns the installed default net, or nil if none is loaded.
func Default() *Net { return defaultNet.Load() }

// Eval evaluates pos with the default net. ok is false when no net is loaded,
// in which case callers fall back to the hand-crafted eval.
func Eval(pos *chess.Position) (cp int, ok bool) {
	n := defaultNet.Load()
	if n == nil {
		return 0, false
	}
	return n.Eval(pos), true
}

// defaultPath is where the engine auto-discovers a net at startup, cwd-relative
// like data/book.bin and data/syzygy. NNUE_PATH overrides it.
const defaultPath = "data/nnue/net.nnue"

func init() {
	// An explicit file (NNUE_PATH, else the cwd-relative default) wins, so a
	// freshly trained net can be dropped in without a rebuild.
	path := os.Getenv("NNUE_PATH")
	if path == "" {
		path = defaultPath
	}
	if n, err := LoadNet(path); err == nil {
		defaultNet.Store(n)
		return
	}
	// No file on disk — fall back to the net embedded in the binary, so a bare
	// `go install` build is full strength from any working directory. Still
	// inert (HCE fallback, like an unattached tablebase) if no net is embedded.
	if len(assets.NNUENet) > 0 {
		if n, err := ReadNet(bytes.NewReader(assets.NNUENet)); err == nil {
			defaultNet.Store(n)
		}
	}
}
