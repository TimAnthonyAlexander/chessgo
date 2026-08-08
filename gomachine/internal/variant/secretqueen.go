package variant

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

// SecretQueen is the variant id (docs/tasks/open/secret-queen.md). Unlike
// every other entry in this package, it has NO Go rules implementation at
// all — see secretqueenState's doc below for why, and the cost that buys.
const SecretQueen = "secretqueen"

// --- the out-of-process backend ---
//
// secretQueenBaseURL/secretQueenHTTPClient are a tiny, dedicated HTTP client
// to zugzwang's /secretqueen/* endpoints, configured once at hub startup via
// SetSecretQueenBackend (cmd/gomachine/hub.go, right next to
// hub.Hub.SetZugzwangClient). It is NOT the same client hub/zugzwang.go
// uses for bot-move selection on the other variants — internal/variant must
// not import internal/hub (hub already imports variant, so that would be a
// cycle), so this package owns its own small client for the ONE thing only
// it needs: applying/designating/listing moves, which the State interface
// requires and only this variant can't do in-process.
var (
	secretQueenBaseURL    string
	secretQueenHTTPClient = &http.Client{Timeout: secretQueenHTTPTimeout}
)

// secretQueenHTTPTimeout bounds every secretqueen HTTP call, and has NO retry
// (unlike hub/zugzwang.go's BestMove): these calls run synchronously on
// whichever goroutine invoked them, and for a human's own move that is the
// hub's single mutation loop, so a retry would double the worst-case stall
// every OTHER live game feels. A single bounded attempt, failing closed
// (reject the move), is the safer choice here — not the more resilient one.
//
// Sized from measurement rather than guessed: /secretqueen/move and
// /legal-moves both answer in ~0.15ms median / 0.21ms p95 on localhost (300
// samples each). So the timeout can only ever fire in the pathological case —
// zugzwang accepting the connection but answering slowly (saturated, paging) —
// since a dead engine fails instantly with connection-refused and never
// reaches it. 250ms is ~1000x the measured p95, so it cannot trip on a healthy
// engine, and it bounds what every other live game feels while one Secret
// Queen move waits.
const secretQueenHTTPTimeout = 250 * time.Millisecond

// SetSecretQueenBackend wires every secretqueenState to zugzwang's
// /secretqueen/* endpoints at baseURL. Call once before any secretqueen game
// can be created (mirrors hub.Hub.SetZugzwangClient). Until this is called,
// New(SecretQueen, ...) still succeeds for an UNDESIGNATED position (no HTTP
// call is needed until both sides have picked their pawn — see
// newSecretQueenState), so tests and tooling that never touch this variant
// are unaffected; any call that actually needs the engine (Apply, Designate,
// or constructing an already-fully-designated FEN) fails loudly with a clear
// error instead of a nil-pointer panic.
func SetSecretQueenBackend(baseURL string) {
	secretQueenBaseURL = strings.TrimRight(baseURL, "/")
}

// secretQueenPost is the one HTTP call shape every endpoint below shares:
// POST a JSON body, decode a JSON response, surface a clear error on any
// transport/decode/status problem. Every caller treats a non-nil error
// exactly like "the position/move is invalid" (fail closed) — see the
// package doc for why that's the right default for a hidden-information
// ruleset (a divergence here must never accidentally reveal a secret by
// guessing).
func secretQueenPost(path string, reqBody, out any) error {
	if secretQueenBaseURL == "" {
		return fmt.Errorf("secretqueen: zugzwang backend not configured (call variant.SetSecretQueenBackend)")
	}
	body, err := json.Marshal(reqBody)
	if err != nil {
		return fmt.Errorf("secretqueen: marshal %s request: %w", path, err)
	}
	ctx, cancel := context.WithTimeout(context.Background(), secretQueenHTTPTimeout)
	defer cancel()
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, secretQueenBaseURL+path, bytes.NewReader(body))
	if err != nil {
		return fmt.Errorf("secretqueen: build %s request: %w", path, err)
	}
	req.Header.Set("Content-Type", "application/json")
	resp, err := secretQueenHTTPClient.Do(req)
	if err != nil {
		return fmt.Errorf("secretqueen: %s request: %w", path, err)
	}
	defer resp.Body.Close()
	if err := json.NewDecoder(resp.Body).Decode(out); err != nil {
		return fmt.Errorf("secretqueen: decode %s response: %w", path, err)
	}
	if resp.StatusCode >= 300 {
		return fmt.Errorf("secretqueen: %s: status %d", path, resp.StatusCode)
	}
	return nil
}

