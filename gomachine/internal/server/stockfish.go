package server

import (
	"net/http"
	"os"
	"os/exec"
	"strconv"
	"time"

	"github.com/timanthonyalexander/gomachine/internal/bench"
)

// stockfishPath resolves the Stockfish binary: $STOCKFISH_PATH, then a PATH
// lookup, then common absolute locations. The last step matters in production:
// the Go service runs under systemd with a MINIMAL PATH that usually omits
// `/usr/games` (Debian/Ubuntu's apt install dir), so `exec.LookPath` fails there
// even though `which stockfish` works in an interactive shell. Empty if not found.
func stockfishPath() string {
	if p := os.Getenv("STOCKFISH_PATH"); p != "" {
		return p
	}
	if p, err := exec.LookPath("stockfish"); err == nil {
		return p
	}
	for _, p := range []string{
		"/usr/games/stockfish", // Debian/Ubuntu (apt) — not on systemd's PATH
		"/usr/local/bin/stockfish",
		"/opt/homebrew/bin/stockfish", // macOS, Apple Silicon
		"/usr/bin/stockfish",
		"/bin/stockfish",
	} {
		if fi, err := os.Stat(p); err == nil && !fi.IsDir() {
			return p
		}
	}
	return ""
}

type sfMoveRequest struct {
	FEN      string `json:"fen"`
	Elo      int    `json:"elo"`      // UCI_Elo (1320..3190); <=0 = full strength
	MoveTime int    `json:"movetime"` // ms; default 100
}

// handleStockfishMove returns Stockfish's move at a target UCI_Elo, for the admin
// "engine vs engine" view. It spawns a fresh Stockfish per call (stateless, like
// the rest of the engine's FEN-in contract) — fine for a low-rate watch feature.
func (s *Server) handleStockfishMove(w http.ResponseWriter, r *http.Request) {
	var req sfMoveRequest
	if !decode(w, r, &req) {
		return
	}
	pos, ok := parseLegal(w, req.FEN)
	if !ok {
		return
	}
	path := stockfishPath()
	if path == "" {
		writeJSON(w, http.StatusServiceUnavailable,
			map[string]any{"error": "stockfish not found (set STOCKFISH_PATH or add it to PATH)"})
		return
	}

	opts := map[string]string{}
	if req.Elo > 0 {
		opts["UCI_LimitStrength"] = "true"
		opts["UCI_Elo"] = strconv.Itoa(req.Elo)
	}
	sf, err := bench.StartUCI(path, opts)
	if err != nil {
		writeJSON(w, http.StatusBadGateway, map[string]any{"error": "stockfish start: " + err.Error()})
		return
	}
	defer sf.Close()

	mt := time.Duration(req.MoveTime) * time.Millisecond
	if mt <= 0 {
		mt = 100 * time.Millisecond
	}
	uci, err := sf.BestMove(req.FEN, nil, bench.UCIBudget{MoveTime: mt})
	if err != nil {
		writeJSON(w, http.StatusBadGateway, map[string]any{"error": "stockfish move: " + err.Error()})
		return
	}
	mv, okm := pos.ParseUCIMove(uci)
	if !okm {
		writeJSON(w, http.StatusOK, map[string]any{"bestmove": nil, "reason": "no legal move"})
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"bestmove": uci, "san": pos.SAN(mv)})
}
