package variant

import (
	"github.com/timanthonyalexander/gomachine/internal/chess"
	"github.com/timanthonyalexander/gomachine/internal/crazyhouse"
	"github.com/timanthonyalexander/gomachine/internal/engine"
)

// crazyhouseState adapts internal/crazyhouse to the State interface. It is a
// Tier-2 variant (own rules + own search): standard board legality plus pockets
// and drops. The canonical FEN carries the pocket, so it self-describes; the
// board FEN and pocket are split out for the wire/client.
type crazyhouseState struct {
	s crazyhouse.State
}

func newCrazyhouseState(fen string) (State, error) {
	cs, err := crazyhouse.Parse(fen)
	if err != nil {
		return nil, err
	}
	return crazyhouseState{s: cs}, nil
}

func (c crazyhouseState) Side() chess.Color          { return c.s.Side() }
func (c crazyhouseState) FEN() string                { return c.s.FEN() }      // canonical (incl. [pocket])
func (c crazyhouseState) BoardFEN() string           { return c.s.BoardFEN() } // standard board for the renderer
func (c crazyhouseState) History() []uint64          { return nil }            // threefold is internal to crazyhouse.Status
func (c crazyhouseState) PrimaryUCI(m string) string { return m }              // plain UCI / "P@e4" drops
func (c crazyhouseState) CanMate(chess.Color) bool   { return true }           // drops make mate almost always possible

// Extras carries the pocket to the wire (white uppercase then black lowercase).
func (c crazyhouseState) Extras() map[string]string {
	return map[string]string{"pocket": c.s.PocketString()}
}

func (c crazyhouseState) LegalMoves() []string {
	moves := c.s.LegalMoves()
	out := make([]string, len(moves))
	for i, m := range moves {
		out[i] = m.UCI()
	}
	return out
}

func (c crazyhouseState) Apply(move string) (State, string, bool) {
	ns, san, ok := c.s.ApplyUCI(move)
	if !ok {
		return nil, "", false
	}
	return crazyhouseState{s: ns}, san, true
}

// Status maps crazyhouse terminal detection onto engine.Status. A win is always a
// checkmate (the only decisive result in the rules core); a draw is stalemate,
// threefold or the move cap.
func (c crazyhouseState) Status() engine.Status {
	st := engine.Status{State: "ongoing", Check: c.s.InCheck(), SideToMove: sideChar(c.s.Side())}
	switch c.s.Status() {
	case crazyhouse.Ongoing:
		// still playing
	case crazyhouse.Draw:
		st.State, st.Result = "draw", "1/2-1/2"
	case crazyhouse.WhiteWin:
		st.State, st.Result = "checkmate", "1-0"
	case crazyhouse.BlackWin:
		st.State, st.Result = "checkmate", "0-1"
	}
	return st
}

// crazyhouseSelfSearchMove computes a Crazyhouse bot move from a canonical FEN
// (which carries the pocket, so it fully reconstructs the position).
func crazyhouseSelfSearchMove(fen string, rating int) (string, bool) {
	cs, err := crazyhouse.Parse(fen)
	if err != nil {
		return "", false
	}
	res := crazyhouse.BestMove(cs, crazyhouse.Limits{Rating: rating, Level: -1})
	if !res.HasMove {
		return "", false
	}
	return res.MoveString(), true
}

// sideChar renders a color as the FEN side letter.
func sideChar(c chess.Color) string {
	if c == chess.White {
		return "w"
	}
	return "b"
}