// secretQueenMoveResponse is /secretqueen/move's response shape
// (zugzwang/src/serve_handlers.cpp, per docs/tasks/open/secret-queen.md).
type secretQueenMoveResponse struct {
	Legal  bool   `json:"legal"`
	San    string `json:"san"`
	Reveal *struct {
		Moved    string `json:"moved"`
		Captured string `json:"captured"`
		Promoted string `json:"promoted"`
		Square   string `json:"square"`
	} `json:"reveal"`
	NewFen       string `json:"newFen"`
	FenWhite     string `json:"fenWhite"`
	FenBlack     string `json:"fenBlack"`
	BoardFen     string `json:"boardFen"`
	SideToMove   string `json:"sideToMove"`
	Status       string `json:"status"`
	Result       string `json:"result"`
	KingCaptured bool   `json:"kingCaptured"`
	Error        string `json:"error"`
}

// secretQueenDesignateResponse is /secretqueen/designate's response shape.
type secretQueenDesignateResponse struct {
	Designated   bool   `json:"designated"`
	NewFen       string `json:"newFen"`
	FenWhite     string `json:"fenWhite"`
	FenBlack     string `json:"fenBlack"`
	BoardFen     string `json:"boardFen"`
	SideToMove   string `json:"sideToMove"`
	Status       string `json:"status"`
	Result       string `json:"result"`
	KingCaptured bool   `json:"kingCaptured"`
	Error        string `json:"error"`
}

// secretQueenLegalMovesResponse is /secretqueen/legal-moves's response shape.
type secretQueenLegalMovesResponse struct {
	Moves []string `json:"moves"`
	Error string   `json:"error"`
}

// secretQueenBestMoveResponse is /secretqueen/bestmove's response shape —
// only used by secretQueenSelfSearchMove below (the bot's move CHOICE);
// hub/zugzwang.go has its own near-identical struct for the SAME endpoint,
// used from the hub package's bot-move dispatch (bot.go's selfSearchMove) —
// see that file's SecretQueenBestMove doc for why the bestmove call is
// duplicated there rather than reused from here.
type secretQueenBestMoveResponse struct {
	BestMove *string `json:"bestmove"`
	Reason   string  `json:"reason"`
	Error    string  `json:"error"`
}

// fetchSecretQueenLegalMoves asks zugzwang for the legal moves of the side to
// move in fen (always the CANONICAL, secret-carrying FEN — the mover's own
// information set already includes their own hidden queen and excludes the
// opponent's, which is exactly why this list is safe to cache and hand back
// unfiltered to State.LegalMoves(): it was computed IN that mover's own
// information set to begin with, see docs/tasks/open/secret-queen.md's
// "Representation" section). A failure here degrades to an empty list rather
// than failing the whole Apply/Designate — the move/designation itself
// already succeeded and is on the board; losing the follow-up legal-moves
// call just means this ply's mover sees no moves until the NEXT successful
// state transition, rather than the move being lost entirely.
func fetchSecretQueenLegalMoves(fen string) []string {
	var resp secretQueenLegalMovesResponse
	if err := secretQueenPost("/secretqueen/legal-moves", map[string]any{"fen": fen}, &resp); err != nil {
		return nil
	}
	return resp.Moves
}

// splitSecretQueenFEN parses the canonical FEN's trailing "[wSq|bSq]" field
// (docs/tasks/open/secret-queen.md's "Representation") into the 6-field
// board FEN and each side's still-hidden square ("" for "-"/absent). This
// never talks to zugzwang — dropping or keeping a field is pure string
// surgery, not a rules question, and it's the ONLY way to get a board+trailer
// split for the very first, pre-designation state (before any engine
// response exists to read fenWhite/fenBlack/boardFen off of). Every other
// constructor (Apply, Designate) prefers the engine's own response fields
// over re-deriving them here, so this function is deliberately only reached
// from newSecretQueenState.
func splitSecretQueenFEN(fen string) (board, whiteSq, blackSq string) {
	fen = strings.TrimSpace(fen)
	lb := strings.IndexByte(fen, '[')
	if lb < 0 {
		return fen, "", ""
	}
	board = strings.TrimSpace(fen[:lb])
	trailer := strings.TrimSuffix(fen[lb+1:], "]")
	parts := strings.SplitN(trailer, "|", 2)
	if len(parts) != 2 {
		return board, "", ""
	}
	whiteSq, blackSq = parts[0], parts[1]
	if whiteSq == "-" {
		whiteSq = ""
	}
	if blackSq == "-" {
		blackSq = ""
	}
	return board, whiteSq, blackSq
}

