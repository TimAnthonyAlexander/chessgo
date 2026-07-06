package crazyhouse

import "github.com/timanthonyalexander/gomachine/internal/chess"

// Status is the terminal (or ongoing) state of a Crazyhouse game.
type Status string

const (
	Ongoing  Status = "ongoing"
	WhiteWin Status = "white_win"
	BlackWin Status = "black_win"
	Draw     Status = "draw"
)

// drawMoveCap adjudicates a draw once the fullmove number exceeds this bound — a
// safety valve so a pathological game cannot run forever (real games are shorter).
const drawMoveCap = 400

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

// Status reports the terminal state of the current position (side to move has not
// yet moved). A "mate" is real only when NO legal drop also escapes the check —
// LegalMoves already includes drops, so a lack of any legal move plus being in
// check is genuine checkmate; no legal move without check is stalemate (a draw).
func (s *State) Status() Status {
	if s.repetitions() >= 3 {
		return Draw
	}
	if len(s.LegalMoves()) == 0 {
		if s.pos.InCheck() {
			return winFor(s.pos.SideToMove().Opposite())
		}
		return Draw // stalemate
	}
	if s.pos.FullmoveNumber() > drawMoveCap {
		return Draw
	}
	return Ongoing
}

// repetitions counts how many times the current composite position has occurred
// (including now) across the game history.
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
