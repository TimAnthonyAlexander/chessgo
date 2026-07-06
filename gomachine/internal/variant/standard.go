package variant

import (
	"github.com/timanthonyalexander/gomachine/internal/chess"
	"github.com/timanthonyalexander/gomachine/internal/engine"
)

// standardState is the ruleset for standard chess and Chess960 — the rules are
// identical, the two differ only in the start position, which is just the parsed
// FEN. It wraps the engine core's Position (a pure value type, so it is copied on
// Apply for immutability) plus the repetition history.
type standardState struct {
	pos     chess.Position
	history []uint64 // prior-position Zobrist keys (excludes the current position)
}

func newStandardState(fen string) (State, error) {
	pos, err := chess.ParseFEN(fen)
	if err != nil {
		return nil, err
	}
	return standardState{pos: *pos}, nil
}

func (s standardState) Side() chess.Color          { return s.pos.SideToMove() }
func (s standardState) FEN() string                { return s.pos.FEN() }
func (s standardState) BoardFEN() string           { return s.pos.FEN() }
func (s standardState) Extras() map[string]string  { return nil }
func (s standardState) History() []uint64          { return s.history }
func (s standardState) PrimaryUCI(m string) string { return m }

func (s standardState) LegalMoves() []string {
	return s.pos.LegalMoveStrings(chess.SqNone)
}

func (s standardState) CanMate(side chess.Color) bool {
	return s.pos.CanAnyoneMate(side)
}

func (s standardState) Status() engine.Status {
	return engine.Adjudicate(&s.pos, s.history)
}

// Apply plays a move immutably: it copies the position, makes the move on the
// copy, and returns a new state with the pre-move key appended to a fresh history
// slice (never aliasing the receiver's).
func (s standardState) Apply(move string) (State, string, bool) {
	m, ok := s.pos.ParseUCIMove(move)
	if !ok {
		return nil, "", false
	}
	san := s.pos.SAN(m)
	next := s.pos // value copy — Position is a pure value type
	var u chess.Undo
	next.DoMove(m, &u)
	history := append(append([]uint64(nil), s.history...), s.pos.Key())
	return standardState{pos: next, history: history}, san, true
}
