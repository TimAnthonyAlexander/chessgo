package hub

import (
	"errors"
	"fmt"
	"strings"
	"time"
)

// ServerChallengeRequest is a BaseAPI-registered private challenge with no
// creator WebSocket connection at all — see RegisterServerChallenge. It backs
// an already-accepted user-to-user challenge: both named players join later
// (independently, whenever/wherever they open the app) over the existing WS
// `joinChallenge` message, exactly as if one of them had shared an invite code.
type ServerChallengeRequest struct {
	Code        string        // short code both players will join with
	Pool        string        // time control, e.g. "5+0"
	Color       string        // "w"|"b"|"random", relative to CreatorSub
	Rated       bool          // still gated on both being accounts (and forced false by a custom FEN) at join
	Variant     string        // "standard" (default), "chess960", "duck", "crazyhouse", "antichess"
	FEN         string        // optional custom start position; "" = the variant's normal start
	CreatorSub  string        // identity sub allowed to join as the challenger (Color is relative to this side)
	OpponentSub string        // identity sub allowed to join as the opponent
	TTL         time.Duration // how long the invite lingers unanswered; <=0 defaults to challengeTTL
}

// registerChallengeReq is a ServerChallengeRequest after validation, carrying a
// result channel so RegisterServerChallenge can block for a synchronous
// outcome while the actual h.challenges write happens on the Run goroutine.
type registerChallengeReq struct {
	code        string
	pool        string
	tc          timeControl
	color       string
	rated       bool
	variantID   string
	fen         string
	creatorSub  string
	opponentSub string
	ttl         time.Duration
	result      chan error
}

// RegisterServerChallenge validates req and, if valid, registers a private
// challenge restricted to exactly req.CreatorSub and req.OpponentSub with no
// creator connection attached. Safe to call from any goroutine (e.g. an HTTP
// handler): validation runs here (pure, no shared state); the actual
// h.challenges write — including the "code already taken" check — is funneled
// onto the Run goroutine, and this call blocks for its result.
func (h *Hub) RegisterServerChallenge(req ServerChallengeRequest) error {
	code := strings.TrimSpace(req.Code)
	if code == "" {
		return errors.New("code is required")
	}
	tc, ok := parseTimeControl(req.Pool)
	if !ok {
		return errors.New("invalid pool/time control")
	}
	switch req.Color {
	case "w", "b", "random":
	default:
		req.Color = "random"
	}
	creatorSub := strings.TrimSpace(req.CreatorSub)
	opponentSub := strings.TrimSpace(req.OpponentSub)
	if creatorSub == "" || opponentSub == "" {
		return errors.New("creatorSub and opponentSub are both required")
	}
	if creatorSub == opponentSub {
		return errors.New("creatorSub and opponentSub must be distinct")
	}
	variantID := normalizeVariant(req.Variant)
	fen := strings.TrimSpace(req.FEN)
	if fen != "" {
		if err := validateCustomStartFEN(variantID, fen); err != nil {
			return err
		}
	}
	ttl := req.TTL
	if ttl <= 0 {
		ttl = challengeTTL
	}

	errCh := make(chan error, 1)
	h.registerChallenges <- registerChallengeReq{
		code: code, pool: req.Pool, tc: tc, color: req.Color, rated: req.Rated,
		variantID: variantID, fen: fen, creatorSub: creatorSub, opponentSub: opponentSub,
		ttl: ttl, result: errCh,
	}
	return <-errCh
}

// doRegisterServerChallenge runs on the Run goroutine: h.challenges is
// otherwise touched only there, so the "code already taken" check and the map
// write must happen together, atomically, here — not in RegisterServerChallenge
// itself, which may run concurrently with the hub loop.
func (h *Hub) doRegisterServerChallenge(req registerChallengeReq) error {
	if _, exists := h.challenges[req.code]; exists {
		return fmt.Errorf("code %q is already registered", req.code)
	}
	now := time.Now()
	h.challenges[req.code] = &challenge{
		code:        req.code,
		pool:        req.pool,
		tc:          req.tc,
		color:       req.color,
		rated:       req.rated,
		variant:     req.variantID,
		fen:         req.fen,
		createdAt:   now,
		expiresAt:   now.Add(req.ttl),
		serverSide:  true,
		creatorSub:  req.creatorSub,
		opponentSub: req.opponentSub,
	}
	return nil
}
