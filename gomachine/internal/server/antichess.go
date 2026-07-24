package server

import (
	"net/http"
	"time"

	"github.com/timanthonyalexander/gomachine/internal/antichess"
)

// Antichess handlers. Antichess (Losing Chess / Räuberschach) is a self-contained
// variant (internal/antichess) with its own rules + bot; it does not touch the
// standard engine pool. Every request is stateless: the FEN is self-describing
// (no pockets, no duck square), so — like Crazyhouse — no auxiliary field is
// needed. This mirrors the shape zugzwang's /antichess/* endpoints serve, so the
// admin Engine-vs-Engine view can run gomachine on either side of an Antichess
// game with no cross-engine fallback.

type antichessLegalMovesRequest struct {
	FEN string `json:"fen"`
}

// handleAntichessLegalMoves returns the legal moves (UCI; a king-promotion suffix
// "k" may appear alongside q/r/b/n) for the side to move.
func (s *Server) handleAntichessLegalMoves(w http.ResponseWriter, r *http.Request) {
	var req antichessLegalMovesRequest
	if !decode(w, r, &req) {
		return
	}
	st, err := antichess.Parse(req.FEN)
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

type antichessMoveRequest struct {
	FEN  string `json:"fen"`
	Move string `json:"move"` // "e2e4" / "e7e8q" / king-promo "e7e8k"
}

// handleAntichessMove validates and applies a move, returning the resulting
// position and its terminal status.
func (s *Server) handleAntichessMove(w http.ResponseWriter, r *http.Request) {
	var req antichessMoveRequest
	if !decode(w, r, &req) {
		return
	}
	st, err := antichess.Parse(req.FEN)
	if err != nil {
		writeErr(w, http.StatusBadRequest, err.Error())
		return
	}
	ns, san, ok := st.Apply(req.Move)
	if !ok {
		writeJSON(w, http.StatusOK, map[string]any{"legal": false, "error": "illegal move: " + req.Move})
		return
	}
	writeJSON(w, http.StatusOK, antichessResult(map[string]any{
		"legal": true,
		"san":   san,
	}, &ns))
}

type antichessBestMoveRequest struct {
	FEN    string `json:"fen"`
	Limits struct {
		Rating   *int   `json:"rating"`
		Level    *int   `json:"level"`
		MoveTime int    `json:"movetime"` // milliseconds
		Nodes    uint64 `json:"nodes"`
		Depth    int    `json:"depth"`
	} `json:"limits"`
}

// handleAntichessBestMove searches for and APPLIES the bot's best move, returning
// it plus the resulting position/status.
func (s *Server) handleAntichessBestMove(w http.ResponseWriter, r *http.Request) {
	var req antichessBestMoveRequest
	if !decode(w, r, &req) {
		return
	}
	st, err := antichess.Parse(req.FEN)
	if err != nil {
		writeErr(w, http.StatusBadRequest, err.Error())
		return
	}

	lim := antichess.DefaultLimits()
	if req.Limits.Rating != nil {
		lim.Rating = *req.Limits.Rating
	}
	if req.Limits.Level != nil {
		lim.Level = *req.Limits.Level
	}
	lim.Depth = req.Limits.Depth
	lim.Nodes = req.Limits.Nodes
	lim.MoveTime = time.Duration(req.Limits.MoveTime) * time.Millisecond

	res := antichess.BestMove(st, lim)
	if !res.HasMove {
		writeJSON(w, http.StatusOK, antichessResult(map[string]any{
			"bestmove": nil,
			"san":      nil,
			"eval":     nil,
			"reason":   "no legal moves",
		}, &st))
		return
	}

	ns, san, ok := st.Apply(res.Move)
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
	writeJSON(w, http.StatusOK, antichessResult(map[string]any{
		"bestmove": res.Move,
		"san":      san,
		"eval":     evalObj,
	}, &ns))
}

// antichessResult merges position/status fields into a response map. It stamps
// newFen, sideToMove, status and result — the shape shared by /antichess/move and
// /antichess/bestmove. Antichess terminal statuses are its own "white_win"/
// "black_win"/"draw" vocabulary (a win = the OPPONENT ran out of pieces/moves),
// matching zugzwang's endpoint and the frontend's antichess labels.
func antichessResult(base map[string]any, st *antichess.State) map[string]any {
	status := st.Status()
	base["newFen"] = st.FEN()
	base["sideToMove"] = st.SideChar()
	base["status"] = string(status)
	if res := status.Result(); res != "" {
		base["result"] = res
	} else {
		base["result"] = nil
	}
	return base
}
