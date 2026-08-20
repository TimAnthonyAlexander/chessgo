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
// (fillerMoveTimeCap/fillerSearchDepth); the rating is the human/FIDE-scale
// display rating forwarded as-is — zugzwang's own ladder does the weakening.
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

	res := engine.BestResult{
		Move:  move,
		Score: out.Eval.Value,
		Depth: out.Depth,
		Nodes: out.Nodes,
		Level: out.Level,
	}
	// zugzwang's eval object is a TAGGED union: {"type":"mate","value":N} carries a
	// signed mate DISTANCE IN MOVES, not centipawns (zugzwang/src/serve_json.h's
	// eval_json). Reading Value without its Type makes "mated in 2" indistinguishable
	// from "−2 centipawns" — i.e. from dead equal — so anything deciding on the score
	// must get the mate case separated out here, at the boundary, rather than each
	// caller remembering to ask. Score is normalized to a mate-magnitude centipawn so
	// one signed number stays comparable; MateIn keeps the exact distance.
	if out.Eval.Type == "mate" {
		res.MateIn = out.Eval.Value
		res.Score = mateScoreCp(out.Eval.Value)
	}
	return res, nil
}

// mateScoreCp renders a signed mate distance as a centipawn score far outside any
// real evaluation, so callers comparing scores need no special case: mating is
// hugely positive, being mated hugely negative, and a shorter mate outranks a
// longer one. Mirrors the usual VALUE_MATE-minus-distance convention.
func mateScoreCp(mateIn int) int {
	const mateBase = 100_000
	if mateIn > 0 {
		return mateBase - mateIn
	}
	if mateIn < 0 {
		return -mateBase - mateIn
	}
	return 0
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

// duckBestMoveResponse is zugzwang's /duck/bestmove response shape
// (zugzwang/src/serve_handlers.cpp duck_bestmove — mirrors gomachine's own
// internal/server/duck.go handleDuckBestMove): bestmove is null (with reason
// set) when there's no legal move. Unlike CrazyhouseBestMove, the composite
// move is NOT self-describing in the FEN — the caller needs the resulting
// `duck` square back too (game.applyMove/variant.duckState.Apply parses the
// composite "<pieceUCI>:<duckSquare>" move string itself, so returning just
// the move string is sufficient; `duck` here is read only for a defensive
// sanity check, see below).
type duckBestMoveResponse struct {
	BestMove *string `json:"bestmove"`
	Duck     string  `json:"duck"`
	Reason   string  `json:"reason"`
	Error    string  `json:"error"`
}

// DuckBestMove asks zugzwang's self-contained Duck Chess engine (its own
// board/hand-eval/search — NOT the shared standard-chess NNUE search, see
// zugzwang/src/duck.h) for a move at a target rating. `fen` is the standard
// board FEN (Duck's duck square rides separately — it is NOT part of the
// FEN, unlike Crazyhouse's self-describing pocket), `duck` is the duck's
// current square ("" if not yet placed, mirrors duckState.Extras()["duck"]).
//
// A nil error with an empty move string means "zugzwang answered, there's
// genuinely no legal move" (position already terminal, e.g. a king already
// captured) — not a transport failure, mirroring CrazyhouseBestMove's doc —
// so the caller must not retry or fall back to the emergency in-process path
// for that case.
func (z *zugzwangClient) DuckBestMove(ctx context.Context, fen, duck string, rating int) (string, error) {
	body, err := json.Marshal(map[string]any{
		"fen":    fen,
		"duck":   duck,
		"limits": map[string]any{"rating": rating},
	})
	if err != nil {
		return "", fmt.Errorf("zugzwang: marshal duck request: %w", err)
	}

	req, err := http.NewRequestWithContext(ctx, http.MethodPost, z.baseURL+"/duck/bestmove", bytes.NewReader(body))
	if err != nil {
		return "", fmt.Errorf("zugzwang: build duck request: %w", err)
	}
	req.Header.Set("Content-Type", "application/json")

	resp, err := z.http.Do(req)
	if err != nil {
		return "", fmt.Errorf("zugzwang: duck request: %w", err)
	}
	defer resp.Body.Close()

	var out duckBestMoveResponse
	if err := json.NewDecoder(resp.Body).Decode(&out); err != nil {
		return "", fmt.Errorf("zugzwang: decode duck response: %w", err)
	}
	if resp.StatusCode >= 300 {
		msg := out.Error
		if msg == "" {
			msg = fmt.Sprintf("status %d", resp.StatusCode)
		}
		return "", fmt.Errorf("zugzwang: duck: %s", msg)
	}
	if out.BestMove == nil || *out.BestMove == "" {
		return "", nil // genuinely no legal move
	}
	return *out.BestMove, nil
}

// antichessBestMoveResponse is zugzwang's /antichess/bestmove response shape
// (zugzwang/src/serve_handlers.cpp antichess_best_move): bestmove is null
// (with reason set) when there's no legal move. The response also carries the
// resulting position for parity with the other self-contained variants'
// endpoints, but the hub only needs bestmove — game.applyMove/
// variant.antichessState.Apply replays the move itself.
type antichessBestMoveResponse struct {
	BestMove *string `json:"bestmove"`
	San      string  `json:"san"`
	Eval     struct {
		Type  string `json:"type"`
		Value int    `json:"value"`
	} `json:"eval"`
	NewFen     string `json:"newFen"`
	SideToMove string `json:"sideToMove"`
	Status     string `json:"status"`
	Result     string `json:"result"`
	Reason     string `json:"reason"`
	Error      string `json:"error"`
}

// AntichessBestMove asks zugzwang's self-contained Antichess engine (its own
// forced-capture rules/eval/search — NOT the shared standard-chess NNUE
// search, see zugzwang/src/antichess.h) for a move at a target rating. fen is
// the CANONICAL Antichess FEN — standard-shape and self-describing (no
// pockets, no duck square), so the request is just {fen, limits}, simpler
// than Duck's (which needs the separate duck square) and identical in shape
// to Crazyhouse's.
//
// A nil error with an empty move string means "zugzwang answered, there's
// genuinely no legal move" (position already terminal — the side to move has
// won by Antichess's inverted rule) — not a transport failure, mirroring
// CrazyhouseBestMove/DuckBestMove's doc — so the caller must not retry or
// fall back to the emergency in-process path for that case.
func (z *zugzwangClient) AntichessBestMove(ctx context.Context, fen string, rating int) (string, error) {
	body, err := json.Marshal(map[string]any{
		"fen":    fen,
		"limits": map[string]any{"rating": rating},
	})
	if err != nil {
		return "", fmt.Errorf("zugzwang: marshal antichess request: %w", err)
	}

	req, err := http.NewRequestWithContext(ctx, http.MethodPost, z.baseURL+"/antichess/bestmove", bytes.NewReader(body))
	if err != nil {
		return "", fmt.Errorf("zugzwang: build antichess request: %w", err)
	}
	req.Header.Set("Content-Type", "application/json")

	resp, err := z.http.Do(req)
	if err != nil {
		return "", fmt.Errorf("zugzwang: antichess request: %w", err)
	}
	defer resp.Body.Close()

	var out antichessBestMoveResponse
	if err := json.NewDecoder(resp.Body).Decode(&out); err != nil {
		return "", fmt.Errorf("zugzwang: decode antichess response: %w", err)
	}
	if resp.StatusCode >= 300 {
		msg := out.Error
		if msg == "" {
			msg = fmt.Sprintf("status %d", resp.StatusCode)
		}
		return "", fmt.Errorf("zugzwang: antichess: %s", msg)
	}
	if out.BestMove == nil || *out.BestMove == "" {
		return "", nil // genuinely no legal move
	}
	return *out.BestMove, nil
}

// secretQueenBestMoveResponse is zugzwang's /secretqueen/bestmove response
// shape (zugzwang/src/serve_handlers.cpp): bestmove is null (with reason set)
// when there's no legal move. Only bestmove is read here — applying it goes
// through variant.HiddenState.Apply (internal/variant/secretqueen.go), which
// has its OWN separate HTTP client to zugzwang (that package can't import
// this one — see secretqueen.go's package doc for why). This one, living
// here, is used only for the bot's move CHOICE (bot.go's selfSearchMove),
// mirroring AntichessBestMove/CrazyhouseBestMove/DuckBestMove exactly.
type secretQueenBestMoveResponse struct {
	BestMove *string `json:"bestmove"`
	Reason   string  `json:"reason"`
	Error    string  `json:"error"`
}

// SecretQueenBestMove asks zugzwang's Secret Queen bot (its own NNUE search
// running in the bot's own information set — zugzwang/src/secretqueen_bot.h)
// for a move at a target rating. fen is the CANONICAL Secret Queen FEN
// (carries whichever secret squares are still hidden — self-describing, no
// separate extras needed, like Crazyhouse/Antichess).
//
// A nil error with an empty move string means "zugzwang answered, there's
// genuinely no legal move" (the game already ended by king capture or the
// no-legal-move draw) — not a transport failure, mirroring the other three
// BestMove methods' doc — so the caller must not retry. There is no
// emergency in-process fallback for this variant at all (see
// internal/variant/secretqueen.go's package doc): it never had a Go rules
// implementation to fall back to.
func (z *zugzwangClient) SecretQueenBestMove(ctx context.Context, fen string, rating int) (string, error) {
	body, err := json.Marshal(map[string]any{
		"fen":    fen,
		"limits": map[string]any{"rating": rating},
	})
	if err != nil {
		return "", fmt.Errorf("zugzwang: marshal secretqueen request: %w", err)
	}

	req, err := http.NewRequestWithContext(ctx, http.MethodPost, z.baseURL+"/secretqueen/bestmove", bytes.NewReader(body))
	if err != nil {
		return "", fmt.Errorf("zugzwang: build secretqueen request: %w", err)
	}
	req.Header.Set("Content-Type", "application/json")

	resp, err := z.http.Do(req)
	if err != nil {
		return "", fmt.Errorf("zugzwang: secretqueen request: %w", err)
	}
	defer resp.Body.Close()

	var out secretQueenBestMoveResponse
	if err := json.NewDecoder(resp.Body).Decode(&out); err != nil {
		return "", fmt.Errorf("zugzwang: decode secretqueen response: %w", err)
	}
	if resp.StatusCode >= 300 {
		msg := out.Error
		if msg == "" {
			msg = fmt.Sprintf("status %d", resp.StatusCode)
		}
		return "", fmt.Errorf("zugzwang: secretqueen: %s", msg)
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
