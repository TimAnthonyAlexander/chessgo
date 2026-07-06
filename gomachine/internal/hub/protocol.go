package hub

import (
	"strconv"
	"strings"

	"github.com/timanthonyalexander/gomachine/internal/variant"
)

// inMsg is a message from a client. Type is one of: queue, cancel, move,
// resign, watch, unwatch, drawOffer, drawAccept, drawDecline, takebackOffer,
// takebackAccept, takebackDecline, chat, createChallenge, joinChallenge,
// cancelChallenge.
type inMsg struct {
	Type   string `json:"type"`
	Pool   string `json:"pool,omitempty"`   // time control, e.g. "3+0" (queue, createChallenge)
	Move   string `json:"move,omitempty"`   // UCI (move)
	GameID string `json:"gameId,omitempty"` // target game (watch)
	Text   string `json:"text,omitempty"`   // chat message body (chat)
	Color  string `json:"color,omitempty"`  // "w"|"b"|"random" creator side (createChallenge)
	Rated  bool   `json:"rated,omitempty"`  // creator's rated preference (createChallenge)
	Code   string `json:"code,omitempty"`   // private invite code (joinChallenge)
	// Variant is "standard" (default), "chess960" or "duck" (createChallenge).
	// Anything else is normalized to "standard" on the hub.
	Variant string `json:"variant,omitempty"`
}

// timeControl is a base time + per-move increment, both in milliseconds.
type timeControl struct {
	Base int64
	Inc  int64
}

// parseTimeControl turns "3+0", "10+5", "30+20" into a timeControl. Base is in
// minutes, increment in seconds, matching the lobby presets.
func parseTimeControl(pool string) (timeControl, bool) {
	plus := strings.IndexByte(pool, '+')
	if plus < 0 {
		return timeControl{}, false
	}
	base, err1 := strconv.Atoi(pool[:plus])
	inc, err2 := strconv.Atoi(pool[plus+1:])
	if err1 != nil || err2 != nil || base < 0 || inc < 0 || base > 180 || inc > 180 {
		return timeControl{}, false
	}
	if base == 0 && inc == 0 {
		return timeControl{}, false
	}
	return timeControl{Base: int64(base) * 60_000, Inc: int64(inc) * 1000}, true
}

// categoryFor picks the rating category for a game from BOTH its pool and its
// variant. Duck Chess and Crazyhouse are each their own isolated pool (no
// time-control split — every game of that variant, whatever its clock, is one
// rating), mirroring how BaseAPI routes them in GameResultController.
// Standard/Chess960 fall back to the duration-derived time-control category.
func categoryFor(pool, variant string) string {
	switch variant {
	case variantDuck:
		return "duck"
	case variantCrazyhouse:
		return "crazyhouse"
	}
	return categoryForPool(pool)
}

// categoryForPool maps a pool to a rating category by estimated game duration
// (base seconds + 40·increment), mirroring BaseAPI's EloService so the displayed
// rating matches the one ratings are tracked under.
func categoryForPool(pool string) string {
	tc, ok := parseTimeControl(pool)
	if !ok {
		return "blitz"
	}
	est := tc.Base/1000 + 40*tc.Inc/1000 // seconds
	switch {
	case est < 180:
		return "bullet"
	case est < 480:
		return "blitz"
	case est < 1500:
		return "rapid"
	default:
		return "classical"
	}
}

// Board variant ids understood by the hub, aliased from the internal/variant
// package (the single source of truth). The hub keeps these short local names for
// its many comparisons; variant.New/State turn an id into a live ruleset, so the
// game flow never branches on the id itself.
const (
	variantStandard   = variant.Standard
	variantChess960   = variant.Chess960
	variantDuck       = variant.Duck
	variantCrazyhouse = variant.Crazyhouse
)

// normalizeVariant clamps any client-supplied variant to a known value. Anything
// other than a recognized variant is treated as standard chess.
func normalizeVariant(v string) string {
	switch v {
	case variantChess960:
		return variantChess960
	case variantDuck:
		return variantDuck
	case variantCrazyhouse:
		return variantCrazyhouse
	default:
		return variantStandard
	}
}

const maxChatLen = 280 // runes; longer messages are truncated

// sanitizeChat strips control characters and trims/caps a chat message. The
// frontend renders chat as React text (auto-escaped), so this guards length and
// stray control bytes rather than HTML.
func sanitizeChat(s string) string {
	s = strings.Map(func(r rune) rune {
		if r < 0x20 && r != '\t' {
			return -1
		}
		return r
	}, s)
	s = strings.TrimSpace(s)
	if r := []rune(s); len(r) > maxChatLen {
		s = string(r[:maxChatLen])
	}
	return s
}

// out builds a server→client message as a JSON-marshalable map.
func out(typ string, fields map[string]any) map[string]any {
	if fields == nil {
		fields = map[string]any{}
	}
	fields["type"] = typ
	return fields
}
