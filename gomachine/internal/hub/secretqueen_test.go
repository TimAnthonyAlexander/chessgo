package hub

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/timanthonyalexander/gomachine/internal/auth"
	"github.com/timanthonyalexander/gomachine/internal/chess"
	"github.com/timanthonyalexander/gomachine/internal/variant"
)

// Secret Queen is the only variant whose live payload is NOT the same for
// everybody, and the whole variant rests on that split being right: if either
// player's secret square, or a queen move from it, reaches anyone else, the game
// is not buggy — it is pointless, because you can just take the pawn that
// matters.
//
// These tests assert the split at the payload boundary, by marshalling each
// recipient's actual wire message and searching the JSON for the forbidden
// square. Checking the serialized bytes rather than named fields is deliberate:
// it catches a leak through a field nobody thought about, including one added
// later, which is exactly how this would realistically regress.
//
// The rules themselves are gated in zugzwang (zugzwang/test/secretqueen_test.cpp
// + the self-play harness); what is under test here is only who is told what.

const (
	sqWhiteSecret = "e2"
	sqBlackSecret = "h7"
	// A queen-only move from White's secret square: no pawn on e2 could reach
	// a6, so its presence in a move list is itself a disclosure that e2 is the
	// hidden queen.
	sqRevealingMove = "e2a6"
)

// sqStartFEN is the standard array with both secrets designated.
const sqStartFEN = "rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1 [" +
	sqWhiteSecret + "|" + sqBlackSecret + "]"

// stubSecretQueenBackend points internal/variant's Secret Queen HTTP client at a
// fake zugzwang that answers /secretqueen/legal-moves with a fixed list.
//
// A stub, not the real engine: what is being tested is the hub's payload
// assembly, and a canned move list lets the test state plainly that THIS move is
// the disclosing one and then check exactly who receives it. The real endpoint's
// behaviour is gated on the C++ side.
func stubSecretQueenBackend(t *testing.T, moves []string) {
	t.Helper()
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if !strings.HasSuffix(r.URL.Path, "/legal-moves") {
			t.Errorf("unexpected call to %s — this test should only need legal-moves", r.URL.Path)
		}
		w.Header().Set("Content-Type", "application/json")
		_ = json.NewEncoder(w).Encode(map[string]any{"moves": moves})
	}))
	t.Cleanup(srv.Close)

	variant.SetSecretQueenBackend(srv.URL)
	t.Cleanup(func() { variant.SetSecretQueenBackend("") })
}

// newSecretQueenGame builds a minimal in-memory game seeded from a canonical
// FEN, mirroring newAntichessGame/newDuckGame.
func newSecretQueenGame(t *testing.T, fen string) *game {
	t.Helper()
	st, err := variant.New(variantSecretQueen, fen)
	if err != nil {
		t.Fatalf("build secretqueen state: %v", err)
	}
	return &game{
		id:        "secretqueen-test",
		white:     &player{id: auth.Identity{UserID: "w"}},
		black:     &player{id: auth.Identity{UserID: "b"}},
		state:     st,
		tc:        timeControl{Base: 300_000, Inc: 0},
		clockMs:   [2]int64{300_000, 300_000},
		turnStart: time.Now(),
		online:    [2]bool{true, true},
		startFen:  fen,
		variant:   variantSecretQueen,
	}
}

// payloadJSON marshals a snapshot the way the hub actually sends it, so the
// assertions below run against the bytes on the wire.
func payloadJSON(t *testing.T, snap map[string]any) string {
	t.Helper()
	b, err := json.Marshal(snap)
	if err != nil {
		t.Fatalf("marshal payload: %v", err)
	}
	return string(b)
}

func mustHiddenState(t *testing.T, g *game) variant.HiddenState {
	t.Helper()
	hs, ok := g.hiddenState()
	if !ok {
		t.Fatal("secretqueen game did not expose a HiddenState — the per-viewer path would silently not run")
	}
	return hs
}

// The core leak test. White is to move and holds a hidden queen on e2; Black
// holds one on h7. Nobody but White may learn about e2, and nobody but Black may
// learn about h7 — through any field.
func TestSecretQueenPayloadNeverLeaksTheOpponentsSecret(t *testing.T) {
	stubSecretQueenBackend(t, []string{"e2e4", sqRevealingMove, "g1f3"})
	g := newSecretQueenGame(t, sqStartFEN)
	hs := mustHiddenState(t, g)

	white := payloadJSON(t, g.snapshotFor(hs, chess.White, true))
	black := payloadJSON(t, g.snapshotFor(hs, chess.Black, true))
	spectator := payloadJSON(t, g.snapshotFor(hs, chess.White, false))

	// Each player sees their own.
	if !strings.Contains(white, sqWhiteSecret) {
		t.Errorf("White was not told their own secret square %q: %s", sqWhiteSecret, white)
	}
	if !strings.Contains(black, sqBlackSecret) {
		t.Errorf("Black was not told their own secret square %q: %s", sqBlackSecret, black)
	}

	// And nobody else's. No move has been played in this fixture, so the only
	// way a square name can appear in a payload at all is a disclosure — there
	// is no lastMove/san to carry one innocently.
	if strings.Contains(white, sqBlackSecret) {
		t.Errorf("LEAK: White's payload discloses Black's secret %q: %s", sqBlackSecret, white)
	}
	if strings.Contains(black, sqWhiteSecret) {
		t.Errorf("LEAK: Black's payload discloses White's secret %q: %s", sqWhiteSecret, black)
	}
	for _, secret := range []string{sqWhiteSecret, sqBlackSecret} {
		if strings.Contains(spectator, secret) {
			t.Errorf("LEAK: the spectator payload discloses %q: %s", secret, spectator)
		}
	}

	// The move list is the subtler vector: it is White's turn, so only White may
	// receive it — a queen move from e2 announces e2 just as loudly as naming it.
	if !strings.Contains(white, sqRevealingMove) {
		t.Errorf("White (the mover) should receive their own legal moves: %s", white)
	}
	if strings.Contains(black, sqRevealingMove) {
		t.Errorf("LEAK: Black received the mover's legal moves, which name a queen move from e2: %s", black)
	}
	if strings.Contains(spectator, sqRevealingMove) {
		t.Errorf("LEAK: a spectator received the mover's legal moves: %s", spectator)
	}
}

