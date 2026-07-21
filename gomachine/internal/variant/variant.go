// Package variant is the hub's variant-orchestration seam. Every board ruleset
// implements the single State interface, so the live-game flow (hub/game.go)
// never branches on which variant it is — no scattered isDuck() checks. Adding a
// variant means adding a State implementation plus a case in the small
// dispatchers here (New / SelfSearches / SelfSearchMove), not editing the hub.
//
// Execution is tiered. Tier 1 variants (standard, Chess960) reuse the engine
// core's Position and the hub's shared engine pool for bot search. Tier 2
// variants (Duck, Crazyhouse, Antichess) carry their own rules and search;
// SelfSearches reports which, and SelfSearchMove produces their bot moves
// without leasing the engine pool.
package variant

import (
	"github.com/timanthonyalexander/gomachine/internal/chess"
	"github.com/timanthonyalexander/gomachine/internal/engine"
)

// Variant ids. Standard and Chess960 share the standard ruleset — they differ
// only in the start FEN — so both resolve to the same State implementation.
const (
	Standard   = "standard"
	Chess960   = "chess960"
	Duck       = "duck"
	Crazyhouse = "crazyhouse"
	Antichess  = "antichess"
)

// State is one live variant position. It is immutable: Apply returns the next
// State and never mutates the receiver, so a State captured by a bot goroutine is
// a safe snapshot. Every method answers for the side to move at the current ply.
type State interface {
	// Side is the color to move.
	Side() chess.Color
	// FEN is the CANONICAL, self-describing FEN — enough to fully reconstruct the
	// position (Crazyhouse includes its [pocket]). Used for reconstruction/history.
	FEN() string
	// BoardFEN is the standard-shape board FEN a normal chess renderer expects (no
	// pocket, no promotion marks). Equals FEN for standard/960/duck.
	BoardFEN() string
	// Extras are the wire's auxiliary fields for this variant, keyed by name —
	// {"duck": square} for Duck, {"pocket": "PPNq"} for Crazyhouse — or nil for
	// variants with none. This is the general replacement for the old Duck() token.
	Extras() map[string]string
	// LegalMoves lists the legal moves for the side to move, as UCI (or a variant's
	// composite move string), empty if the game is over.
	LegalMoves() []string
	// Apply plays move, returning the next state, its SAN, and whether it was legal.
	Apply(move string) (State, string, bool)
	// Status adjudicates the current position (ongoing / mate / draw / …).
	Status() engine.Status
	// PrimaryUCI extracts the wire "lastMove" from a recorded move (identity for
	// plain UCI; the piece portion of a composite for Duck).
	PrimaryUCI(move string) string
	// History is the prior-position Zobrist keys for repetition detection, or nil
	// for variants without threefold (Duck).
	History() []uint64
	// CanMate reports whether side can still deliver mate — the timeout
	// adjudication's "any legal series mates" test.
	CanMate(side chess.Color) bool
}

// New builds the initial State for a variant from its start FEN.
func New(id, fen string) (State, error) {
	switch id {
	case Duck:
		return newDuckState(fen)
	case Crazyhouse:
		return newCrazyhouseState(fen)
	case Antichess:
		return newAntichessState(fen)
	default: // Standard, Chess960, and anything unknown → standard rules.
		return newStandardState(fen)
	}
}

// SelfSearches reports whether a variant provides its own bot search (Tier 2)
// rather than playing through the hub's shared engine pool (Tier 1).
func SelfSearches(id string) bool { return id == Duck || id == Crazyhouse || id == Antichess }

// SelfSearchMove computes a bot move for a self-searching (Tier 2) variant from a
// position snapshot: the canonical FEN plus the wire extras (the auxiliary fields
// a variant needs that its FEN may not carry, e.g. Duck's square). ok is false for
// engine-pool variants, which never call this.
func SelfSearchMove(id, fen string, extras map[string]string, rating int) (uci string, ok bool) {
	switch id {
	case Duck:
		return duckSelfSearchMove(fen, extras["duck"], rating)
	case Crazyhouse:
		return crazyhouseSelfSearchMove(fen, rating)
	case Antichess:
		return antichessSelfSearchMove(fen, rating)
	default:
		return "", false
	}
}
