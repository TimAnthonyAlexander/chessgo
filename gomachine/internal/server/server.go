// Package server exposes the gomachine engine over a stateless localhost HTTP/
// JSON API (SPEC §7.3). Every request carries the full position (FEN); the
// service keeps the magic tables and transposition tables warm across requests.
// PHP/BaseAPI remains the single source of truth for game persistence.
package server

import (
	"encoding/json"
	"net/http"
	"time"

	"github.com/timanthonyalexander/gomachine/internal/book"
	"github.com/timanthonyalexander/gomachine/internal/chess"
	"github.com/timanthonyalexander/gomachine/internal/engine"
	"github.com/timanthonyalexander/gomachine/internal/openings"
	"github.com/timanthonyalexander/gomachine/internal/syzygy"
)

// Server holds a bounded pool of engines (each with its own transposition
// table). A pool both bounds concurrent search load and keeps tables warm.
type Server struct {
	pool chan *engine.Engine
	book *book.Book // optional precomputed opening book (nil = disabled)
}

// SetBook attaches a loaded opening book; full-strength analysis paths consult it
// before searching. nil disables it.
func (s *Server) SetBook(b *book.Book) { s.book = b }

// SetTablebase attaches a Syzygy endgame tablebase to every pooled engine, so
// full-strength bot moves and analysis probe it at the root. Call once at startup
// before serving (it drains and refills the pool). The same handle is shared across
// engines — Fathom serializes its own probes. nil detaches.
func (s *Server) SetTablebase(tb *syzygy.Tablebase) {
	n := len(s.pool)
	for i := 0; i < n; i++ {
		e := <-s.pool
		e.SetTablebase(tb)
		s.pool <- e
	}
}

// bookHit returns a book entry for the position IF the book is loaded, the key is
// present, and the stored move is still legal here (movegen-validated, so a stale or
// wrong record can never yield an illegal move). The returned Move is the parsed,
// validated move.
func (s *Server) bookHit(pos *chess.Position) (book.Entry, chess.Move, bool) {
	if s.book == nil {
		return book.Entry{}, chess.NullMove, false
	}
	e, ok := s.book.Lookup(pos.Key())
	if !ok || len(e.PV) == 0 {
		return book.Entry{}, chess.NullMove, false
	}
	m, legal := pos.ParseUCIMove(e.PV[0])
	if !legal {
		return book.Entry{}, chess.NullMove, false
	}
	return e, m, true
}

// New builds a Server with `workers` engines of ttSizeMB megabytes each, every
// full-strength search running across `searchThreads` Lazy SMP workers. The pool
// (workers) parallelizes across concurrent requests; searchThreads parallelizes
// within one search — keep workers*searchThreads at/under the host's cores so a
// burst of analyses can't oversubscribe the box. searchThreads<=1 is serial.
func New(workers, ttSizeMB, searchThreads int) *Server {
	if workers < 1 {
		workers = 1
	}
	pool := make(chan *engine.Engine, workers)
	for i := 0; i < workers; i++ {
		pool <- engine.NewWithThreads(ttSizeMB, searchThreads)
	}
	return &Server{pool: pool}
}

func (s *Server) acquire() *engine.Engine  { return <-s.pool }
func (s *Server) release(e *engine.Engine) { s.pool <- e }

// Handler returns the configured HTTP mux.
func (s *Server) Handler() http.Handler {
	mux := http.NewServeMux()
	mux.HandleFunc("POST /move", s.handleMove)
	mux.HandleFunc("POST /legal-moves", s.handleLegalMoves)
	mux.HandleFunc("POST /bestmove", s.handleBestMove)
	mux.HandleFunc("POST /candidates", s.handleCandidates)
	mux.HandleFunc("POST /sf-bestmove", s.handleStockfishMove)
	mux.HandleFunc("POST /analyze-game", s.handleAnalyzeGame)
	mux.HandleFunc("POST /status", s.handleStatus)
	mux.HandleFunc("POST /perft", s.handlePerft)
	mux.HandleFunc("GET /healthz", s.handleHealth)
	return recoverPanics(mux)
}

