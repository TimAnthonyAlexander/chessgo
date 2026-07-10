package nnue

import (
	"fmt"
	"math/rand"
	"os"
	"sort"
	"strings"
	"testing"

	"github.com/timanthonyalexander/gomachine/internal/chess"
)

// TestSFThreatDumpForRust plays deterministic random games and writes, per sampled
// position, the FEN plus the Go engine's sorted THREAT feature lists for the
// side-to-move (stm) and other (ntm) perspectives — the exact stm/ntm framing the
// bullet trainer's `threat_lists()` returns. The Rust recipe's `cross_check_dump`
// test reads this file and asserts byte-equality, so this walk pins Go<->Rust over
// hundreds of REAL positions: doubled rooks / pawn chains (same-type dedup),
// wandering kings (d/e mirror crossings), black-to-move boards (stm/ntm swap +
// ^56), and dense middlegames (near the active-edge cap). Set NNUE_DUMP to the
// output path (default /tmp/go_threat_dump.txt); a no-op assertion otherwise.
func TestSFThreatDumpForRust(t *testing.T) {
	out := os.Getenv("NNUE_DUMP")
	if out == "" {
		out = "/tmp/go_threat_dump.txt"
	}
	rng := rand.New(rand.NewSource(0xC0FFEE))
	var b strings.Builder
	seen := make(map[string]bool)
	nPos := 0

	threatCSV := func(pos *chess.Position, persp chess.Color) string {
		feats := appendEnrichedFeatures(nil, pos, persp)
		var th []int
		for _, f := range feats {
			if f >= uint32(PsqSize) {
				th = append(th, int(f))
			}
		}
		sort.Ints(th)
		parts := make([]string, len(th))
		for i, v := range th {
			parts[i] = fmt.Sprintf("%d", v)
		}
		return strings.Join(parts, ",")
	}

	emit := func(pos *chess.Position) {
		fen := pos.FEN()
		if seen[fen] {
			return
		}
		seen[fen] = true
		stm := pos.SideToMove()
		ntm := chess.White
		if stm == chess.White {
			ntm = chess.Black
		}
		b.WriteString(fen)
		b.WriteByte('|')
		b.WriteString(threatCSV(pos, stm))
		b.WriteByte('|')
		b.WriteString(threatCSV(pos, ntm))
		b.WriteByte('\n')
		nPos++
	}

	// Guaranteed coverage of the paths random play only hits probabilistically —
	// so #4 (dedup / mirror) is asserted, not hoped for.
	adversarial := []string{
		"4r1k1/8/8/8/8/8/8/4R1K1 w - - 0 1",       // R<->R mutual on open e-file (same-type dedup)
		"4r1k1/8/8/8/8/8/8/4R1K1 b - - 0 1",       // same, black to move (stm/ntm swap on the dedup)
		"4k3/8/4p3/3P4/8/8/8/4K3 w - - 0 1",       // white d5 <-> black e6 mutual pawn attack (pawn dedup keeps both)
		"3k4/8/8/8/8/8/8/3K4 w - - 0 1",           // both kings d-file -> mir=0 (vs startpos mir=7)
		"6k1/8/8/8/8/8/8/R6K w - - 0 1",           // king g8/h1 -> e-h half, mir=7 one side
		"r3k2r/pppppppp/8/8/8/8/PPPPPPPP/R3K2R w KQkq - 0 1", // pre-castle, doubled-rook potential both sides
	}
	for _, fen := range adversarial {
		pos, err := chess.ParseFEN(fen)
		if err != nil {
			t.Fatalf("adversarial %q: %v", fen, err)
		}
		emit(pos)
	}

	const games, maxPlies, targetPos = 120, 80, 1500
	for g := 0; g < games && nPos < targetPos; g++ {
		pos, err := chess.ParseFEN(chess.StartFEN)
		if err != nil {
			t.Fatal(err)
		}
		for ply := 0; ply < maxPlies && nPos < targetPos; ply++ {
			var ml chess.MoveList
			pos.GenerateLegal(&ml)
			if ml.Len() == 0 {
				break // mate/stalemate
			}
			// Sample positions from ply 4 onward (skip the trivial opening dupes).
			if ply >= 4 {
				emit(pos)
			}
			m := ml.Get(rng.Intn(ml.Len()))
			var u chess.Undo
			pos.DoMove(m, &u)
		}
	}
	if err := os.WriteFile(out, []byte(b.String()), 0o644); err != nil {
		t.Fatalf("write dump: %v", err)
	}
	t.Logf("wrote %d positions to %s (Rust cross_check_dump verifies)", nPos, out)
	if nPos < 500 {
		t.Fatalf("only %d positions sampled — expected >=500", nPos)
	}
}
