package nnue

import (
	"bytes"
	"encoding/binary"
	"os"
	"path/filepath"
	"testing"

	"github.com/timanthonyalexander/gomachine/internal/chess"
)

// TestWidth512GNN2RoundTrip builds a 512-wide net, round-trips it through GNN2
// save/load, and asserts identical eval — proving load allocates per-header width
// and the integer path is width-agnostic.
func TestWidth512GNN2RoundTrip(t *testing.T) {
	n := RandomNetSize(123, 512)
	if n.HL != 512 {
		t.Fatalf("HL = %d, want 512", n.HL)
	}
	var buf bytes.Buffer
	if err := n.Write(&buf); err != nil {
		t.Fatalf("Write: %v", err)
	}
	m, err := ReadNet(&buf)
	if err != nil {
		t.Fatalf("ReadNet: %v", err)
	}
	if m.HL != 512 {
		t.Fatalf("loaded HL = %d, want 512", m.HL)
	}
	for _, fen := range moveTypeFENs {
		pos := mustFEN(t, fen)
		if a, b := n.Eval(pos), m.Eval(pos); a != b {
			t.Errorf("512 round-trip eval mismatch %q: %d vs %d", fen, a, b)
		}
	}
}

// TestWidth512IncrementalMatchesScratch is the load-bearing accumulator gate at
// width 512: for every legal move, the incrementally-pushed accumulator must be
// bit-identical to a from-scratch rebuild of the resulting position.
func TestWidth512IncrementalMatchesScratch(t *testing.T) {
	net := RandomNetSize(321, 512)
	for _, fen := range moveTypeFENs {
		pos := mustFEN(t, fen)
		var ml chess.MoveList
		pos.GenerateLegal(&ml)
		for i := 0; i < ml.Len(); i++ {
			m := ml.Get(i)
			st := net.NewStack(4)
			st.Reset(pos)
			st.Push(pos, m)
			var u chess.Undo
			pos.DoMove(m, &u)
			fresh := net.newAccumulator()
			net.build(&fresh, pos)
			top := &st.data[st.sp]
			for j := 0; j < net.HL; j++ {
				if top.w[j] != fresh.w[j] || top.b[j] != fresh.b[j] {
					pos.UndoMove(m, &u)
					t.Fatalf("512 delta desync %q move %s j=%d: w(inc=%d fresh=%d) b(inc=%d fresh=%d)",
						fen, m.String(), j, top.w[j], fresh.w[j], top.b[j], fresh.b[j])
				}
			}
			pos.UndoMove(m, &u)
		}
	}
}

// TestWidth512NullMoveAccumulator confirms PushNull preserves the accumulator
// contents at width 512 (a null move changes no placement).
func TestWidth512NullMove(t *testing.T) {
	net := RandomNetSize(7, 512)
	pos := mustFEN(t, chess.StartFEN)
	st := net.NewStack(4)
	st.Reset(pos)
	before := append([]int16(nil), st.data[st.sp].w...)
	st.PushNull()
	got := st.data[st.sp].w
	for j := range before {
		if got[j] != before[j] {
			t.Fatalf("PushNull changed accumulator at j=%d: %d vs %d", j, got[j], before[j])
		}
	}
}

// TestBulletWidthInference checks the file-size→HL inference in ImportBulletNet
// for both 256 and 512, including bullet's 64-byte padding, and that a garbage
// size is rejected.
func TestBulletWidthInference(t *testing.T) {
	for _, hl := range []int{256, 512} {
		path := writeSyntheticBulletNet(t, hl)
		n, err := ImportBulletNet(path)
		if err != nil {
			t.Fatalf("hl=%d: ImportBulletNet: %v", hl, err)
		}
		if n.HL != hl {
			t.Fatalf("inferred HL=%d, want %d", n.HL, hl)
		}
	}
	// A size that matches no 771*HL+1 (off by a big chunk) must error.
	bad := filepath.Join(t.TempDir(), "bad.bin")
	if err := os.WriteFile(bad, make([]byte, 12345), 0o644); err != nil {
		t.Fatal(err)
	}
	if _, err := ImportBulletNet(bad); err == nil {
		t.Fatal("expected error for mismatched bullet net size, got nil")
	}
}

// writeSyntheticBulletNet writes a (771*hl+1)-int16 stream padded to a multiple
// of 64 bytes (as bullet does), with arbitrary small weights.
func writeSyntheticBulletNet(t *testing.T, hl int) string {
	t.Helper()
	count := 771*hl + 1
	b := make([]byte, count*2)
	for i := 0; i < count; i++ {
		binary.LittleEndian.PutUint16(b[i*2:], uint16(int16((i%7)-3)))
	}
	if pad := len(b) % 64; pad != 0 {
		b = append(b, make([]byte, 64-pad)...)
	}
	path := filepath.Join(t.TempDir(), "synthetic.bin")
	if err := os.WriteFile(path, b, 0o644); err != nil {
		t.Fatal(err)
	}
	return path
}
