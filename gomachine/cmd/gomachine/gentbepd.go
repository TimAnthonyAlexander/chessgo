package main

import (
	"bufio"
	"flag"
	"fmt"
	"math/rand"
	"os"
	"strings"

	"github.com/timanthonyalexander/gomachine/internal/chess"
	"github.com/timanthonyalexander/gomachine/internal/syzygy"
)

// gen-tb-epd generates a quiet-position EPD labelled by Syzygy WDL ground truth,
// for the joint eval re-tune (endgame plan step 4). It is NOT self-play: positions
// are sampled directly and labelled by the tablebase, so the labels carry zero
// bias from the engine's own (weak) endgame play — the §6(d) rule. It oversamples
// ≤5-man material where king-to-passer distance decides the result, which is
// exactly where the KingProx weight needs signal and where real-game data is
// sparsest. Output format matches internal/tune's LoadEPD ("<fen> [1.0|0.5|0.0]",
// White-perspective).
//
// Material is restricted to ≤MaxPieces men (kings always present) and weighted
// toward pawn/king races. Each sample is: random legal placement → quiet filter
// (not in check, no capture available) → WDL probe → White-perspective label.

// tbMaterial is a (whiteNonKing, blackNonKing) signature; kings are implicit.
type tbMaterial struct {
	white, black []chess.PieceType
	weight       int // relative sampling frequency
}

func tbMaterials() []tbMaterial {
	P, N, B, R, Q := chess.Pawn, chess.Knight, chess.Bishop, chess.Rook, chess.Queen
	return []tbMaterial{
		// DRAWN material — the "where endgames draw" half, which fights the eval's
		// over-optimism (a lone minor scores ~+3 to the eval but is a dead draw).
		// Deliberately heavy so the slice isn't decisive-skewed like the first pass.
		{[]chess.PieceType{N}, nil, 4},                  // KNvK — insufficient, always draw
		{[]chess.PieceType{B}, nil, 4},                  // KBvK — insufficient, always draw
		{nil, []chess.PieceType{N}, 3},                  //
		{nil, []chess.PieceType{B}, 3},                  //
		{[]chess.PieceType{R}, []chess.PieceType{R}, 4}, // KRvKR — usually drawn
		{[]chess.PieceType{N}, []chess.PieceType{N}, 2}, //
		{[]chess.PieceType{B}, []chess.PieceType{B}, 2}, // (mixed colors → draws)
		// Pure king-and-pawn races — king distance is the whole game; KPvKP draws a lot.
		{[]chess.PieceType{P}, []chess.PieceType{P}, 9},
		{[]chess.PieceType{P}, nil, 4},
		{nil, []chess.PieceType{P}, 4},
		{[]chess.PieceType{P, P}, []chess.PieceType{P}, 5},
		{[]chess.PieceType{P}, []chess.PieceType{P, P}, 5},
		{[]chess.PieceType{P, P}, []chess.PieceType{P, P}, 4}, // 5-man pawn race, drawish
		{[]chess.PieceType{P, P}, nil, 2},
		{nil, []chess.PieceType{P, P}, 2},
		// Minor + pawn(s) — escort/blockade with a piece on the board.
		{[]chess.PieceType{N, P}, nil, 2},
		{[]chess.PieceType{B, P}, nil, 2},
		{[]chess.PieceType{N, P}, []chess.PieceType{P}, 3},
		{[]chess.PieceType{B, P}, []chess.PieceType{P}, 3},
		{nil, []chess.PieceType{N, P}, 2},
		// Rook endings — king proximity is nuanced; KRPvKR is the classic drawn/won mix.
		{[]chess.PieceType{R, P}, []chess.PieceType{R}, 5},
		{[]chess.PieceType{R, P}, []chess.PieceType{P}, 2},
		{[]chess.PieceType{R}, []chess.PieceType{P}, 1},
		// Decisive tails (low weight) — anchor the win/loss ends without dominating.
		{[]chess.PieceType{Q}, []chess.PieceType{P}, 1},
		{[]chess.PieceType{P}, []chess.PieceType{Q}, 1},
		{[]chess.PieceType{P, P, P}, nil, 1},
	}
}

