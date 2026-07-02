package server

import (
	"net/http"
	"runtime"
	"sync"
	"time"

	"github.com/timanthonyalexander/gomachine/internal/chess"
	"github.com/timanthonyalexander/gomachine/internal/duckchess"
)

// duckAnalyzeDefaultMoveTime is the ms-per-position search budget used when the
// request omits (or non-positively sets) movetime.
const duckAnalyzeDefaultMoveTime = 250

// duckAnalyzeGameRequest asks for a full Duck-Chess game review: replay the
// composite `moves` from the standard start (no duck) and evaluate every
// resulting position at full strength, bounded by `movetime` ms per position.
type duckAnalyzeGameRequest struct {
	Moves    []string `json:"moves"`    // composite "<pieceUCI>:<duckSquare>"
	MoveTime int      `json:"movetime"` // ms per position; <=0 = default
}

// handleDuckAnalyzeGame replays a finished Duck-Chess game and evaluates each
// position so the website can render a per-move review (eval bar, best move,
// blunders). Replaying the composite moves to recover each FEN is sequential;
// only the per-position BestMove calls fan out across goroutines (duckchess is
// self-contained — no shared TT/engine pool — so a plain bounded semaphore keeps
// concurrency in check). Mirrors handleAnalyzeGame's response shape.
//
// Response: { positions: [ {ply, fen, duck, sideToMove, eval|null, bestmove|null,
// bestSan|null, terminal, checkmate, stalemate} ], count }
func (s *Server) handleDuckAnalyzeGame(w http.ResponseWriter, r *http.Request) {
	var req duckAnalyzeGameRequest
	if !decode(w, r, &req) {
		return
	}
	if len(req.Moves) > analyzeMaxMoves {
		writeErr(w, http.StatusBadRequest, "too many moves")
		return
	}

	movetime := req.MoveTime
	if movetime <= 0 {
		movetime = duckAnalyzeDefaultMoveTime
	}
	if movetime > analyzeMaxMoveTime {
		movetime = analyzeMaxMoveTime
	}

	// Replay sequentially, snapshotting one State per position (len(moves)+1):
	// index i is the position after i moves (index 0 is the start).
	st, _ := duckchess.Parse(chess.StartFEN, "")
	states := make([]duckchess.State, 0, len(req.Moves)+1)
	states = append(states, st)
	for _, mv := range req.Moves {
		ns, _, _, err := st.ApplyComposite(mv)
		if err != nil {
			writeErr(w, http.StatusBadRequest, "illegal move in sequence: "+mv+": "+err.Error())
			return
		}
		st = ns
		states = append(states, st)
	}

	// Build the per-position base records (cheap, sequential). Terminal positions
	// are fully determined here; non-terminal ones get eval/bestmove filled by the
	// fan-out below.
	positions := make([]map[string]any, len(states))
	for i := range states {
		stp := &states[i]
		terminal := stp.Status() != duckchess.Ongoing
		out := map[string]any{
			"ply":        i,
			"fen":        stp.FEN(),
			"duck":       stp.DuckString(),
			"sideToMove": stp.SideChar(),
			"eval":       nil,
			"bestmove":   nil,
			"bestSan":    nil,
			"terminal":   terminal,
			"checkmate":  false,
			"stalemate":  false,
		}
		if terminal {
			// A king missing from the board ⇒ it was captured ⇒ a decisive win
			// ("checkmate"); otherwise the terminal is non-decisive (no legal move
			// or the draw cap) ⇒ "stalemate".
			if duckKingCaptured(stp) {
				out["checkmate"] = true
			} else {
				out["stalemate"] = true
			}
		}
		positions[i] = out
	}

	// Fan out the full-strength evaluations. Each goroutine writes only its own
	// distinct positions[i] map, so no synchronization beyond the WaitGroup is
	// needed. DefaultLimits() (Level -1) means NO rating/level ⇒ full strength.
	sem := make(chan struct{}, runtime.GOMAXPROCS(0))
	var wg sync.WaitGroup
	for i := range states {
		if positions[i]["terminal"].(bool) {
			continue
		}
		wg.Add(1)
		sem <- struct{}{}
		go func(i int) {
			defer wg.Done()
			defer func() { <-sem }()

			pos := states[i] // value copy — BestMove/SAN never mutate shared state
			lim := duckchess.DefaultLimits()
			lim.MoveTime = time.Duration(movetime) * time.Millisecond
			res := duckchess.BestMove(pos, lim)
			if !res.HasMove {
				return // defensive: terminal positions are already excluded
			}

			var evalObj any
			if res.Mate != 0 {
				evalObj = map[string]any{"type": "mate", "value": res.Mate}
			} else {
				evalObj = map[string]any{"type": "cp", "value": res.Score}
			}
			positions[i]["eval"] = evalObj
			positions[i]["bestmove"] = res.MoveString()
			positions[i]["bestSan"] = pos.SAN(res.Move, res.Duck)
		}(i)
	}
	wg.Wait()

	writeJSON(w, http.StatusOK, map[string]any{
		"positions": positions,
		"count":     len(positions),
	})
}

// duckKingCaptured reports whether either king is absent from the board (i.e. it
// was captured — the decisive Duck-Chess win). Uses only the public PieceOn API.
func duckKingCaptured(st *duckchess.State) bool {
	var whiteKing, blackKing bool
	for sq := chess.Square(0); sq < 64; sq++ {
		p := st.PieceOn(sq)
		if p == chess.NoPiece || p.Type() != chess.King {
			continue
		}
		if p.Color() == chess.White {
			whiteKing = true
		} else {
			blackKing = true
		}
	}
	return !whiteKing || !blackKing
}