// recoverPanics turns any handler panic into a clean 500 instead of a reset
// connection, keeping the service alive on unexpected input.
func recoverPanics(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		defer func() {
			if rec := recover(); rec != nil {
				writeErr(w, http.StatusInternalServerError, "internal engine error")
			}
		}()
		next.ServeHTTP(w, r)
	})
}

// parseLegal parses a FEN and rejects illegal positions (missing king, or the
// side not to move left in check) before they reach the search.
func parseLegal(w http.ResponseWriter, fen string) (*chess.Position, bool) {
	pos, err := chess.ParseFEN(fen)
	if err != nil {
		writeErr(w, http.StatusBadRequest, "invalid fen: "+err.Error())
		return nil, false
	}
	if !pos.Legal() {
		writeErr(w, http.StatusBadRequest, "illegal position: side not to move is in check, or a king is missing")
		return nil, false
	}
	return pos, true
}

// --- helpers ---

func writeJSON(w http.ResponseWriter, code int, v any) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(code)
	_ = json.NewEncoder(w).Encode(v)
}

func writeErr(w http.ResponseWriter, code int, msg string) {
	writeJSON(w, code, map[string]string{"error": msg})
}

func decode(w http.ResponseWriter, r *http.Request, v any) bool {
	if err := json.NewDecoder(r.Body).Decode(v); err != nil {
		writeErr(w, http.StatusBadRequest, "invalid JSON: "+err.Error())
		return false
	}
	return true
}

// historyKeys converts a slice of prior-position FENs into Zobrist keys,
// silently skipping any that fail to parse.
func historyKeys(fens []string) []uint64 {
	keys := make([]uint64, 0, len(fens))
	for _, f := range fens {
		if p, err := chess.ParseFEN(f); err == nil {
			keys = append(keys, p.Key())
		}
	}
	return keys
}

// bookEval builds the side-to-move-relative eval object from a book entry.
func bookEval(e book.Entry) map[string]any {
	if e.Mate != 0 {
		return map[string]any{"type": "mate", "value": e.Mate}
	}
	return map[string]any{"type": "cp", "value": e.Score}
}

func pvStrings(pv []chess.Move) []string {
	out := make([]string, len(pv))
	for i, m := range pv {
		out[i] = m.String()
	}
	return out
}

// openingFor names the line ending at pos given the prior-position FENs (root→
// previous), using our native-Zobrist opening table. Returns nil when no position
// along the line is a named opening (so the caller emits a null/absent field).
func openingFor(pos *chess.Position, historyFens []string) *openings.Opening {
	keys := historyKeys(historyFens)
	keys = append(keys, pos.Key())
	if o, ok := openings.Classify(keys); ok {
		return &o
	}
	return nil
}

// evalObject builds the {type, value} eval the frontend renders, from a
// side-to-move-relative score + signed mate distance (mate wins over cp).
func evalObject(score, mateIn int) map[string]any {
	if mateIn != 0 {
		return map[string]any{"type": "mate", "value": mateIn}
	}
	return map[string]any{"type": "cp", "value": score}
}

type candidatesRequest struct {
	FEN     string   `json:"fen"`
	History []string `json:"history"`
	Limits  struct {
		MultiPV  int `json:"multipv"`  // cap on returned moves (0 = all legal)
		Depth    int `json:"depth"`    // per-move search depth (0 = time-bounded)
		MoveTime int `json:"movetime"` // total budget, milliseconds
	} `json:"limits"`
}

// handleCandidates is the analysis board's "opening explorer": it returns the
// opening NAME for the current line plus a full-strength eval for EVERY legal move
// (ranked best-first), so the UI can draw a per-move eval bar. Stateless (FEN-in),
// like the rest of the engine API.
func (s *Server) handleCandidates(w http.ResponseWriter, r *http.Request) {
	var req candidatesRequest
	if !decode(w, r, &req) {
		return
	}
	pos, ok := parseLegal(w, req.FEN)
	if !ok {
		return
	}

	depth := req.Limits.Depth
	movetime := time.Duration(req.Limits.MoveTime) * time.Millisecond
	if depth <= 0 && movetime == 0 {
		movetime = 300 * time.Millisecond // sensible default for an interactive panel
	}

	eng := s.acquire()
	defer s.release(eng)

	cands := eng.MultiPV(pos, depth, movetime, historyKeys(req.History))
	if n := req.Limits.MultiPV; n > 0 && n < len(cands) {
		cands = cands[:n]
	}

	moves := make([]map[string]any, len(cands))
	for i, c := range cands {
		moves[i] = map[string]any{
			"uci":   c.Move.String(),
			"san":   pos.SAN(c.Move),
			"eval":  evalObject(c.Score, c.MateIn),
			"pv":    pvStrings(c.PV),
			"depth": c.Depth,
		}
	}
	writeJSON(w, http.StatusOK, map[string]any{
		"opening": openingFor(pos, req.History),
		"moves":   moves,
	})
}

