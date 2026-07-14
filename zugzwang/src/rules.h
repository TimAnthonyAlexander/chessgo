#pragma once
// Rules-layer helpers for the HTTP serve mode (serve.cpp): SAN rendering,
// legal-move enumeration, FIDE-style game-status adjudication, and small
// parsing utilities. Ported from gomachine's internal/chess (san.go,
// material.go) and internal/engine (Adjudicate) so the HTTP JSON contract is
// byte-identical in SHAPE and semantics, even though the two engines are
// independent implementations (no shared rules core across languages).
#include "position.h"
#include "movegen.h"
#include <cstdint>
#include <optional>
#include <string>
#include <vector>

namespace Rules {

// Fills `out` with every LEGAL move (pseudo-legal filtered by pos.legal()).
void generate_legal(const Position& pos, MoveList& out);

// UCI-string list of legal moves, optionally restricted to moves FROM `from`
// (SQ_NONE = no restriction). Mirrors chess.Position.LegalMoveStrings.
std::vector<std::string> legal_move_strings(const Position& pos, Square from);

// Parses "e2" -> E2; returns SQ_NONE (not std::nullopt) on a bad string, same
// as gomachine's ParseSquare failure path (the caller then means "no filter").
Square parse_square(const std::string& s);

// Matches a UCI move string ("e2e4", "e7e8q") against pos's legal moves.
// Returns MOVE_NONE if the string isn't a legal move here.
Move parse_uci_move(const Position& pos, const std::string& s);

// Standard Algebraic Notation for a legal move (Nf3, exd5, O-O, e8=Q+, Qxe1#).
// Mutates and restores pos internally (do_move/undo_move) to compute the
// check/mate suffix — `pos` must be non-const for that, matching the C++
// Position API (gomachine's SAN receiver is likewise non-const).
std::string san(Position& pos, Move m);

// Whether `pos` is a dead (unwinnable-by-either-side) position by the FIDE-
// conservative material set gomachine uses: K v K, K+minor v K, same-color
// K+B v K+B. Mirrors chess.Position.InsufficientMaterial exactly.
bool insufficient_material(const Position& pos);

// Whether color `c` could conceivably deliver mate given only its material
// (used for the FIDE 6.9 timeout-vs-material check). Mirrors CanAnyoneMate.
bool can_anyone_mate(const Position& pos, Color c);

// Whether `pos` is a LEGAL position to search/serve from: both kings present,
// and the side NOT to move is not currently in check (an illegal "double
// check on the mover's opponent" position). Mirrors chess.Position.Legal.
// NOTE: only safe to call AFTER a successful valid_fen_structure() check and
// pos.set() — see that function's doc comment for why.
bool position_legal(const Position& pos);

// Structural pre-check on a raw FEN string, BEFORE Position::set() is ever
// called: exactly 8 ranks of 8 files and exactly one king per side. This is
// not merely cosmetic — Position::set() unconditionally calls
// set_check_info(), which does king_square(sideToMove) = BB::lsb(0) on a
// missing king (indexes KingAttacks[SQ_NONE] — undefined behavior, segfaults
// the process). position_legal()'s own king-count check runs on an already-
// parsed Position, too late to prevent that crash, so every caller of
// Position::set() with untrusted input (a request FEN, a history-list FEN)
// MUST pass this gate first. Not as exhaustive as chess.ParseFEN's
// field-by-field validation — good enough for the website's well-formed
// inputs; a well-formed-but-illegal position (e.g. opponent's king in check)
// is caught by position_legal() instead, matching gomachine's two-tier error
// shape (400 "invalid fen" vs 400 "illegal position").
bool valid_fen_structure(const std::string& fen);

// How many times `key` occurs among `history` PLUS the current position
// itself (counted as one occurrence) — mirrors engine.repetitionCount.
int repetition_count(uint64_t key, const std::vector<uint64_t>& history);

// FIDE-style game status, mirroring engine.Adjudicate exactly. `history`
// holds prior-position Zobrist keys (NOT including pos's own key).
struct Status {
    std::string state;                    // ongoing | checkmate | stalemate | draw-insufficient-material | draw-fivefold | draw-seventyfive
    std::string sideToMove;                // "w" | "b"
    bool check = false;
    std::vector<std::string> claimableDraws; // "threefold", "fifty"
    std::string result;                    // "1-0" | "0-1" | "1/2-1/2" | ""
};
Status adjudicate(const Position& pos, const std::vector<uint64_t>& history);

// Parses each FEN in `fens`, silently skipping ones that fail to parse (bad
// FEN in a history list shouldn't 400 the whole request) — mirrors
// server.historyKeys. Uses a throwaway Position, so the caller's pos/state is
// untouched.
std::vector<uint64_t> history_keys(const std::vector<std::string>& fens);

// Rebuilds pos.game_key_history from `historyKeys` (prior-position Zobrist
// keys, oldest first) followed by pos's OWN current key — mirrors what a real
// game replay (uci.cpp's position_cmd, or gomachine threading `history`
// through every request) would populate, so in-search repetition detection
// (Position::is_draw/has_repeated) sees the real game line even though every
// HTTP request rebuilds pos fresh from a FEN. Call once, right after
// pos.set(fen), before any do_move/search. Truncates to the array's capacity
// (keeps the most recent entries) if history is implausibly long.
void seed_history(Position& pos, const std::vector<uint64_t>& historyKeys);

} // namespace Rules
