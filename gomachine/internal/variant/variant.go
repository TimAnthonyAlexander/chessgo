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
// SecretQueen is declared in secretqueen.go, next to its own State
// implementation, rather than here — see that file's package doc for why it
// is not just another entry in this list conceptually.
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

// HiddenState is implemented by variants whose position is NOT shared public
// information — currently only Secret Queen (secretqueen.go). Every OTHER
// variant's payload genuinely IS the same for both players and every
// spectator, which is what lets hub/hub.go's broadcast fan out one
// marshalled message unchanged (hub/game.go's snapshot()). Secret Queen
// can't: the canonical FEN and the mover's own LegalMoves() both name a
// square that must never reach the opponent or a spectator. Rather than
// adding OwnSecretSquare/Designate to the base State interface — which every
// other adapter would have to answer with a meaningless no-op — the hub
// type-switches on this narrower interface (hub/game.go's hiddenState) and
// only THEN builds a payload per recipient instead of the shared one. See
// that file's snapshotFor for the split this makes possible.
type HiddenState interface {
	State
	// OwnSecretSquare returns viewer's OWN still-hidden square ("" if
	// undesignated or already revealed) — the one piece of per-position data
	// that cannot live in Extras(), because Extras() has no notion of "for
	// whom": it is the same map handed to every recipient of a shared
	// broadcast, and this value must never be.
	OwnSecretSquare(viewer chess.Color) string
	// Designate applies ONE side's designation-phase pick (the hub's
	// designation timer / WS handler, not an ordinary ply — see
	// secretqueen.go's Designate doc). ok=false means the square was invalid
	// or the backend was unreachable; the caller should treat that exactly
	// like a rejected move.
	Designate(color chess.Color, square string) (State, bool)
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
	case SecretQueen:
		return newSecretQueenState(fen)
	default: // Standard, Chess960, and anything unknown → standard rules.
		return newStandardState(fen)
	}
}

// SelfSearches reports whether a variant provides its own bot search (Tier 2)
// rather than playing through the hub's shared engine pool (Tier 1).
func SelfSearches(id string) bool {
	return id == Duck || id == Crazyhouse || id == Antichess || id == SecretQueen
}

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
	case SecretQueen:
		return secretQueenSelfSearchMove(fen, rating)
	default:
		return "", false
	}
}
