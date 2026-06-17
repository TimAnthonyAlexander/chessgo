package chess

import "strings"

var pieceLetter = [6]byte{0, 'N', 'B', 'R', 'Q', 'K'} // index by PieceType

// SAN renders a move in Standard Algebraic Notation (Nf3, exd5, O-O, e8=Q+,
// Qh4xe1#) for display/PGN. The move must be legal in pos (SPEC §5.3).
func (pos *Position) SAN(m Move) string {
	var sb strings.Builder

	if m.Type() == Castling {
		if m.To().File() == FileG {
			sb.WriteString("O-O")
		} else {
			sb.WriteString("O-O-O")
		}
	} else {
		moving := pos.PieceOn(m.From())
		pt := moving.Type()
		capture := pos.PieceOn(m.To()) != NoPiece || m.Type() == EnPassant

		if pt == Pawn {
			if capture {
				sb.WriteByte(byte('a' + m.From().File()))
				sb.WriteByte('x')
			}
			sb.WriteString(m.To().String())
			if m.Type() == Promotion {
				sb.WriteByte('=')
				sb.WriteByte(pieceLetter[m.Promo()])
			}
		} else {
			sb.WriteByte(pieceLetter[pt])
			sb.WriteString(pos.sanDisambiguation(m, pt))
			if capture {
				sb.WriteByte('x')
			}
			sb.WriteString(m.To().String())
		}
	}

	// Check / checkmate suffix.
	var u Undo
	pos.DoMove(m, &u)
	if pos.InCheck() {
		var ml MoveList
		pos.GenerateLegal(&ml)
		if ml.Len() == 0 {
			sb.WriteByte('#')
		} else {
			sb.WriteByte('+')
		}
	}
	pos.UndoMove(m, &u)

	return sb.String()
}

// sanDisambiguation returns the minimal file/rank/square qualifier needed when
// more than one piece of type pt can legally move to m.To().
func (pos *Position) sanDisambiguation(m Move, pt PieceType) string {
	var ml MoveList
	pos.GenerateLegal(&ml)

	sameFile, sameRank, others := false, false, false
	for i := 0; i < ml.Len(); i++ {
		o := ml.Get(i)
		if o == m || o.To() != m.To() {
			continue
		}
		if pos.PieceOn(o.From()).Type() != pt {
			continue
		}
		others = true
		if o.From().File() == m.From().File() {
			sameFile = true
		}
		if o.From().Rank() == m.From().Rank() {
			sameRank = true
		}
	}
	if !others {
		return ""
	}
	switch {
	case !sameFile:
		return string([]byte{byte('a' + m.From().File())})
	case !sameRank:
		return string([]byte{byte('1' + m.From().Rank())})
	default:
		return m.From().String()
	}
}
