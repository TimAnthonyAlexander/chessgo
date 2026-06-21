package nnue

import (
	"encoding/binary"
	"errors"
	"fmt"
	"io"
	"math"
	"math/rand"
	"os"
	"sync/atomic"

	"github.com/timanthonyalexander/gomachine/internal/chess"
)

// Net is a float32 (768→256)×2→1 perspective network. W0 is the feature
// transformer stored feature-major (W0[feat*L1 : feat*L1+L1] is one feature's
// column, so an accumulator add is a contiguous slice add — the shape the
// Phase-4 incremental update wants). The downstream layer W1/B1 maps the
// concatenated [stm, opp] accumulator (after ClippedReLU) to one scalar, which
// CpScale converts to centipawns.
type Net struct {
	W0      []float32 // InputDim*L1, feature-major
	B0      []float32 // L1
	W1      []float32 // ConcatDim
	B1      float32
	CpScale float32 // raw output → centipawns
}

// NewNet allocates a zeroed net of the fixed architecture (weights left at 0;
// the trainer fills them). CpScale defaults to 1.
func NewNet() *Net {
	return &Net{
		W0:      make([]float32, InputDim*L1),
		B0:      make([]float32, L1),
		W1:      make([]float32, ConcatDim),
		CpScale: 1,
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
		h := acc[i] // ClippedReLU: clamp(x, 0, 1)
		if h < 0 {
			h = 0
		} else if h > 1 {
			h = 1
		}
		y += h * n.W1[i]
	}
	return int(math.Round(float64(y * n.CpScale)))
}

// --- Serialization (net file format v1, little-endian float32) ---

var magic = [4]byte{'G', 'N', 'N', '1'}

type fileHeader struct {
	Magic   [4]byte
	Version uint32
	Arch    uint32 // 0 = 768×256×1 float32 perspective net
	InDim   uint32
	L1      uint32
}

// Write serializes the net to w (see docs/NNUE/PLAN.md §1.4).
func (n *Net) Write(w io.Writer) error {
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

// ReadNet deserializes a net from r, validating magic/version/arch.
func ReadNet(r io.Reader) (*Net, error) {
	var hdr fileHeader
	if err := binary.Read(r, binary.LittleEndian, &hdr); err != nil {
		return nil, err
	}
	if hdr.Magic != magic {
		return nil, errors.New("nnue: bad magic (not a GNN1 net file)")
	}
	if hdr.Version != 1 {
		return nil, fmt.Errorf("nnue: unsupported version %d", hdr.Version)
	}
	if hdr.InDim != InputDim || hdr.L1 != L1 {
		return nil, fmt.Errorf("nnue: arch mismatch in=%d l1=%d (want %d/%d)", hdr.InDim, hdr.L1, InputDim, L1)
	}
	n := NewNet()
	for _, blob := range [][]float32{n.W0, n.B0, n.W1} {
		if err := binary.Read(r, binary.LittleEndian, blob); err != nil {
			return nil, err
		}
	}
	if err := binary.Read(r, binary.LittleEndian, &n.B1); err != nil {
		return nil, err
	}
	return n, binary.Read(r, binary.LittleEndian, &n.CpScale)
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
	path := os.Getenv("NNUE_PATH")
	if path == "" {
		path = defaultPath
	}
	// Inert if absent/unreadable (Phase 1: no net exists yet) — the nnue flag
	// then falls back to HCE, exactly like an unattached tablebase.
	if n, err := LoadNet(path); err == nil {
		defaultNet.Store(n)
	}
}