func cmdGenTBEPD(args []string) {
	fs := flag.NewFlagSet("gen-tb-epd", flag.ExitOnError)
	out := fs.String("out", "data/tb_eg.epd", "output EPD path")
	n := fs.Int("n", 100000, "number of labelled positions to emit (keep modest vs the ~725k real-game base so theoretical-win bias can't dominate)")
	seed := fs.Int64("seed", 1, "RNG seed (deterministic output)")
	tbPath := fs.String("tb-path", "data/syzygy", "Syzygy tablebase directory")
	_ = fs.Parse(args)

	tb, err := syzygy.Open(*tbPath)
	if err != nil {
		fmt.Fprintln(os.Stderr, "tablebase:", err)
		os.Exit(1)
	}
	defer tb.Close()
	fmt.Fprintf(os.Stderr, "tablebase: up to %d-piece loaded from %s\n", tb.MaxPieces(), *tbPath)

	mats := tbMaterials()
	totalWeight := 0
	for _, m := range mats {
		totalWeight += m.weight
	}

	rng := rand.New(rand.NewSource(*seed))
	f, err := os.Create(*out)
	if err != nil {
		fmt.Fprintln(os.Stderr, "create:", err)
		os.Exit(1)
	}
	defer f.Close()
	w := bufio.NewWriter(f)
	defer w.Flush()

	seen := make(map[string]struct{}, *n)
	var wins, draws, losses int
	emitted := 0
	attempts := 0
	maxAttempts := *n * 200 // generous; random placement misses often

	for emitted < *n && attempts < maxAttempts {
		attempts++
		mat := pickMaterial(rng, mats, totalWeight)
		fen, ok := randomFEN(rng, mat)
		if !ok {
			continue
		}
		pos, err := chess.ParseFEN(fen)
		if err != nil || !pos.Legal() {
			continue
		}
		if !isQuiet(pos) {
			continue
		}
		wdl, ok := tb.ProbeWDL(tbProbePos(pos))
		if !ok {
			continue
		}
		canon := pos.FEN()
		if _, dup := seen[canon]; dup {
			continue
		}
		seen[canon] = struct{}{}

		label := whitePerspectiveLabel(wdl, pos.SideToMove())
		switch label {
		case "1.0":
			wins++
		case "0.5":
			draws++
		default:
			losses++
		}
		fmt.Fprintf(w, "%s [%s]\n", canon, label)
		emitted++
		if emitted%20000 == 0 {
			fmt.Fprintf(os.Stderr, "  %d/%d emitted (%d attempts)\n", emitted, *n, attempts)
		}
	}

	w.Flush()
	fmt.Fprintf(os.Stderr, "done: %d positions → %s  (W %d / D %d / L %d, white-perspective; %d attempts)\n",
		emitted, *out, wins, draws, losses, attempts)
	if emitted < *n {
		fmt.Fprintf(os.Stderr, "warning: only %d/%d emitted before hitting the attempt cap\n", emitted, *n)
	}
}

func pickMaterial(rng *rand.Rand, mats []tbMaterial, total int) tbMaterial {
	r := rng.Intn(total)
	for _, m := range mats {
		if r < m.weight {
			return m
		}
		r -= m.weight
	}
	return mats[len(mats)-1]
}

// randomFEN places the two kings (non-adjacent) and the signature's pieces on
// random empty squares (pawns confined to ranks 2..7), picks a random side to
// move, and returns a castling/ep-free FEN. ok=false when placement failed (e.g.
// no room) so the caller retries.
func randomFEN(rng *rand.Rand, mat tbMaterial) (string, bool) {
	var board [64]chess.Piece
	for i := range board {
		board[i] = chess.NoPiece
	}
	occupied := func(sq chess.Square) bool { return board[sq] != chess.NoPiece }

	wk := chess.Square(rng.Intn(64))
	board[wk] = chess.WhiteKing
	// Black king: not equal, not adjacent to the white king.
	bk := chess.SqNone
	for tries := 0; tries < 64; tries++ {
		c := chess.Square(rng.Intn(64))
		if !occupied(c) && kingsApart(wk, c) {
			bk = c
			break
		}
	}
	if bk == chess.SqNone {
		return "", false
	}
	board[bk] = chess.BlackKing

	place := func(pieces []chess.PieceType, color chess.Color) bool {
		for _, pt := range pieces {
			placed := false
			for tries := 0; tries < 96; tries++ {
				sq := chess.Square(rng.Intn(64))
				if occupied(sq) {
					continue
				}
				if pt == chess.Pawn {
					r := sq.Rank()
					if r == chess.Rank1 || r == chess.Rank8 {
						continue // pawns never on the back ranks
					}
				}
				board[sq] = chess.MakePiece(color, pt)
				placed = true
				break
			}
			if !placed {
				return false
			}
		}
		return true
	}
	if !place(mat.white, chess.White) || !place(mat.black, chess.Black) {
		return "", false
	}

	side := "w"
	if rng.Intn(2) == 1 {
		side = "b"
	}
	return boardToFEN(&board) + " " + side + " - - 0 1", true
}

