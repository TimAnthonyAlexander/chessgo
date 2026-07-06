package variant

import (
	"strings"

	"github.com/timanthonyalexander/gomachine/internal/chess"
	"github.com/timanthonyalexander/gomachine/internal/duckchess"
	"github.com/timanthonyalexander/gomachine/internal/engine"
)

// duckState is the Duck Chess ruleset, wrapping the self-contained duckchess core.
// It carries no repetition history (Duck ends by king-capture, no-legal-moves, or
// a move cap — never threefold) and reports no check.
type duckState struct {
	s duckchess.State
}

func newDuckState(fen string) (State, error) {
	ds, err := duckchess.Parse(fen, "")
	if err != nil {
		return nil, err
	}
	return duckState{s: ds}, nil
}

func (d duckState) Side() chess.Color        { return d.s.Side() }
func (d duckState) FEN() string              { return d.s.FEN() }
func (d duckState) BoardFEN() string         { return d.s.FEN() }
func (d duckState) History() []uint64        { return nil }
func (d duckState) CanMate(chess.Color) bool { return true } // a king is always capturable

// Extras carries the duck square (the FEN doesn't hold it — the duck rides
// separately). Always present so the wire's "duck" field is stable.
func (d duckState) Extras() map[string]string { return map[string]string{"duck": d.s.DuckString()} }

func (d duckState) LegalMoves() []string {
	pms := d.s.LegalPieceMoves()
	moves := make([]string, len(pms))
	for i, m := range pms {
		moves[i] = m.UCI()
	}
	return moves
}

// PrimaryUCI returns the piece portion of a composite "<pieceUCI>:<duckSquare>".
func (d duckState) PrimaryUCI(move string) string {
	if piece, _, ok := strings.Cut(move, ":"); ok {
		return piece
	}
	return move
}

func (d duckState) Apply(move string) (State, string, bool) {
	ns, pm, _, err := d.s.ApplyComposite(move)
	if err != nil {
		return nil, "", false
	}
	// SAN is rendered relative to the PRE-move state, with the new duck square.
	san := d.s.SAN(pm, ns.Duck())
	return duckState{s: ns}, san, true
}

// Status maps duckchess terminal detection onto the engine.Status shape. There is
// no check in Duck Chess; a win is a king capture or the loser having no legal
// piece move; the move cap forces a draw.
func (d duckState) Status() engine.Status {
	st := engine.Status{State: "ongoing", Check: false, SideToMove: d.s.SideChar()}
	switch d.s.Status() {
	case duckchess.Ongoing:
		// still playing
	case duckchess.Draw:
		st.State, st.Result = "draw-move-cap", "1/2-1/2"
	case duckchess.WhiteWin:
		st.State, st.Result = d.terminalReason(), "1-0"
	case duckchess.BlackWin:
		st.State, st.Result = d.terminalReason(), "0-1"
	}
	return st
}

// terminalReason distinguishes the two ways a Duck game is won: a captured
// (missing) king vs. the side to move having no legal piece move.
func (d duckState) terminalReason() string {
	var whiteKing, blackKing bool
	for sq := chess.Square(0); sq < 64; sq++ {
		switch d.s.PieceOn(sq) {
		case chess.WhiteKing:
			whiteKing = true
		case chess.BlackKing:
			blackKing = true
		}
	}
	if !whiteKing || !blackKing {
		return "king-captured"
	}
	return "no-legal-moves"
}

// duckSelfSearchMove computes a Duck Chess bot move from a position snapshot using
// the self-contained duckchess search (no engine pool / no shared TT).
func duckSelfSearchMove(fen, duck string, rating int) (string, bool) {
	st, err := duckchess.Parse(fen, duck)
	if err != nil {
		return "", false
	}
	res := duckchess.BestMove(st, duckchess.Limits{Rating: rating})
	if !res.HasMove {
		return "", false
	}
	return res.MoveString(), true
}
