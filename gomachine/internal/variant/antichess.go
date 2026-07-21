package variant

import (
	"github.com/timanthonyalexander/gomachine/internal/antichess"
	"github.com/timanthonyalexander/gomachine/internal/chess"
	"github.com/timanthonyalexander/gomachine/internal/engine"
)

// antichessState adapts internal/antichess to the State interface. It is a
// Tier-2 variant (own rules + own search): no check/pin/castling, compulsory
// capture, king-as-ordinary-piece (including king promotion), and an
// INVERTED win condition (the side to move wins if it has no pieces or no
// legal move). The FEN is standard-shape and self-describing — no pockets, no
// duck square — so Extras is nil like standard chess.
type antichessState struct {
	s antichess.State
}

func newAntichessState(fen string) (State, error) {
	as, err := antichess.Parse(fen)
	if err != nil {
		return nil, err
	}
	return antichessState{s: as}, nil
}

func (a antichessState) Side() chess.Color          { return a.s.Side() }
func (a antichessState) FEN() string                { return a.s.FEN() }
func (a antichessState) BoardFEN() string           { return a.s.FEN() } // no auxiliary token to strip
func (a antichessState) Extras() map[string]string  { return nil }       // no pockets, no duck square
func (a antichessState) History() []uint64          { return nil }       // threefold is internal to antichess.Status
func (a antichessState) PrimaryUCI(m string) string { return m }         // plain UCI, no composite

// CanMate always reports true: Antichess has no way to permanently foreclose
// a decisive result on the board (a side can always eventually be forced to
// give away its last piece or run out of moves), mirroring Duck's own
// "always true" — the intent both share is "the opponent can still register a
// win on the board", which is unconditionally the case here.
func (a antichessState) CanMate(chess.Color) bool { return true }

func (a antichessState) LegalMoves() []string {
	moves := a.s.LegalMoves()
	out := make([]string, len(moves))
	for i, m := range moves {
		out[i] = m.UCI()
	}
	return out
}

func (a antichessState) Apply(move string) (State, string, bool) {
	ns, san, ok := a.s.Apply(move)
	if !ok {
		return nil, "", false
	}
	return antichessState{s: ns}, san, true
}

// Status maps antichess terminal detection onto engine.Status. There is never
// a check in Antichess; a decisive result is always the side-to-move's own
// win (the inverted rule), and a draw is threefold or the 50-move rule.
func (a antichessState) Status() engine.Status {
	st := engine.Status{State: "ongoing", Check: false, SideToMove: sideChar(a.s.Side())}
	switch a.s.Status() {
	case antichess.Ongoing:
		// still playing
	case antichess.Draw:
		st.State, st.Result = "draw", "1/2-1/2"
	case antichess.WhiteWin:
		st.State, st.Result = a.terminalReason(), "1-0"
	case antichess.BlackWin:
		st.State, st.Result = a.terminalReason(), "0-1"
	}
	return st
}

// terminalReason distinguishes the two ways an Antichess game is won: the
// side to move having no pieces left at all, vs. having pieces but no legal
// move (an inverted "stalemate").
func (a antichessState) terminalReason() string {
	if !a.s.HasPieces(a.s.Side()) {
		return "no-pieces"
	}
	return "stalemate-win"
}

// antichessSelfSearchMove computes an Antichess bot move from a canonical FEN
// (standard-shape, self-describing — no pockets, no duck square) using the
// self-contained antichess search. This is the "-emergency-inproc" fallback
// path only; zugzwang's own /antichess/bestmove endpoint owns real strength.
func antichessSelfSearchMove(fen string, rating int) (string, bool) {
	st, err := antichess.Parse(fen)
	if err != nil {
		return "", false
	}
	res := antichess.BestMove(st, antichess.Limits{Rating: rating, Level: -1})
	if !res.HasMove {
		return "", false
	}
	return res.MoveString(), true
}
