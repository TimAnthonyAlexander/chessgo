package server

import (
	"net/http"
	"os"
	"strconv"
	"sync"
	"sync/atomic"
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
	// 100 ms/position is the whole-game OVERVIEW budget (eval graph + blunder tags).
	// It's deliberately modest because the analysis board re-searches whichever
	// single node you park on to a much deeper budget on demand (the client's
	// progressive-deepening /analyze ladder), so accuracy where it matters isn't
	// bounded by this pass — only the first-open latency is. Combined with the
	// single-thread analysis pool + warm-TT contiguous chunking (handleAnalyzeGame),
	// an ~120-ply game reviews in ~2 s. In practice the analysis is precomputed
	// off-request on game end (a queue worker), so this budget only bounds the rare
	// cold GET. Callers can still override up to the clamp ceiling.
	analyzeDefaultMoveTime = 100  // ms per position
	analyzeMinMoveTime     = 100  // clamp floor
	analyzeMaxMoveTime     = 3000 // clamp ceiling
	analyzeMaxMoves        = 600  // refuse absurdly long inputs

	// Contiguous positions each worker claims per turn. Consecutive plies differ
	// by a single move, so running a block back-to-back on one engine keeps its
	// transposition table warm across the block (a deeper search in the same
	// movetime). Small enough that dynamic claiming still balances the cheap
	// opening-book plies (which cluster at the front) across workers, and that the
	// end-of-game tail doesn't leave workers idle. Overridable via
	// GOMACHINE_ANALYZE_CHUNK for tuning.
	analyzeChunkDefault = 4
)

// analyzeChunk is the block size for the /analyze-game fan-out, read once from
// GOMACHINE_ANALYZE_CHUNK (fallback analyzeChunkDefault). A larger block warms
// the TT more; a smaller one balances the tail better.
var analyzeChunk = func() int {
	if v, err := strconv.Atoi(os.Getenv("GOMACHINE_ANALYZE_CHUNK")); err == nil && v >= 1 {
		return v
	}
	return analyzeChunkDefault
}()

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

	workers := s.analysisPoolSize()
	if workers < 1 {
		workers = 1
	}
	if workers > len(fens) {
		workers = len(fens)
	}

	// Contiguous block-stealing: each worker holds ONE pooled engine for its whole
	// run and claims blocks of adjacent positions, so the engine's transposition
	// table stays warm across near-identical consecutive plies — a deeper search in
	// the same movetime than the old goroutine-per-position fan-out (which grabbed
	// an arbitrary worker per position, so its warm TT held unrelated positions).
	// Claiming blocks dynamically keeps workers balanced despite the cheap opening-
	// book plies bunching at the front.
	results := make([]map[string]any, len(fens))
	var cursor int64
	var wg sync.WaitGroup
	for wkr := 0; wkr < workers; wkr++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			eng := s.acquireAnalysis()
			defer s.releaseAnalysis(eng)
			chunk := analyzeChunk
			for {
				start := int(atomic.AddInt64(&cursor, int64(chunk))) - chunk
				if start >= len(fens) {
					return
				}
				end := start + chunk
				if end > len(fens) {
					end = len(fens)
				}
				for i := start; i < end; i++ {
					results[i] = s.analyzePositionWith(eng, fens[i], movetime)
				}
			}
		}()
	}
	wg.Wait()

	writeJSON(w, http.StatusOK, map[string]any{
		"positions": results,
		"count":     len(results),
	})
}

// analyzePositionWith evaluates one position at full strength on the CALLER'S
// engine (already acquired from the analysis pool). Reusing one engine across a
// contiguous block of plies keeps its transposition table warm — the point of
// the block-stealing fan-out in handleAnalyzeGame.
//
// It is deliberately OBJECTIVE: it does NOT thread the game's prior positions in
// as repetition history. Game review wants "the best move / eval in THIS
// position", not a practical playing decision — and the search treats the first
// repetition of a game-history position as a draw (the standard, strength-positive
// playing heuristic; see search.isRepetition). Feeding history in would therefore
// let a position score 0.00 the instant it recurred in the game (e.g. a king
// shuffle), masking a forced mate — the exact analysis bug this avoids. Cycles
// WITHIN the search tree are still detected (the searcher tracks its own move
// stack), so perpetuals/fortresses still evaluate as draws.
func (s *Server) analyzePositionWith(eng *engine.Engine, fen string, movetimeMs int) map[string]any {
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

	res := eng.SearchDirect(pos, 0, time.Duration(movetimeMs)*time.Millisecond, nil)

	// No legal move ⇒ the game is over at this position (checkmate or stalemate).
	if res.Move == chess.NullMove {
		st := engine.Adjudicate(pos, nil)
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