// redactedFEN rebuilds a canonical-shaped FEN from a board and each side's
// square, substituting "-" for an empty (undesignated/redacted) one — the
// inverse of splitSecretQueenFEN, used only where newSecretQueenState needs
// to build fenWhite/fenBlack locally (no engine response to read them from).
func redactedFEN(board, whiteSq, blackSq string) string {
	w, b := "-", "-"
	if whiteSq != "" {
		w = whiteSq
	}
	if blackSq != "" {
		b = blackSq
	}
	return board + " [" + w + "|" + b + "]"
}

func colorFromChar(s string) chess.Color {
	if s == "b" {
		return chess.Black
	}
	return chess.White
}

func colorToChar(c chess.Color) string {
	if c == chess.Black {
		return "b"
	}
	return "w"
}

// secretqueenState adapts zugzwang's out-of-process /secretqueen/* HTTP
// endpoints to the State interface. It is the ONLY State implementation
// whose rules do not live in this binary at all: standard/Chess960 reuse the
// engine core's Position, and Duck/Crazyhouse/Antichess each port their own
// ruleset into a self-contained Go package (internal/{duckchess,crazyhouse,
// antichess}) precisely so the hub never has to leave the process to decide
// a move. Secret Queen breaks that pattern on purpose.
//
// Why: this is a hidden-information ruleset (docs/tasks/open/
// secret-queen.md). A Go port of its movegen/reveal-detection that could
// ever disagree with zugzwang's C++ core wouldn't just occasionally produce
// a WRONG move the way an ordinary rules bug would — it could produce a
// RIGHT-LOOKING move for the wrong reason (e.g. Go's copy thinks e2h5 is
// legal because it independently believes e2 is the hidden queen, when the
// canonical state, only zugzwang's, says otherwise) and thereby hand a
// player information about the opponent's secret square that no legal
// inference should have given them. One implementation, called from Go, is
// strictly safer than two that can drift apart — the cost is an HTTP round
// trip per move/designation instead of an in-process call.
//
// What that costs, concretely: Apply() and Designate() below run
// SYNCHRONOUSLY on whatever goroutine calls them, which for a human's own
// move is the hub's single Run goroutine (that package's no-locks design).
// Every other variant's Apply is a pure in-process function, so this is the
// one that can block it on I/O.
//
// Measured, so the tradeoff is a number rather than a worry: /secretqueen/move
// and /legal-moves answer in ~0.15ms median / 0.21ms p95 on localhost, so a
// live move costs that goroutine ~0.3ms — orders of magnitude below the other
// per-move work it already does, and comfortably below anything a player could
// perceive. That is why this stayed synchronous instead of growing a result
// channel: an async apply would mean every call site that currently reads
// g.state straight after g.applyMove has to wait on a channel instead, which is
// a real hub-architecture change bought for a third of a millisecond.
//
// The bound that does matter is secretQueenHTTPTimeout below, which caps what
// every OTHER live game feels if zugzwang ever answers slowly.
type secretqueenState struct {
	fen        string // canonical — carries the [w|b] secret-square trailer; FEN()
	boardFEN   string // fully redacted board (no trailer at all) — BoardFEN(), identical for every viewer
	fenWhite   string // White's own secret kept, Black's stripped (kept for completeness/debugging; the hub derives its own per-viewer wire fields via OwnSecretSquare, not this)
	fenBlack   string // Black's own secret kept, White's stripped
	side       chess.Color
	statusWord string   // "ongoing" | "white_win" | "black_win" | "draw" — zugzwang's own word, trusted verbatim
	lastReveal string   // square revealed by the move that produced this state, "" if none — see Extras()
	legal      []string // cached LegalMoves() for `side` — see the eager-fetch doc on Apply/Designate/newSecretQueenState
}

