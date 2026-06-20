package engine

import (
	"github.com/timanthonyalexander/gomachine/internal/chess"
	"github.com/timanthonyalexander/gomachine/internal/syzygy"
)

// tbWinScore is the score reported for a tablebase win/loss. It sits well above
// normal material/positional scores (so a TB hit reads as decisive) but below
// the mate range, since a TB win is not a forced mate in N from here. The exact
// value is display-only: a root TB hit returns immediately, bypassing search.
const tbWinScore = 20000

// SetTablebase attaches a Syzygy endgame tablebase. It's consulted at the root
// (DTZ-optimal move) when the engine's params have UseTablebase set, and at
// internal search nodes (WDL) when Params.TBSearch is set — otherwise inert. The
// same handle is safe to share across engines and SMP workers: Fathom serializes
// its own root/DTZ probes and its WDL probe is thread-safe. Pass nil to detach.
func (e *Engine) SetTablebase(tb *syzygy.Tablebase) {
	e.tb = tb
	e.searcher.SetTablebase(tb) // WDL-in-search path (Params.TBSearch)
}

// tablebaseMove returns a DTZ-optimal move from the Syzygy tablebase when the
// engine has one enabled (UseTablebase) and the position is in range: at most
// MaxPieces pieces and no castling rights (Syzygy assumes none). A hit returns
// the provably-optimal move at zero search cost — strictly better than searching
// these endings under a time budget (K+B+N vs K, K+Q vs K+R, …). A miss (out of
// range, files absent, or probe failure) falls through to the normal search.
//
// Nodes=0 marks the hit (as the book does); the score is a coarse WDL mapping
// (win/loss → ±tbWinScore, draw/cursed/blessed → 0, since the 50-move rule turns
// cursed wins and blessed losses into draws).
func (e *Engine) tablebaseMove(pos *chess.Position) (BestResult, bool) {
	if !e.useTablebase || e.tb == nil {
		return BestResult{}, false
	}
	if pos.Occupied().Count() > e.tb.MaxPieces() {
		return BestResult{}, false
	}
	if pos.HasCastlingRights() {
		return BestResult{}, false
	}
	// Defense-in-depth: never hand the prober an illegal position (the side NOT to
	// move in check). Fathom's capture-resolution would "capture the king" and read
	// a king-less position. Real game positions are always legal, so this only
	// guards against a malformed caller — and tb_probe_root itself returns FAILED
	// rather than crashing — but the cost is a single attack test.
	if !pos.Legal() {
		return BestResult{}, false
	}

	res, ok := e.tb.ProbeRoot(tbPosition(pos))
	if !ok {
		return BestResult{}, false
	}

	// Decode the move via its canonical UCI string, which robustly resolves
	// against the legal moves (handling ep/promotion/flags) — a miss here means a
	// desync we conservatively ignore (fall back to search).
	m, legal := pos.ParseUCIMove(tbMoveUCI(res))
	if !legal {
		return BestResult{}, false
	}
	return BestResult{
		Move: m, Score: tbScore(res.WDL), MateIn: 0,
		Depth: 0, Nodes: 0, PV: []chess.Move{m}, Level: -1,
	}, true
}

// tbPosition builds the bitboard request Fathom needs from a chess.Position. The
// piece bitboards are color-agnostic (both sides' kings, queens, …); White/Black
// are the per-color occupancies. ep is 0 when there's no real en-passant target
// (a1 is never an ep square, so 0 is unambiguous). Castling is always 0 — the
// caller already rejected positions with castling rights.
func tbPosition(pos *chess.Position) syzygy.Position {
	both := func(pt chess.PieceType) uint64 {
		return uint64(pos.PieceBB(chess.MakePiece(chess.White, pt)) |
			pos.PieceBB(chess.MakePiece(chess.Black, pt)))
	}
	ep := uint(0)
	if s := pos.EnPassantSquare(); s != chess.SqNone {
		ep = uint(s)
	}
	return syzygy.Position{
		White:       uint64(pos.ColorBB(chess.White)),
		Black:       uint64(pos.ColorBB(chess.Black)),
		Kings:       both(chess.King),
		Queens:      both(chess.Queen),
		Rooks:       both(chess.Rook),
		Bishops:     both(chess.Bishop),
		Knights:     both(chess.Knight),
		Pawns:       both(chess.Pawn),
		Rule50:      uint(pos.HalfmoveClock()),
		Castling:    0,
		EP:          ep,
		WhiteToMove: pos.SideToMove() == chess.White,
	}
}

// tbMoveUCI renders a tablebase result as a UCI move string (e.g. "e2e4",
// "e7e8q"). The from/to squares share internal/chess's a1=0..h8=63 layout.
func tbMoveUCI(res syzygy.Result) string {
	s := chess.Square(res.From).String() + chess.Square(res.To).String()
	switch res.Promotes {
	case syzygy.PromoteQueen:
		s += "q"
	case syzygy.PromoteRook:
		s += "r"
	case syzygy.PromoteBishop:
		s += "b"
	case syzygy.PromoteKnight:
		s += "n"
	}
	return s
}

// tbScore maps a side-to-move-relative WDL value to a centipawn-ish score.
// Cursed wins and blessed losses are draws under the 50-move rule, so they score 0.
func tbScore(wdl int) int {
	switch wdl {
	case syzygy.WDLWin:
		return tbWinScore
	case syzygy.WDLLoss:
		return -tbWinScore
	default: // draw, cursed win, blessed loss
		return 0
	}
}
