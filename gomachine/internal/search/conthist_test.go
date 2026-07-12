package search

import (
	"testing"

	"github.com/timanthonyalexander/gomachine/internal/chess"
)

// firstQuiet returns the first quiet (non-capture, non-promotion, non-ep) legal
// move in pos, or NullMove if there is none.
func firstQuiet(pos *chess.Position) chess.Move {
	var ml chess.MoveList
	pos.GenerateLegal(&ml)
	for i := 0; i < ml.Len(); i++ {
		m := ml.Get(i)
		if pos.PieceOn(m.To()) == chess.NoPiece && m.Type() != chess.Promotion && m.Type() != chess.EnPassant {
			return m
		}
	}
	return chess.NullMove
}

// With ContHist off, a quiet move's ordering score must be exactly the butterfly
// history value — the continuation block may not perturb the off path at all.
func TestContHistOffNoPerturbation(t *testing.T) {
	p := DefaultParams()
	p.Nnue = false
	p.ContHist = false
	s := NewWithParams(16, p)
	pos, _ := chess.ParseFEN(chess.StartFEN)
	m := firstQuiet(pos)
	if m == chess.NullMove {
		t.Fatal("no quiet move from startpos")
	}
	mover := pos.PieceOn(m.From())
	s.history[mover][m.To()] = 1234
	if got := s.moveScore(pos, m, chess.NullMove, 3); got != 1234 {
		t.Errorf("ContHist off: moveScore=%d, want butterfly value 1234", got)
	}
}

// Feeding a positive cutoff signal for (parentMove → quietMove) must raise that
// quiet's continuation score; cold tables score 0.
func TestContHistDirection(t *testing.T) {
	p := DefaultParams()
	p.Nnue = false
	p.ContHist = true
	s := NewWithParams(16, p)
	s.contBegin()

	pos, _ := chess.ParseFEN(chess.StartFEN)
	parent := firstQuiet(pos)
	s.contMove[0] = contEntry{pc: pos.PieceOn(parent.From()), to: parent.To(), ok: true}

	curPc, to := chess.WhiteKnight, chess.Square(28)
	if before := s.contScore(1, curPc, to); before != 0 {
		t.Fatalf("cold continuation score = %d, want 0", before)
	}
	for i := 0; i < 16; i++ {
		s.contUpdate(1, curPc, to, s.statBonus(8))
	}
	if after := s.contScore(1, curPc, to); after <= 0 {
		t.Errorf("positive signal did not raise continuation score (got %d)", after)
	}
}

// PCM: pcmCreditParent must raise the PARENT move's continuation score AND its
// butterfly history (a fail-low means the quiet parent was good). Crediting the
// parent at ply-1=2 keys cont.one by contMove[1] and cont.two by contMove[0], which
// is exactly what contScore(2, parentPc, parentTo) reads back — so no off-by-one.
func TestPCMRaisesParentHistories(t *testing.T) {
	p := DefaultParams()
	p.Nnue = false
	p.ContHist = true
	p.ParentContHistBonus = true
	s := NewWithParams(16, p)
	s.contBegin()

	// A three-deep quiet ancestor chain; the parent move (credited) is at ply-1 = 2.
	s.contMove[0] = contEntry{pc: chess.WhitePawn, to: chess.Square(16), ok: true, quiet: true}
	s.contMove[1] = contEntry{pc: chess.BlackPawn, to: chess.Square(40), ok: true, quiet: true}
	parentPc, parentTo := chess.WhiteKnight, chess.Square(21)
	s.contMove[2] = contEntry{pc: parentPc, to: parentTo, ok: true, quiet: true}

	if before := s.contScore(2, parentPc, parentTo); before != 0 {
		t.Fatalf("cold parent continuation score = %d, want 0", before)
	}
	if s.history[parentPc][parentTo] != 0 {
		t.Fatalf("cold parent butterfly = %d, want 0", s.history[parentPc][parentTo])
	}

	// Drive the fail-low credit several times (bestScore well below staticEval so the
	// margin term also fires): ply=3, depth=8, not in check.
	for i := 0; i < 16; i++ {
		s.pcmCreditParent(3, 8, -100 /*bestScore*/, 200 /*staticEval*/, false /*inCheck*/)
	}

	if after := s.contScore(2, parentPc, parentTo); after <= 0 {
		t.Errorf("PCM did not raise the parent's continuation score (got %d)", after)
	}
	if s.history[parentPc][parentTo] <= 0 {
		t.Errorf("PCM did not raise the parent's butterfly history (got %d)", s.history[parentPc][parentTo])
	}
}