// --- handlers ---

type moveRequest struct {
	FEN               string   `json:"fen"`
	Move              string   `json:"move"`
	History           []string `json:"history"`
	IncludeLegalMoves bool     `json:"includeLegalMoves"`
}

func (s *Server) handleMove(w http.ResponseWriter, r *http.Request) {
	var req moveRequest
	if !decode(w, r, &req) {
		return
	}
	pos, ok := parseLegal(w, req.FEN)
	if !ok {
		return
	}
	m, ok := pos.ParseUCIMove(req.Move)
	if !ok {
		writeJSON(w, http.StatusOK, map[string]any{"legal": false, "reason": "illegal move"})
		return
	}

	// history for the resulting position = prior history + the position we move from.
	hist := historyKeys(req.History)
	hist = append(hist, pos.Key())

	san := pos.SAN(m)
	var u chess.Undo
	pos.DoMove(m, &u)

	st := engine.Adjudicate(pos, hist)
	resp := map[string]any{
		"legal":          true,
		"newFen":         pos.FEN(),
		"san":            san,
		"status":         st.State,
		"sideToMove":     st.SideToMove,
		"check":          st.Check,
		"claimableDraws": st.ClaimableDraws,
	}
	if st.Result != "" {
		resp["result"] = st.Result
	}
	if req.IncludeLegalMoves {
		resp["legalMoves"] = pos.LegalMoveStrings(chess.SqNone)
	}
	writeJSON(w, http.StatusOK, resp)
}

type legalMovesRequest struct {
	FEN    string `json:"fen"`
	Square string `json:"square"`
}

func (s *Server) handleLegalMoves(w http.ResponseWriter, r *http.Request) {
	var req legalMovesRequest
	if !decode(w, r, &req) {
		return
	}
	pos, ok := parseLegal(w, req.FEN)
	if !ok {
		return
	}
	from := chess.SqNone
	if req.Square != "" {
		if sq, ok := chess.ParseSquare(req.Square); ok {
			from = sq
		}
	}
	moves := pos.LegalMoveStrings(from)
	writeJSON(w, http.StatusOK, map[string]any{"moves": moves, "count": len(moves)})
}

type bestMoveRequest struct {
	FEN     string   `json:"fen"`
	History []string `json:"history"`
	Limits  struct {
		Rating   *int `json:"rating"` // target Elo (rating-first bot strength); takes priority over level
		Level    *int `json:"level"`  // legacy 0..10 difficulty
		Depth    int  `json:"depth"`
		MoveTime int  `json:"movetime"` // milliseconds
	} `json:"limits"`
}