func newSecretQueenState(fen string) (State, error) {
	board, whiteSq, blackSq := splitSecretQueenFEN(fen)
	// chess.ParseFEN here is pure FEN-syntax validation (fields, side to
	// move, castling rights parse) — the same read-only use of the board
	// primitives zugzwang's own secretqueen.cpp describes leaning on
	// (docs/tasks/open/secret-queen.md's "Representation" section), NOT a
	// rules call: it never generates a move or asks "is this legal".
	pos, err := chess.ParseFEN(board)
	if err != nil {
		return nil, err
	}
	st := secretqueenState{
		fen:        redactedFEN(board, whiteSq, blackSq),
		boardFEN:   board,
		fenWhite:   redactedFEN(board, whiteSq, ""),
		fenBlack:   redactedFEN(board, "", blackSq),
		side:       pos.SideToMove(),
		statusWord: "ongoing",
	}
	// legalMoves stays nil until BOTH sides are designated. Before that, the
	// hub's own designation-phase gate (hub/hub.go's move()) refuses every
	// "move" command anyway — there is truly nothing to compute yet, so no
	// HTTP call is spent finding that out. This is what lets New(SecretQueen,
	// chess.StartFEN) succeed even with no backend configured at all (tests,
	// or any caller that never plays this variant).
	if whiteSq != "" && blackSq != "" {
		st.legal = fetchSecretQueenLegalMoves(st.fen)
	}
	return st, nil
}

func (s secretqueenState) Side() chess.Color          { return s.side }
func (s secretqueenState) FEN() string                { return s.fen }
func (s secretqueenState) BoardFEN() string           { return s.boardFEN }
func (s secretqueenState) PrimaryUCI(m string) string { return m }    // plain UCI — no composite move string, unlike Duck
func (s secretqueenState) CanMate(chess.Color) bool   { return true } // a king is always capturable, exactly like Duck/Antichess

// History returns nil: /secretqueen/move takes only {fen, move} (no prior-
// position history — it is deliberately stateless, like every zugzwang
// endpoint), so threefold repetition cannot be computed from what the
// endpoint gives back without either a design change to the wire (out of
// scope — internal/hub and internal/variant don't touch zugzwang's C++) or
// an extra HTTP round trip on every single move just to maintain a
// repetition table nothing else uses. Duck makes the identical call for the
// identical structural reason (variant.go: "no repetition history for
// variants without threefold"); Secret Queen is not fundamentally different
// from Duck here even though its rules text mentions threefold — the fifty-
// move rule and "no legal move" cases ARE reachable through the engine's own
// `status` field (it can see the halfmove clock in the FEN it was handed),
// only genuine same-position-three-times detection needs history this
// endpoint doesn't carry.
func (s secretqueenState) History() []uint64 { return nil }

// Extras carries only PUBLIC state — the square (if any) revealed by the
// move that produced this state. Unlike Duck's "duck" square or Crazyhouse's
// "pocket", Secret Queen's real per-viewer secret (OwnSecretSquare below)
// deliberately does NOT live here: Extras() is a single, viewer-independent
// map handed to whoever asks, and there is no viewer-independent way to
// answer "whose hidden square is this" — see the HiddenState interface doc.
// A reveal, by contrast, is public information the instant it happens (rule
// 3 in the design doc), so it's exactly the kind of thing Extras() is for.
func (s secretqueenState) Extras() map[string]string {
	return map[string]string{"reveal": s.lastReveal}
}

func (s secretqueenState) LegalMoves() []string {
	if s.legal == nil {
		return []string{}
	}
	return s.legal
}

// Apply plays move against zugzwang's canonical position. See the type doc
// for why this is a synchronous HTTP round trip (in fact two: the move
// itself, then a follow-up legal-moves fetch so the returned State never
// needs further I/O to answer LegalMoves() — see fetchSecretQueenLegalMoves).
// ok=false covers BOTH an illegal move and a network/backend failure —
// deliberately indistinguishable to the caller, matching the "fail closed"
// stance in the package doc: never guess.
func (s secretqueenState) Apply(move string) (State, string, bool) {
	var resp secretQueenMoveResponse
	if err := secretQueenPost("/secretqueen/move", map[string]any{"fen": s.fen, "move": move}, &resp); err != nil {
		return nil, "", false
	}
	if !resp.Legal || resp.NewFen == "" {
		return nil, "", false
	}
	next := secretqueenState{
		fen:        resp.NewFen,
		boardFEN:   resp.BoardFen,
		fenWhite:   resp.FenWhite,
		fenBlack:   resp.FenBlack,
		side:       colorFromChar(resp.SideToMove),
		statusWord: resp.Status,
	}
	if resp.Reveal != nil {
		next.lastReveal = resp.Reveal.Square
	}
	next.legal = fetchSecretQueenLegalMoves(next.fen)
	return next, resp.San, true
}

