package hub

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"strings"
	"time"

	"github.com/timanthonyalexander/gomachine/internal/chess"
	"github.com/timanthonyalexander/gomachine/internal/engine"
)

// zugzwangClient is a thin HTTP client for zugzwang's stateless /bestmove
// endpoint (zugzwang/WIRING_RECON.md §A) — the hub's bot-move + watch-filler
// compute backend since 2026-07-14. It mirrors app/Services/GomachineClient
// ::bestMove's wire shape (zugzwang serves the identical contract), and maps
// the response back into an engine.BestResult so callers (computeBotMove)
// don't need to know which backend answered.
type zugzwangClient struct {
	baseURL string
	timeout time.Duration // single source of truth: both http.Client's own Timeout AND the deadline callers should give each retry attempt (Timeout())
	http    *http.Client
}

// newZugzwangClient builds a client bound to baseURL with a per-request
// timeout, applied both as the http.Client's own Timeout (a backstop) and —
// via Timeout() — as the deadline computeBotMove's retry loop puts on each
// attempt's context.Context, so there is exactly one timeout knob, not two
// that could silently disagree.
func newZugzwangClient(baseURL string, timeout time.Duration) *zugzwangClient {
	return &zugzwangClient{
		baseURL: strings.TrimRight(baseURL, "/"),
		timeout: timeout,
		http:    &http.Client{Timeout: timeout},
	}
}

// Timeout returns the per-attempt timeout this client was configured with.
func (z *zugzwangClient) Timeout() time.Duration { return z.timeout }

// zugzwangBestMoveResponse is the /bestmove response shape
// (zugzwang/src/serve_handlers.cpp best_move, ~line 318): bestmove is null
// (with reason set) when there's no legal move.
type zugzwangBestMoveResponse struct {
	BestMove *string `json:"bestmove"`
	San      string  `json:"san"`
	Eval     struct {
		Type  string `json:"type"`
		Value int    `json:"value"`
	} `json:"eval"`
	PV     []string `json:"pv"`
	Depth  int      `json:"depth"`
	Nodes  uint64   `json:"nodes"`
	Level  int      `json:"level"`
	Reason string   `json:"reason"`
	Error  string   `json:"error"`
}

// BestMove asks zugzwang for a move at a target rating, with optional
// movetime/depth caps and prior-position FEN history for repetition
// awareness — the SAME rating/caps the hub already computes today
// (humanizedEngineRating, fillerMoveTimeCap/fillerSearchDepth); zugzwang has
// ported configForRating, so it does its own weakening from the rating alone.
//
// A nil error with a zero engine.BestResult.Move means "zugzwang answered,
// there's genuinely no legal move" (e.g. the position is already terminal) —
// NOT a transport failure, so the caller must not treat it as one (no retry,
// no emergency fallback). Any other problem (network, timeout, bad JSON, an
// HTTP error status, or an illegal/unparseable bestmove) comes back as a
// non-nil error.
func (z *zugzwangClient) BestMove(ctx context.Context, fen string, fenHistory []string, rating int, movetimeCap time.Duration, depthCap int) (engine.BestResult, error) {
	limits := map[string]any{"rating": rating}
	if depthCap > 0 {
		limits["depth"] = depthCap
	}
	if movetimeCap > 0 {
		limits["movetime"] = int(movetimeCap / time.Millisecond)
	}
	body, err := json.Marshal(map[string]any{
		"fen":     fen,
		"history": fenHistory,
		"limits":  limits,
	})
	if err != nil {
		return engine.BestResult{}, fmt.Errorf("zugzwang: marshal request: %w", err)
	}

	req, err := http.NewRequestWithContext(ctx, http.MethodPost, z.baseURL+"/bestmove", bytes.NewReader(body))
	if err != nil {
		return engine.BestResult{}, fmt.Errorf("zugzwang: build request: %w", err)
	}
	req.Header.Set("Content-Type", "application/json")

	resp, err := z.http.Do(req)
	if err != nil {
		return engine.BestResult{}, fmt.Errorf("zugzwang: request: %w", err)
	}
	defer resp.Body.Close()

	var out zugzwangBestMoveResponse
	if err := json.NewDecoder(resp.Body).Decode(&out); err != nil {
		return engine.BestResult{}, fmt.Errorf("zugzwang: decode response: %w", err)
	}
	if resp.StatusCode >= 300 {
		msg := out.Error
		if msg == "" {
			msg = fmt.Sprintf("status %d", resp.StatusCode)
		}
		return engine.BestResult{}, fmt.Errorf("zugzwang: %s", msg)
	}
	if out.BestMove == nil || *out.BestMove == "" {
		// Genuinely no legal move (e.g. checkmate/stalemate) — not a failure.
		return engine.BestResult{}, nil
	}

	// zugzwang answers with a UCI string, not a chess.Move — reparse against the
	// SAME fen we sent (stateless, so this is cheap) to validate it and get a
	// chess.Move, exactly like gomachine's own /sf-bestmove proxy does for
	// Stockfish's UCI reply (internal/server/stockfish.go).
	pos, perr := chess.ParseFEN(fen)
	if perr != nil {
		return engine.BestResult{}, fmt.Errorf("zugzwang: re-parsing fen %q for move validation: %w", fen, perr)
	}
	move, ok := pos.ParseUCIMove(*out.BestMove)
	if !ok {
		return engine.BestResult{}, fmt.Errorf("zugzwang: illegal/unparseable bestmove %q for fen %q", *out.BestMove, fen)
	}

	return engine.BestResult{
		Move:  move,
		Score: out.Eval.Value,
		Depth: out.Depth,
		Nodes: out.Nodes,
		Level: out.Level,
	}, nil
}