// The board FEN is shared by everyone, so it must never carry the secret
// trailer. This is the property that makes redaction safe by construction
// rather than by remembering: a hidden queen is an ordinary pawn on the board.
func TestSecretQueenBoardFENCarriesNoSecret(t *testing.T) {
	stubSecretQueenBackend(t, []string{"e2e4"})
	g := newSecretQueenGame(t, sqStartFEN)
	hs := mustHiddenState(t, g)

	for _, tc := range []struct {
		name     string
		snapshot map[string]any
	}{
		{"white", g.snapshotFor(hs, chess.White, true)},
		{"black", g.snapshotFor(hs, chess.Black, true)},
		{"spectator", g.snapshotFor(hs, chess.White, false)},
	} {
		fen, _ := tc.snapshot["fen"].(string)
		if fen == "" {
			t.Fatalf("%s: payload carried no fen", tc.name)
		}
		if strings.ContainsAny(fen, "[]") {
			t.Errorf("%s: board fen still carries the secret trailer: %q", tc.name, fen)
		}
		if strings.Contains(fen, sqWhiteSecret) || strings.Contains(fen, sqBlackSecret) {
			t.Errorf("%s: board fen names a secret square: %q", tc.name, fen)
		}
	}
}

// Before both sides have designated, the game may not be played at all, and each
// player is told only whether THEY still owe a choice — never whether the
// opponent has already made theirs (which would leak timing information about a
// simultaneous decision).
func TestSecretQueenDesignationPhaseIsPerViewer(t *testing.T) {
	stubSecretQueenBackend(t, nil)
	// White has designated, Black has not.
	g := newSecretQueenGame(t, "rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1 ["+sqWhiteSecret+"|-]")
	hs := mustHiddenState(t, g)

	if g.secretQueenReady() {
		t.Error("game reported ready while Black had not designated")
	}

	white := g.snapshotFor(hs, chess.White, true)
	black := g.snapshotFor(hs, chess.Black, true)

	if white["needsDesignation"] != false {
		t.Errorf("White has designated but was still asked to: %v", white["needsDesignation"])
	}
	if black["needsDesignation"] != true {
		t.Errorf("Black has not designated but was not asked to: %v", black["needsDesignation"])
	}
	if got := payloadJSON(t, black); strings.Contains(got, sqWhiteSecret) {
		t.Errorf("LEAK: Black's designation-phase payload discloses White's secret: %s", got)
	}
	// Nobody gets a move list before the game can legally start.
	for name, snap := range map[string]map[string]any{"white": white, "black": black} {
		if moves, _ := snap["legalMoves"].([]string); len(moves) != 0 {
			t.Errorf("%s received %d legal moves during the designation phase", name, len(moves))
		}
	}
}

// Once the result is decided there is nothing left to protect, and a game that
// ended without a reveal would otherwise stay permanently unexplained — so
// everyone, including spectators, gets both squares.
func TestSecretQueenRevealsBothSecretsOnceOver(t *testing.T) {
	stubSecretQueenBackend(t, []string{"e2e4"})
	g := newSecretQueenGame(t, sqStartFEN)
	g.over = true
	hs := mustHiddenState(t, g)

	for _, tc := range []struct {
		name string
		snap map[string]any
	}{
		{"white", g.snapshotFor(hs, chess.White, true)},
		{"black", g.snapshotFor(hs, chess.Black, true)},
		{"spectator", g.snapshotFor(hs, chess.White, false)},
	} {
		squares, ok := tc.snap["secretSquares"].(map[string]string)
		if !ok {
			t.Errorf("%s: finished game did not report secretSquares: %v", tc.name, tc.snap)
			continue
		}
		if squares["w"] != sqWhiteSecret || squares["b"] != sqBlackSecret {
			t.Errorf("%s: finished game reported %v, want w=%s b=%s",
				tc.name, squares, sqWhiteSecret, sqBlackSecret)
		}
	}
}

// Every other variant must keep taking the ordinary shared-broadcast path —
// hiddenState() is the single switch that decides, so a regression there would
// silently route (or fail to route) whole variants through the wrong code.
func TestOnlySecretQueenNeedsPerViewerState(t *testing.T) {
	stubSecretQueenBackend(t, []string{"e2e4"})

	if _, ok := newSecretQueenGame(t, sqStartFEN).hiddenState(); !ok {
		t.Error("secretqueen did not report a hidden state")
	}
	for _, id := range []string{variantStandard, variantDuck, variantCrazyhouse, variantAntichess} {
		st, err := variant.New(id, chess.StartFEN)
		if err != nil {
			t.Fatalf("build %s state: %v", id, err)
		}
		g := &game{state: st, variant: id}
		if _, ok := g.hiddenState(); ok {
			t.Errorf("%s reported a hidden state — it would take the per-viewer path unnecessarily", id)
		}
	}
}