// Status maps zugzwang's own status word onto engine.Status verbatim — see
// the type doc: this variant has no independent Go opinion about the
// position at all, so there is nothing to reconcile. There is never a
// check, and the only decisive reason is a king capture (rule 5 — no
// checkmate, no stalemate as a WIN, only as the "no legal move" draw).
func (s secretqueenState) Status() engine.Status {
	st := engine.Status{State: "ongoing", Check: false, SideToMove: colorToChar(s.side)}
	switch s.statusWord {
	case "ongoing":
		// still playing
	case "draw":
		st.State, st.Result = "draw", "1/2-1/2"
	case "white_win":
		st.State, st.Result = "king-capture", "1-0"
	case "black_win":
		st.State, st.Result = "king-capture", "0-1"
	}
	return st
}

// --- the designation phase (not part of the base State interface) ---
//
// Designate is a ONE-TIME pre-game transition (hub/hub.go's
// applySecretQueenDesignation), not an ordinary ply, so it lives on
// HiddenState rather than next to Apply(). It designates ONE side at a
// time — the caller decides when to call it for which color (a human's own
// "designate" message, or the hub's own random pick on a bot side / a
// timed-out human) — matching the engine's own {fen, color, square} shape.
func (s secretqueenState) Designate(color chess.Color, square string) (State, bool) {
	var resp secretQueenDesignateResponse
	body := map[string]any{"fen": s.fen, "color": colorToChar(color), "square": square}
	if err := secretQueenPost("/secretqueen/designate", body, &resp); err != nil {
		return nil, false
	}
	if !resp.Designated || resp.NewFen == "" {
		return nil, false
	}
	next := secretqueenState{
		fen:        resp.NewFen,
		boardFEN:   resp.BoardFen,
		fenWhite:   resp.FenWhite,
		fenBlack:   resp.FenBlack,
		side:       colorFromChar(resp.SideToMove),
		statusWord: resp.Status,
		lastReveal: s.lastReveal, // designation never reveals anything; carry forward (always "" pre-game anyway)
	}
	// If BOTH sides are now named, the designation phase just completed and
	// real play is about to start — cache legalMoves NOW (same reasoning as
	// Apply) rather than leaving it to be discovered lazily by a caller that
	// must not do further I/O.
	if _, whiteSq, blackSq := splitSecretQueenFEN(next.fen); whiteSq != "" && blackSq != "" {
		next.legal = fetchSecretQueenLegalMoves(next.fen)
	}
	return next, true
}

// OwnSecretSquare returns viewer's own still-hidden square, "" if
// undesignated or already revealed — see splitSecretQueenFEN's doc: this is
// pure string surgery on the canonical FEN's trailer, not a network call.
func (s secretqueenState) OwnSecretSquare(viewer chess.Color) string {
	_, whiteSq, blackSq := splitSecretQueenFEN(s.fen)
	if viewer == chess.Black {
		return blackSq
	}
	return whiteSq
}

// secretQueenSelfSearchMove computes a Secret Queen bot move from a
// canonical FEN (self-describing — carries both the position and whichever
// secrets are still hidden). Mirrors duckSelfSearchMove/antichessSelfSearchMove's
// contract (ok=false = no legal move OR the backend is unreachable), but
// unlike those three, there is no in-process fallback implementation to fall
// through to at all — see the type doc's opening paragraph. A bot move is
// simply skipped (hub/bot.go logs it) if zugzwang can't be reached; there is
// no emergency-in-process path for this one variant.
func secretQueenSelfSearchMove(fen string, rating int) (string, bool) {
	var resp secretQueenBestMoveResponse
	body := map[string]any{"fen": fen, "limits": map[string]any{"rating": rating}}
	if err := secretQueenPost("/secretqueen/bestmove", body, &resp); err != nil {
		return "", false
	}
	if resp.BestMove == nil || *resp.BestMove == "" {
		return "", false
	}
	return *resp.BestMove, true
}