// crazyhouseBestMoveResponse is zugzwang's /crazyhouse/bestmove response
// shape (zugzwang/src/serve_handlers.cpp crazyhouse_best_move — mirrors
// gomachine's own internal/server/crazyhouse.go handleCrazyhouseBestMove):
// bestmove is null (with reason set) when there's no legal move.
type crazyhouseBestMoveResponse struct {
	BestMove *string `json:"bestmove"`
	Reason   string  `json:"reason"`
	Error    string  `json:"error"`
}

// CrazyhouseBestMove asks zugzwang's self-contained Crazyhouse engine
// (its own pockets/drops/eval — NOT the shared standard-chess NNUE search,
// see zugzwang/src/crazyhouse.h) for a move at a target rating. fen is the
// CANONICAL Crazyhouse FEN (carries the [pocket], self-describing — no
// separate history/extras needed, unlike Duck).
//
// A nil error with an empty move string means "zugzwang answered, there's
// genuinely no legal move" (position already terminal) — not a transport
// failure, mirroring zugzwangClient.BestMove's doc — so the caller must not
// retry or fall back to the emergency in-process path for that case.
func (z *zugzwangClient) CrazyhouseBestMove(ctx context.Context, fen string, rating int) (string, error) {
	body, err := json.Marshal(map[string]any{
		"fen":    fen,
		"limits": map[string]any{"rating": rating},
	})
	if err != nil {
		return "", fmt.Errorf("zugzwang: marshal crazyhouse request: %w", err)
	}

	req, err := http.NewRequestWithContext(ctx, http.MethodPost, z.baseURL+"/crazyhouse/bestmove", bytes.NewReader(body))
	if err != nil {
		return "", fmt.Errorf("zugzwang: build crazyhouse request: %w", err)
	}
	req.Header.Set("Content-Type", "application/json")

	resp, err := z.http.Do(req)
	if err != nil {
		return "", fmt.Errorf("zugzwang: crazyhouse request: %w", err)
	}
	defer resp.Body.Close()

	var out crazyhouseBestMoveResponse
	if err := json.NewDecoder(resp.Body).Decode(&out); err != nil {
		return "", fmt.Errorf("zugzwang: decode crazyhouse response: %w", err)
	}
	if resp.StatusCode >= 300 {
		msg := out.Error
		if msg == "" {
			msg = fmt.Sprintf("status %d", resp.StatusCode)
		}
		return "", fmt.Errorf("zugzwang: crazyhouse: %s", msg)
	}
	if out.BestMove == nil || *out.BestMove == "" {
		return "", nil // genuinely no legal move
	}
	return *out.BestMove, nil
}

// Healthy reports whether zugzwang answers GET /healthz within a short
// timeout. Best-effort, safe to call from any goroutine (a fresh request,
// no shared state).
func (z *zugzwangClient) Healthy(ctx context.Context) bool {
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, z.baseURL+"/healthz", nil)
	if err != nil {
		return false
	}
	resp, err := z.http.Do(req)
	if err != nil {
		return false
	}
	defer resp.Body.Close()
	return resp.StatusCode == http.StatusOK
}
