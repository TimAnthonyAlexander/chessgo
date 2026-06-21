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
	W0      []float32 // InputDim*L1, feature-major
	B0      []float32 // L1
	W1      []float32 // ConcatDim
	B1      float32
	CpScale float32 // raw output → centipawns

	// Integer view (Phase B). QA scales the feature transformer (W0i/B0i), QB the
	// output weights (W1i); B1i is the raw output bias (scaled by QA*QB); Scale is
	// bullet's eval_scale. The int forward computes the exact rational eval:
	//   A[i]=B0i[i]+ΣW0i[f][i]; c=clamp(A,0,QA); OUT=Σc²·W1i; eval=round(Scale·(B1i·QA+OUT)/(QA²·QB)).
	W0i       []int16 // InputDim*L1, feature-major
	B0i       []int16 // L1
	W1i       []int16 // ConcatDim
	B1i       int32
	QA        int32
	QB        int32
	Scale     int32
	quantized bool // true when the ints came straight from bullet (G2 bit-exact)
}

// NewNet allocates a zeroed net of the fixed architecture (weights left at 0;
// the trainer fills them). CpScale defaults to 1; the integer view defaults to
// bullet's scales so a freshly-quantized net is self-consistent.
func NewNet() *Net {
	return &Net{
		W0:      make([]float32, InputDim*L1),
		B0:      make([]float32, L1),
		W1:      make([]float32, ConcatDim),
		CpScale: 1,
		W0i:     make([]int16, InputDim*L1),
		B0i:     make([]int16, L1),
		W1i:     make([]int16, ConcatDim),
		QA:      bulletQA,
		QB:      bulletQB,
		Scale:   bulletSCALE,
	}
}

// RandomNet returns a small-random-weight net for tests (no training needed).
func RandomNet(seed int64) *Net {
	rng := rand.New(rand.NewSource(seed))
	n := NewNet()
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
	var acc [ConcatDim]float32
	copy(acc[:L1], n.B0)  // stm half
	copy(acc[L1:], n.B0)  // opp half

	stm := pos.SideToMove()
	var buf [maxActive]uint16

	for _, f := range AppendFeatures(buf[:0], pos, stm) {
		col := n.W0[int(f)*L1 : int(f)*L1+L1]
		for j := 0; j < L1; j++ {
			acc[j] += col[j]
		}
	}
	for _, f := range AppendFeatures(buf[:0], pos, stm.Opposite()) {
		col := n.W0[int(f)*L1 : int(f)*L1+L1]
		for j := 0; j < L1; j++ {
			acc[L1+j] += col[j]
		}
	}

	y := n.B1
	for i := 0; i < ConcatDim; i++ {
		h := acc[i] // SCReLU: clamp(x, 0, 1) then square
		if h < 0 {
			h = 0
		} else if h > 1 {
			h = 1
		}
		y += h * h * n.W1[i]
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
		return n.writeGNN2(w)
	}
	hdr := fileHeader{Magic: magic, Version: 1, Arch: 0, InDim: InputDim, L1: L1}
	if err := binary.Write(w, binary.LittleEndian, hdr); err != nil {
		return err
	}
	for _, blob := range [][]float32{n.W0, n.B0, n.W1} {
		if err := binary.Write(w, binary.LittleEndian, blob); err != nil {
			return err
		}
	}
	if err := binary.Write(w, binary.LittleEndian, n.B1); err != nil {
		return err
	}
	return binary.Write(w, binary.LittleEndian, n.CpScale)
}

// writeGNN2 serializes the integer view (bit-exact bullet weights).
func (n *Net) writeGNN2(w io.Writer) error {
	hdr := fileHeader{Magic: magic, Version: 2, Arch: 1, InDim: InputDim, L1: L1}
	if err := binary.Write(w, binary.LittleEndian, hdr); err != nil {
		return err
	}
	if err := binary.Write(w, binary.LittleEndian, []int32{n.QA, n.QB, n.Scale, n.B1i}); err != nil {
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
	if hdr.InDim != InputDim || hdr.L1 != L1 {
		return nil, fmt.Errorf("nnue: arch mismatch in=%d l1=%d (want %d/%d)", hdr.InDim, hdr.L1, InputDim, L1)
	}
	switch hdr.Version {
	case 1:
		return readGNN1(r)
	case 2:
		return readGNN2(r)
	default:
		return nil, fmt.Errorf("nnue: unsupported version %d", hdr.Version)
	}
}

// readGNN1 reads the float format, then quantises so the int path runs too.
func readGNN1(r io.Reader) (*Net, error) {
	n := NewNet()
	for _, blob := range [][]float32{n.W0, n.B0, n.W1} {
		if err := binary.Read(r, binary.LittleEndian, blob); err != nil {
			return nil, err
		}
	}
	if err := binary.Read(r, binary.LittleEndian, &n.B1); err != nil {
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
func readGNN2(r io.Reader) (*Net, error) {
	n := NewNet()
	var scales [4]int32 // QA, QB, Scale, B1i
	if err := binary.Read(r, binary.LittleEndian, &scales); err != nil {
		return nil, err
	}
	n.QA, n.QB, n.Scale, n.B1i = scales[0], scales[1], scales[2], scales[3]
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
