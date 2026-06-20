package server

import (
	"net/http"
	"sync"
	"time"

	"github.com/timanthonyalexander/gomachine/internal/chess"
	"github.com/timanthonyalexander/gomachine/internal/engine"
)

// analyzeGameRequest asks for a full-game analysis: replay `moves` (UCI) from
// `startFen` (defaults to the standard start) and evaluate every resulting
// position at full strength, bounded by `movetime` ms per position.
type analyzeGameRequest struct {
	StartFEN string   `json:"startFen"`
	Moves    []string `json:"moves"`
	MoveTime int      `json:"movetime"` // ms per position; 0 = default
}

const (
	analyzeDefaultMoveTime = 600  // ms per position
	analyzeMinMoveTime     = 100  // clamp floor
	analyzeMaxMoveTime     = 3000 // clamp ceiling
	analyzeMaxMoves        = 600  // refuse absurdly long inputs
)

// handleAnalyzeGame replays a game and evaluates each position concurrently. Each
// position is searched at full strength (no level weakening) on a pooled engine,
// so concurrency is naturally bounded by the worker pool. The returned eval is
// from the side-to-move's perspective (callers flip to White-relative as needed).
//
// Response: { positions: [ {ply, fen, sideToMove, eval|null, bestmove|null,
// bestSan|null, pv, depth, terminal, checkmate, stalemate} ], count }
func (s *Server) handleAnalyzeGame(w http.ResponseWriter, r *http.Request) {
	var req analyzeGameRequest
	if !decode(w, r, &req) {
		return
	}
	if len(req.Moves) > analyzeMaxMoves {
		writeErr(w, http.StatusBadRequest, "too many moves")
		return
	}
	startFen := req.StartFEN
	if startFen == "" {
		startFen = chess.StartFEN
	}
	pos, ok := parseLegal(w, startFen)
	if !ok {
		return
	}

	// Replay the moves, snapshotting the FEN before each one. fens has one entry
	// per position (len(moves)+1): index i is the position before move i.
	fens := make([]string, 0, len(req.Moves)+1)
	fens = append(fens, pos.FEN())
	for _, uci := range req.Moves {
		m, ok := pos.ParseUCIMove(uci)
		if !ok {
			writeErr(w, http.StatusBadRequest, "illegal move in sequence: "+uci)
			return
		}
		var u chess.Undo
		pos.DoMove(m, &u)
		fens = append(fens, pos.FEN())
	}

	movetime := req.MoveTime
	if movetime == 0 {
		movetime = analyzeDefaultMoveTime
	}
	if movetime < analyzeMinMoveTime {
		movetime = analyzeMinMoveTime
	}
	if movetime > analyzeMaxMoveTime {
		movetime = analyzeMaxMoveTime
	}

	results := make([]map[string]any, len(fens))
	var wg sync.WaitGroup
	for i, fen := range fens {
		wg.Add(1)
		go func(i int, fen string) {
			defer wg.Done()
			results[i] = s.analyzePosition(fen, fens[:i], movetime)
		}(i, fen)
	}
	wg.Wait()

	writeJSON(w, http.StatusOK, map[string]any{
		"positions": results,
		"count":     len(results),
	})
}

// analyzePosition evaluates one position at full strength. history is the slice
// of prior-position FENs (for repetition-aware search). Runs on a pooled engine,
// so it blocks until a worker is free — bounding overall concurrency.
func (s *Server) analyzePosition(fen string, history []string, movetimeMs int) map[string]any {
	pos, err := chess.ParseFEN(fen)
	if err != nil {
		return map[string]any{"fen": fen, "error": "invalid fen"}
	}
	stm := "w"
	if pos.SideToMove() == chess.Black {
		stm = "b"
	}

	out := map[string]any{
		"fen":        fen,
		"sideToMove": stm,
	}

	// Opening book: serve a precomputed result instantly (start position etc.),
	// movegen-validated so a stale/wrong record can't inject an illegal move.
	if e, m, hit := s.bookHit(pos); hit {
		out["eval"] = bookEval(e)
		out["bestmove"] = m.String()
		out["bestSan"] = pos.SAN(m)
		out["pv"] = e.PV
		out["depth"] = e.Depth
		out["terminal"] = false
		out["checkmate"] = false
		out["stalemate"] = false
		return out
	}

	hist := historyKeys(history)

	eng := s.acquire()
	res := eng.SearchDirect(pos, 0, time.Duration(movetimeMs)*time.Millisecond, hist)
	s.release(eng)

	// No legal move ⇒ the game is over at this position (checkmate or stalemate).
	if res.Move == chess.NullMove {
		st := engine.Adjudicate(pos, hist)
		out["eval"] = nil
		out["bestmove"] = nil
		out["bestSan"] = nil
		out["pv"] = []string{}
		out["depth"] = 0
		out["terminal"] = true
		out["checkmate"] = st.State == "checkmate"
		out["stalemate"] = st.State == "stalemate"
		return out
	}

	evalObj := map[string]any{"type": "cp", "value": res.Score}
	if res.MateIn != 0 {
		evalObj = map[string]any{"type": "mate", "value": res.MateIn}
	}
	out["eval"] = evalObj
	out["bestmove"] = res.Move.String()
	out["bestSan"] = pos.SAN(res.Move)
	out["pv"] = pvStrings(res.PV)
	out["depth"] = res.Depth
	out["terminal"] = false
	out["checkmate"] = false
	out["stalemate"] = false
	return out
}
