package server

import (
	"net/http"
	"time"

	"github.com/timanthonyalexander/gomachine/internal/crazyhouse"
)

// Crazyhouse handlers. Crazyhouse is a self-contained variant
// (internal/crazyhouse) with its own rules + bot; it does not touch the standard
// engine pool. Every request is stateless: the Crazyhouse FEN is self-describing
// (it carries the [pocket]), so — unlike Duck — no separate auxiliary field is
// needed.

type crazyhouseLegalMovesRequest struct {
	FEN string `json:"fen"`
}

// handleCrazyhouseLegalMoves returns the legal moves (UCI, incl. drops "P@e4") for
// the side to move.
func (s *Server) handleCrazyhouseLegalMoves(w http.ResponseWriter, r *http.Request) {
	var req crazyhouseLegalMovesRequest
	if !decode(w, r, &req) {
		return
	}
	st, err := crazyhouse.Parse(req.FEN)
	if err != nil {
		writeErr(w, http.StatusBadRequest, err.Error())
		return
	}
	ms := st.LegalMoves()
	moves := make([]string, len(ms))
	for i, m := range ms {
		moves[i] = m.UCI()
	}
	writeJSON(w, http.StatusOK, map[string]any{"moves": moves})
}

type crazyhouseMoveRequest struct {
	FEN  string `json:"fen"`
	Move string `json:"move"` // "e2e4" / "e7e8q" / drop "P@e4"
}

// handleCrazyhouseMove validates and applies a move, returning the resulting
// position and its terminal status.
func (s *Server) handleCrazyhouseMove(w http.ResponseWriter, r *http.Request) {
	var req crazyhouseMoveRequest
	if !decode(w, r, &req) {
		return
	}
	st, err := crazyhouse.Parse(req.FEN)
	if err != nil {
		writeErr(w, http.StatusBadRequest, err.Error())
		return
	}
	ns, san, ok := st.ApplyUCI(req.Move)
	if !ok {
		writeJSON(w, http.StatusOK, map[string]any{"legal": false, "error": "illegal move: " + req.Move})
		return
	}
	writeJSON(w, http.StatusOK, crazyhouseResult(map[string]any{
		"legal": true,
		"san":   san,
	}, &ns))
}

type crazyhouseBestMoveRequest struct {
	FEN    string `json:"fen"`
	Limits struct {
		Rating   *int   `json:"rating"`
		Level    *int   `json:"level"`
		MoveTime int    `json:"movetime"` // milliseconds
		Nodes    uint64 `json:"nodes"`
		Depth    int    `json:"depth"`
	} `json:"limits"`
}

// handleCrazyhouseBestMove searches for and APPLIES the bot's best move, returning
// it plus the resulting position/status.
func (s *Server) handleCrazyhouseBestMove(w http.ResponseWriter, r *http.Request) {
	var req crazyhouseBestMoveRequest
	if !decode(w, r, &req) {
		return
	}
	st, err := crazyhouse.Parse(req.FEN)
	if err != nil {
		writeErr(w, http.StatusBadRequest, err.Error())
		return
	}

	lim := crazyhouse.DefaultLimits()
	if req.Limits.Rating != nil {
		lim.Rating = *req.Limits.Rating
	}
	if req.Limits.Level != nil {
		lim.Level = *req.Limits.Level
	}
	lim.Depth = req.Limits.Depth
	lim.Nodes = req.Limits.Nodes
	lim.MoveTime = time.Duration(req.Limits.MoveTime) * time.Millisecond

	res := crazyhouse.BestMove(st, lim)
	if !res.HasMove {
		writeJSON(w, http.StatusOK, crazyhouseResult(map[string]any{
			"bestmove": nil,
			"san":      nil,
			"eval":     nil,
			"reason":   "no legal moves",
		}, &st))
		return
	}

	ns, san, ok := st.ApplyUCI(res.Move)
	if !ok {
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
	writeJSON(w, http.StatusOK, crazyhouseResult(map[string]any{
		"bestmove": res.Move,
		"san":      san,
		"eval":     evalObj,
	}, &ns))
}

// crazyhouseResult merges position/status fields into a response map. It stamps
// newFen (canonical, incl. [pocket]), pocket, sideToMove, status and result — the
// shape shared by /crazyhouse/move and /crazyhouse/bestmove.
func crazyhouseResult(base map[string]any, st *crazyhouse.State) map[string]any {
	status := st.Status()
	base["newFen"] = st.FEN()
	base["pocket"] = st.PocketString()
	base["sideToMove"] = st.SideChar()
	base["status"] = crazyhouseStatusName(status)
	if res := status.Result(); res != "" {
		base["result"] = res
	} else {
		base["result"] = nil
	}
	return base
}

// crazyhouseStatusName maps the crazyhouse terminal status to the standard status
// vocabulary the frontend understands. A Crazyhouse win is always a checkmate (its
// only decisive result) — NOT a king capture (that is Duck) — so it must not reuse
// the raw "white_win"/"black_win" strings, which the client labels "king captured".
func crazyhouseStatusName(st crazyhouse.Status) string {
	switch st {
	case crazyhouse.WhiteWin, crazyhouse.BlackWin:
		return "checkmate"
	case crazyhouse.Draw:
		return "draw"
	default:
		return "ongoing"
	}
}
