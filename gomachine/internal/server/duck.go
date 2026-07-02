package server

import (
	"net/http"
	"time"

	"github.com/timanthonyalexander/gomachine/internal/duckchess"
)

// Duck Chess handlers. Duck Chess is a self-contained variant (internal/duckchess)
// with its own rules + shallow bot; it does not touch the standard engine pool.
// Every request is stateless: it carries the full position (FEN + duck square).

type duckLegalMovesRequest struct {
	FEN  string `json:"fen"`
	Duck string `json:"duck"` // "" if the duck is not yet placed
}

// handleDuckLegalMoves returns the legal PIECE moves (UCI) for the side to move.
// There is NO self-check filter and king-captures ARE included; duck target
// squares are the client's to compute (any empty square != the current duck).
func (s *Server) handleDuckLegalMoves(w http.ResponseWriter, r *http.Request) {
	var req duckLegalMovesRequest
	if !decode(w, r, &req) {
		return
	}
	st, err := duckchess.Parse(req.FEN, req.Duck)
	if err != nil {
		writeErr(w, http.StatusBadRequest, err.Error())
		return
	}
	pms := st.LegalPieceMoves()
	moves := make([]string, len(pms))
	for i, m := range pms {
		moves[i] = m.UCI()
	}
	writeJSON(w, http.StatusOK, map[string]any{"moves": moves})
}

type duckMoveRequest struct {
	FEN  string `json:"fen"`
	Duck string `json:"duck"`
	Move string `json:"move"` // "<pieceUCI>:<duckSquare>"
}

// handleDuckMove validates and applies a composite move, returning the resulting
// position and its terminal status.
func (s *Server) handleDuckMove(w http.ResponseWriter, r *http.Request) {
	var req duckMoveRequest
	if !decode(w, r, &req) {
		return
	}
	st, err := duckchess.Parse(req.FEN, req.Duck)
	if err != nil {
		writeErr(w, http.StatusBadRequest, err.Error())
		return
	}
	ns, pm, status, err := st.ApplyComposite(req.Move)
	if err != nil {
		writeJSON(w, http.StatusOK, map[string]any{"legal": false, "error": err.Error()})
		return
	}
	writeJSON(w, http.StatusOK, duckResult(map[string]any{
		"legal": true,
		"san":   st.SAN(pm, ns.Duck()),
	}, &ns, status))
}

type duckBestMoveRequest struct {
	FEN    string `json:"fen"`
	Duck   string `json:"duck"`
	Limits struct {
		Rating   *int   `json:"rating"`
		Level    *int   `json:"level"`
		MoveTime int    `json:"movetime"` // milliseconds
		Nodes    uint64 `json:"nodes"`
		Depth    int    `json:"depth"`
	} `json:"limits"`
}

// handleDuckBestMove searches for and APPLIES the bot's best composite move,
// returning it plus the resulting position/status.
func (s *Server) handleDuckBestMove(w http.ResponseWriter, r *http.Request) {
	var req duckBestMoveRequest
	if !decode(w, r, &req) {
		return
	}
	st, err := duckchess.Parse(req.FEN, req.Duck)
	if err != nil {
		writeErr(w, http.StatusBadRequest, err.Error())
		return
	}

	lim := duckchess.DefaultLimits()
	if req.Limits.Rating != nil {
		lim.Rating = *req.Limits.Rating
	}
	if req.Limits.Level != nil {
		lim.Level = *req.Limits.Level
	}
	lim.Depth = req.Limits.Depth
	lim.Nodes = req.Limits.Nodes
	lim.MoveTime = time.Duration(req.Limits.MoveTime) * time.Millisecond

	res := duckchess.BestMove(st, lim)
	if !res.HasMove {
		writeJSON(w, http.StatusOK, duckResult(map[string]any{
			"bestmove": nil,
			"san":      nil,
			"eval":     nil,
			"reason":   "no legal moves",
		}, &st, st.Status()))
		return
	}

	san := st.SAN(res.Move, res.Duck)
	ns, _, status, applyErr := st.ApplyComposite(res.MoveString())
	if applyErr != nil {
		// Defensive: the search must only ever return a legal move.
		writeErr(w, http.StatusInternalServerError, "search produced an illegal move")
		return
	}

	var evalObj any
	if res.Mate != 0 {
		evalObj = map[string]any{"type": "mate", "value": res.Mate}
	} else {
		evalObj = map[string]any{"type": "cp", "value": res.Score}
	}
	writeJSON(w, http.StatusOK, duckResult(map[string]any{
		"bestmove": res.MoveString(),
		"san":      san,
		"eval":     evalObj,
	}, &ns, status))
}

// duckResult merges position/status fields into a response map. It stamps newFen,
// duck, sideToMove, status and result — the shape shared by /duck/move and
// /duck/bestmove.
func duckResult(base map[string]any, st *duckchess.State, status duckchess.Status) map[string]any {
	base["newFen"] = st.FEN()
	base["duck"] = st.DuckString()
	base["sideToMove"] = st.SideChar()
	base["status"] = string(status)
	if res := status.Result(); res != "" {
		base["result"] = res
	} else {
		base["result"] = nil
	}
	return base
}
