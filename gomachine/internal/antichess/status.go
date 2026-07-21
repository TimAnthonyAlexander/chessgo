package antichess

import "github.com/timanthonyalexander/gomachine/internal/chess"

// Status is the terminal (or ongoing) state of an Antichess game.
type Status string

const (
	Ongoing  Status = "ongoing"
	WhiteWin Status = "white_win"
	BlackWin Status = "black_win"
	Draw     Status = "draw"
)

// fiftyMoveLimit is the halfmove-clock threshold (100 plies = 50 full moves by
// each side without a capture or pawn move) at which Antichess auto-draws.
// There is no "claim a draw" UI action for this variant in the hub (mirroring
// Crazyhouse's own auto-threefold), so both draw rules are applied outright
// rather than left claimable.
const fiftyMoveLimit = 100

// winFor maps the winning color to a terminal status.
func winFor(c chess.Color) Status {
	if c == chess.White {
		return WhiteWin
	}
	return BlackWin
}

// Result renders a status as a PGN result string ("" while ongoing).
func (st Status) Result() string {
	switch st {
	case WhiteWin:
		return "1-0"
	case BlackWin:
		return "0-1"
	case Draw:
		return "1/2-1/2"
	default:
		return ""
	}
}

// repetitions counts how many times the current position's key has occurred
// (including now) across the recorded game history.
func (s *State) repetitions() int {
	k := s.key()
	n := 1
	for _, h := range s.history {
		if h == k {
			n++
		}
	}
	return n
}

// Status reports the terminal state of the CURRENT position (side to move has
// not yet moved). Antichess's win condition is INVERTED from standard chess:
// the side to move WINS if it has no legal move — which covers both ruleset
// clauses at once, since a side with zero pieces on the board trivially has
// zero legal moves too (LegalMoves only ever iterates the mover's own
// pieces). Draws (threefold, 50-move) are checked first since they are
// automatic regardless of whose "turn" it nominally is.
func (s *State) Status() Status {
	if s.repetitions() >= 3 {
		return Draw
	}
	if s.halfmove >= fiftyMoveLimit {
		return Draw
	}
	if len(s.LegalMoves()) == 0 {
		return winFor(s.side)
	}
	return Ongoing
}