// kingsApart reports whether two king squares are non-equal and non-adjacent.
func kingsApart(a, b chess.Square) bool {
	if a == b {
		return false
	}
	df := int(a.File()) - int(b.File())
	if df < 0 {
		df = -df
	}
	dr := int(a.Rank()) - int(b.Rank())
	if dr < 0 {
		dr = -dr
	}
	return df > 1 || dr > 1
}

func boardToFEN(board *[64]chess.Piece) string {
	var sb strings.Builder
	for r := 7; r >= 0; r-- {
		empty := 0
		for fl := 0; fl < 8; fl++ {
			p := board[r*8+fl]
			if p == chess.NoPiece {
				empty++
				continue
			}
			if empty > 0 {
				sb.WriteByte(byte('0' + empty))
				empty = 0
			}
			sb.WriteByte(pieceFENChar(p))
		}
		if empty > 0 {
			sb.WriteByte(byte('0' + empty))
		}
		if r > 0 {
			sb.WriteByte('/')
		}
	}
	return sb.String()
}

var fenChars = [12]byte{'P', 'N', 'B', 'R', 'Q', 'K', 'p', 'n', 'b', 'r', 'q', 'k'}

func pieceFENChar(p chess.Piece) byte { return fenChars[p] }

// isQuiet keeps positions where the static eval is meaningful: the side to move
// is not in check and has no capture available (so the eval isn't dominated by
// material about to change). The TB label is exact regardless, but a quiet
// position is what the Texel static-eval fit assumes.
func isQuiet(pos *chess.Position) bool {
	if pos.InCheck() {
		return false
	}
	var ml chess.MoveList
	pos.GenerateLegal(&ml)
	if ml.Len() == 0 {
		return false // stalemate/mate — not a useful tuning position
	}
	for i := 0; i < ml.Len(); i++ {
		m := ml.Get(i)
		if pos.PieceOn(m.To()) != chess.NoPiece || m.Type() == chess.EnPassant {
			return false // a capture is available
		}
	}
	return true
}

// whitePerspectiveLabel maps a side-to-move-relative WDL to a White-perspective
// Texel label. Cursed-win/blessed-loss → draw (rule50-independent, matching the
// in-search and root probes).
func whitePerspectiveLabel(wdl int, stm chess.Color) string {
	stmScore := 0.5
	switch wdl {
	case syzygy.WDLWin:
		stmScore = 1.0
	case syzygy.WDLLoss:
		stmScore = 0.0
	}
	white := stmScore
	if stm == chess.Black {
		white = 1.0 - stmScore
	}
	switch white {
	case 1.0:
		return "1.0"
	case 0.0:
		return "0.0"
	default:
		return "0.5"
	}
}

// tbProbePos builds Fathom's request from a chess.Position (same shape as the
// search/engine builders; replicated here to avoid exporting an internal helper).
func tbProbePos(pos *chess.Position) syzygy.Position {
	both := func(pt chess.PieceType) uint64 {
		return uint64(pos.PieceBB(chess.MakePiece(chess.White, pt)) |
			pos.PieceBB(chess.MakePiece(chess.Black, pt)))
	}
	ep := uint(0)
	if sq := pos.EnPassantSquare(); sq != chess.SqNone {
		ep = uint(sq)
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
