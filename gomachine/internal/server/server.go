// Package server exposes the gomachine engine over a stateless localhost HTTP/
// JSON API (SPEC §7.3). Every request carries the full position (FEN); the
// service keeps the magic tables and transposition tables warm across requests.
// PHP/BaseAPI remains the single source of truth for game persistence.
package server

import (
	"encoding/json"
	"net/http"
	"time"

	"github.com/timanthonyalexander/gomachine/internal/chess"
	"github.com/timanthonyalexander/gomachine/internal/engine"
)

// Server holds a bounded pool of engines (each with its own transposition
// table). A pool both bounds concurrent search load and keeps tables warm.
type Server struct {
	pool chan *engine.Engine
}

// New builds a Server with `workers` engines of ttSizeMB megabytes each.
func New(workers, ttSizeMB int) *Server {
	if workers < 1 {
		workers = 1
	}
	pool := make(chan *engine.Engine, workers)
	for i := 0; i < workers; i++ {
		pool <- engine.New(ttSizeMB)
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
	mux.HandleFunc("POST /status", s.handleStatus)
	mux.HandleFunc("POST /perft", s.handlePerft)
	mux.HandleFunc("GET /healthz", s.handleHealth)
	return mux
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

func pvStrings(pv []chess.Move) []string {
	out := make([]string, len(pv))
	for i, m := range pv {
		out[i] = m.String()
	}
	return out
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
	pos, err := chess.ParseFEN(req.FEN)
	if err != nil {
		writeErr(w, http.StatusBadRequest, "invalid fen: "+err.Error())
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
	pos, err := chess.ParseFEN(req.FEN)
	if err != nil {
		writeErr(w, http.StatusBadRequest, "invalid fen: "+err.Error())
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
		Level    *int `json:"level"`
		Depth    int  `json:"depth"`
		MoveTime int  `json:"movetime"` // milliseconds
	} `json:"limits"`
}

func (s *Server) handleBestMove(w http.ResponseWriter, r *http.Request) {
	var req bestMoveRequest
	if !decode(w, r, &req) {
		return
	}
	pos, err := chess.ParseFEN(req.FEN)
	if err != nil {
		writeErr(w, http.StatusBadRequest, "invalid fen: "+err.Error())
		return
	}
	hist := historyKeys(req.History)

	eng := s.acquire()
	defer s.release(eng)

	start := time.Now()
	var res engine.BestResult
	switch {
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
	pos, err := chess.ParseFEN(req.FEN)
	if err != nil {
		writeErr(w, http.StatusBadRequest, "invalid fen: "+err.Error())
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
	pos, err := chess.ParseFEN(req.FEN)
	if err != nil {
		writeErr(w, http.StatusBadRequest, "invalid fen: "+err.Error())
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