func (s *Server) handleBestMove(w http.ResponseWriter, r *http.Request) {
	var req bestMoveRequest
	if !decode(w, r, &req) {
		return
	}
	pos, ok := parseLegal(w, req.FEN)
	if !ok {
		return
	}

	// Full-strength analysis (no bot level/rating) can be served instantly from the
	// opening book — this is the start position re-searched on every analysis.
	if req.Limits.Rating == nil && req.Limits.Level == nil {
		if e, m, hit := s.bookHit(pos); hit {
			writeJSON(w, http.StatusOK, map[string]any{
				"bestmove": m.String(),
				"san":      pos.SAN(m),
				"eval":     bookEval(e),
				"pv":       e.PV,
				"depth":    e.Depth,
				"nodes":    0,
				"nps":      0,
				"level":    -1,
				"opening":  openingFor(pos, req.History),
			})
			return
		}
	}

	hist := historyKeys(req.History)

	eng := s.acquire()
	defer s.release(eng)

	start := time.Now()
	var res engine.BestResult
	switch {
	case req.Limits.Rating != nil:
		res = eng.BestMoveForRatingTimed(pos, *req.Limits.Rating,
			time.Duration(req.Limits.MoveTime)*time.Millisecond, hist)
	case req.Limits.Level != nil:
		res = eng.BestMove(pos, *req.Limits.Level, hist)
	case req.Limits.Depth > 0 || req.Limits.MoveTime > 0:
		res = eng.SearchDirect(pos, req.Limits.Depth, time.Duration(req.Limits.MoveTime)*time.Millisecond, hist)
	default:
		res = eng.SearchDirect(pos, 0, time.Second, hist) // 1s default
	}
	elapsed := time.Since(start)

	if res.Move == chess.NullMove {
		writeJSON(w, http.StatusOK, map[string]any{"bestmove": nil, "reason": "no legal moves"})
		return
	}

	evalObj := map[string]any{"type": "cp", "value": res.Score}
	if res.MateIn != 0 {
		evalObj = map[string]any{"type": "mate", "value": res.MateIn}
	}
	nps := 0
	if elapsed > 0 {
		nps = int(float64(res.Nodes) / elapsed.Seconds())
	}
	writeJSON(w, http.StatusOK, map[string]any{
		"bestmove": res.Move.String(),
		"san":      pos.SAN(res.Move),
		"eval":     evalObj,
		"pv":       pvStrings(res.PV),
		"depth":    res.Depth,
		"nodes":    res.Nodes,
		"nps":      nps,
		"level":    res.Level,
		"opening":  openingFor(pos, req.History),
	})
}

type statusRequest struct {
	FEN         string   `json:"fen"`
	History     []string `json:"history"`
	TimeoutSide string   `json:"timeoutSide"` // "w" or "b": apply FIDE 6.9 test
}

func (s *Server) handleStatus(w http.ResponseWriter, r *http.Request) {
	var req statusRequest
	if !decode(w, r, &req) {
		return
	}
	pos, ok := parseLegal(w, req.FEN)
	if !ok {
		return
	}
	hist := historyKeys(req.History)
	st := engine.Adjudicate(pos, hist)

	resp := map[string]any{
		"status":         st.State,
		"sideToMove":     st.SideToMove,
		"check":          st.Check,
		"claimableDraws": st.ClaimableDraws,
	}
	if st.Result != "" {
		resp["result"] = st.Result
	}

	// FIDE 6.9: a player who flags loses unless the opponent cannot mate by ANY
	// legal sequence, in which case it's a draw.
	if req.TimeoutSide == "w" || req.TimeoutSide == "b" {
		flagged := chess.White
		opponent := chess.Black
		if req.TimeoutSide == "b" {
			flagged, opponent = chess.Black, chess.White
		}
		if pos.CanAnyoneMate(opponent) {
			if opponent == chess.White {
				resp["status"], resp["result"] = "timeout", "1-0"
			} else {
				resp["status"], resp["result"] = "timeout", "0-1"
			}
			resp["reason"] = "timeout"
		} else {
			resp["status"], resp["result"] = "draw-timeout-vs-insufficient-material", "1/2-1/2"
			resp["reason"] = "timeout-vs-insufficient-material"
		}
		_ = flagged
	}
	writeJSON(w, http.StatusOK, resp)
}

type perftRequest struct {
	FEN    string `json:"fen"`
	Depth  int    `json:"depth"`
	Divide bool   `json:"divide"`
}

func (s *Server) handlePerft(w http.ResponseWriter, r *http.Request) {
	var req perftRequest
	if !decode(w, r, &req) {
		return
	}
	pos, ok := parseLegal(w, req.FEN)
	if !ok {
		return
	}
	if req.Depth < 1 || req.Depth > 8 {
		writeErr(w, http.StatusBadRequest, "depth must be 1..8")
		return
	}
	if req.Divide {
		div, total := chess.Divide(pos, req.Depth)
		writeJSON(w, http.StatusOK, map[string]any{"nodes": total, "divide": div})
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"nodes": chess.Perft(pos, req.Depth)})
}

func (s *Server) handleHealth(w http.ResponseWriter, r *http.Request) {
	writeJSON(w, http.StatusOK, map[string]any{"status": "ok"})
}
