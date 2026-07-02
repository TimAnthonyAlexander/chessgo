package duckchess

import "github.com/timanthonyalexander/gomachine/internal/chess"

// Status is the terminal (or ongoing) state of a Duck Chess game.
type Status string

const (
	Ongoing  Status = "ongoing"
	WhiteWin Status = "white_win"
	BlackWin Status = "black_win"
	Draw     Status = "draw"
)

// drawMoveCap adjudicates a draw once the full-move number exceeds this bound, so
// a pathological game cannot run forever. This is the simple hard cap the spec
// permits (no threefold tracking).
const drawMoveCap = 300

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

// statusAfter classifies the position `s` (the state AFTER a move) given who just
// moved and whether that move captured a king. Precedence: a king capture wins
// immediately; otherwise the side now to move loses if it has zero legal piece
// moves; otherwise the move cap may force a draw; otherwise the game continues.
func (s *State) statusAfter(mover chess.Color, capturedKing bool) Status {
	if capturedKing {
		return winFor(mover)
	}
	if len(s.LegalPieceMoves()) == 0 {
		// The side to move is stalemated in the Duck-Chess sense: it loses.
		return winFor(mover)
	}
	if s.fullmove > drawMoveCap {
		return Draw
	}
	return Ongoing
}

// Status reports the terminal state of the CURRENT position (side to move has not
// yet moved). Used by callers that want to adjudicate a freshly parsed state: the
// side to move loses if it has no legal piece move, else the cap may draw, else
// ongoing. A king already missing from the board resolves to the other side's win.
func (s *State) Status() Status {
	if s.kingSquare(chess.White) == chess.SqNone {
		return BlackWin
	}
	if s.kingSquare(chess.Black) == chess.SqNone {
		return WhiteWin
	}
	if len(s.LegalPieceMoves()) == 0 {
		return winFor(s.side.Opposite())
	}
	if s.fullmove > drawMoveCap {
		return Draw
	}
	return Ongoing
}