// PCM malus: pcmPenalizeParent must DRIVE the parent's continuation score NEGATIVE
// (a fail-high means the quiet parent got refuted) and must NOT touch butterfly history
// (SF's fail-high parent penalty is continuation-history only).
func TestPCMMalusPenalizesParent(t *testing.T) {
	p := DefaultParams()
	p.Nnue = false
	p.ContHist = true
	p.ParentContHistMalus = true
	s := NewWithParams(16, p)
	s.contBegin()

	s.contMove[0] = contEntry{pc: chess.WhitePawn, to: chess.Square(16), ok: true, quiet: true}
	s.contMove[1] = contEntry{pc: chess.BlackPawn, to: chess.Square(40), ok: true, quiet: true}
	parentPc, parentTo := chess.WhiteKnight, chess.Square(21)
	s.contMove[2] = contEntry{pc: parentPc, to: parentTo, ok: true, quiet: true, moveCount: 0}

	if before := s.contScore(2, parentPc, parentTo); before != 0 {
		t.Fatalf("cold parent continuation score = %d, want 0", before)
	}
	for i := 0; i < 16; i++ {
		s.pcmPenalizeParent(3, 8)
	}
	if after := s.contScore(2, parentPc, parentTo); after >= 0 {
		t.Errorf("PCM malus did not drive the parent's continuation score negative (got %d)", after)
	}
	if s.history[parentPc][parentTo] != 0 {
		t.Errorf("PCM malus touched butterfly history (%d); it must be continuation-history only", s.history[parentPc][parentTo])
	}
}

// A null move sets an ok=false continuation entry, so the child keys off NOTHING:
// contScore must be 0 even when the table holds data for the would-be parent.
func TestContHistNullMoveNoContinuation(t *testing.T) {
	p := DefaultParams()
	p.Nnue = false
	p.ContHist = true
	s := NewWithParams(16, p)
	s.contBegin()

	pos, _ := chess.ParseFEN(chess.StartFEN)
	parent := firstQuiet(pos)
	curPc, to := chess.WhiteKnight, chess.Square(28)

	// Train with a real parent so an entry exists, then verify the null sentinel
	// makes the child read nothing.
	s.contMove[0] = contEntry{pc: pos.PieceOn(parent.From()), to: parent.To(), ok: true}
	for i := 0; i < 16; i++ {
		s.contUpdate(1, curPc, to, s.statBonus(8))
	}
	if s.contScore(1, curPc, to) == 0 {
		t.Fatal("expected a trained continuation score before the null test")
	}
	s.contMove[0] = contEntry{} // null move → no continuation parent
	if got := s.contScore(1, curPc, to); got != 0 {
		t.Errorf("null-move child read a continuation score %d, want 0", got)
	}
}

// reset() must wipe the continuation tables (per-search state, like butterfly).
func TestContHistClearedByReset(t *testing.T) {
	p := DefaultParams()
	p.Nnue = false
	p.ContHist = true
	s := NewWithParams(16, p)
	s.contBegin()

	pos, _ := chess.ParseFEN(chess.StartFEN)
	parent := firstQuiet(pos)
	pe := contEntry{pc: pos.PieceOn(parent.From()), to: parent.To(), ok: true}
	curPc, to := chess.WhiteKnight, chess.Square(28)
	s.contMove[0] = pe
	for i := 0; i < 16; i++ {
		s.contUpdate(1, curPc, to, s.statBonus(8))
	}

	s.reset(Limits{}, nil) // clears tables + path via contBegin
	s.contMove[0] = pe     // re-establish the parent so the read isn't trivially gated
	if got := s.contScore(1, curPc, to); got != 0 {
		t.Errorf("reset did not clear continuation tables (got %d)", got)
	}
}

// A real ContHist-on search must run cleanly, return a legal move, and actually
// populate the continuation tables (proving the update path fires in search).
func TestContHistSearchPopulates(t *testing.T) {
	p := DefaultParams()
	p.Nnue = false
	p.ContHist = true
	s := NewWithParams(16, p)
	pos, _ := chess.ParseFEN("r1bqkb1r/pppp1ppp/2n2n2/4p3/2B1P3/5N2/PPPP1PPP/RNBQK2R w KQkq - 4 4")

	res := s.Search(pos, Limits{Depth: 8}, nil)
	if res.BestMove == chess.NullMove {
		t.Fatal("ContHist search returned a null best move")
	}
	nonzero := false
	for a := 0; a < 12 && !nonzero; a++ {
		for b := 0; b < 64 && !nonzero; b++ {
			for c := 0; c < 12 && !nonzero; c++ {
				for d := 0; d < 64; d++ {
					if s.cont.one[a][b][c][d] != 0 || s.cont.two[a][b][c][d] != 0 {
						nonzero = true
						break
					}
				}
			}
		}
	}
	if !nonzero {
		t.Error("continuation tables stayed empty after a real search")
	}
}
