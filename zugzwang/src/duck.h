#pragma once
// Duck Chess: a self-contained variant module — mirrors gomachine's
// internal/duckchess (Go) design exactly (WIRING_RECON.md §D "Duck Chess —
// largest structural lift"). Duck Chess is NOT additive on top of standard
// chess the way Crazyhouse is: there is no check/checkmate/stalemate (you win
// by CAPTURING the enemy king, so king-captures are legal and generated), and
// every turn is TWO parts (a piece move, then relocating the duck to a
// different empty square) — both of which conflict with Position's
// check/pin/legality machinery (position.h's checkers/blockersForKing/
// pinners, search.cpp's check extensions). Reusing Position::do_move/legal()
// here would be fighting the type, not saving work.
//
// So — per WIRING_RECON's own conclusion — this file does NOT touch Position
// at all. It is a plain mailbox board[64] (a DuckState value type, exactly
// like gomachine's duckchess.State) plus a separate duck-square field, with
// its own FEN parse/serialize, its own pseudo-legal-and-duck-aware movegen,
// its own apply (plain struct-copy, matching gomachine's immutable-State
// style — there is no self-referential StateInfo chain to fight here, unlike
// crazyhouse.h's Position-embedding, so value-copy is actually the SIMPLEST
// correct choice, not a deviation), its own hand eval, and its own shallow
// search with the same rating-derived weakening ladder (depth + eval noise +
// blunder rate + deliberately sloppy duck placement) as gomachine's
// internal/duckchess/search.go — so bot difficulty per rating feels
// unchanged after the engine swap.
//
// It DOES reuse zugzwang's board PRIMITIVES read-only: Square/Piece/Color
// from types.h, and BB::attacks<...>/BB::pawn_attacks for pseudo-attack
// generation (occupancy bitboards are rebuilt from the mailbox per call,
// exactly like gomachine's State.occupied()/colorBB() — Duck positions are
// tiny and this is never a search hot path the way standard search is).
//
// Why a separate hand eval, not the shared NNUE (mirrors gomachine's own
// choice, internal/duckchess/eval.go): the NNUE net's 768 inputs describe a
// STANDARD board only — no duck-occupancy feature, no king-capture-is-the-win
// concept, so it would be duck-blind. gomachine's fix was a small
// material+center+king-danger hand eval, ported verbatim below.
#include "types.h"
#include "bitboard.h"
#include <cstdint>
#include <string>
#include <vector>

// ---- Move ----

// A single piece move (no duck). Special flags are derived by the generator;
// the applier trusts them, so a hand-built DuckPieceMove must set them.
// Mirrors gomachine's duckchess.PieceMove (move.go).
struct DuckPieceMove {
    Square from = SQ_NONE;
    Square to = SQ_NONE;
    PieceType promo = NO_PIECE_TYPE; // NO_PIECE_TYPE when not a promotion
    bool ep = false;                 // en-passant capture
    bool castle = false;             // castling (to is the king's destination file g/c)

    std::string uci() const;
    bool operator==(const DuckPieceMove& o) const {
        return from == o.from && to == o.to && promo == o.promo && ep == o.ep && castle == o.castle;
    }
};

// Parses "e2e4" / "e7e8q" into origin/destination/promo. The EP/Castle flags
// are NOT set here (resolved by matching against a generated legal move, like
// gomachine's parsePieceUCI + findLegal split).
bool duck_parse_piece_uci(const std::string& s, DuckPieceMove& out);

// ---- State ----

// Castling-right bits — independent of the core engine's CastlingRight
// (types.h), though numerically identical (K=1,Q=2,k=4,q=8) by convention.
constexpr uint8_t DUCK_CASTLE_WK = 1;
constexpr uint8_t DUCK_CASTLE_WQ = 2;
constexpr uint8_t DUCK_CASTLE_BK = 4;
constexpr uint8_t DUCK_CASTLE_BQ = 8;

// A complete Duck Chess position: the piece board (mailbox), side to move,
// castling rights, en-passant target, the duck's square, and clocks. A value
// type — every mutating operation returns a NEW DuckState (immutable style,
// mirrors gomachine's State exactly). The duck is stored SEPARATELY from the
// board (it is never a piece).
struct DuckState {
    Piece board[64] = {};
    Color side = WHITE;
    uint8_t castling = 0;
    Square ep = SQ_NONE;   // raw en-passant target, or SQ_NONE
    Square duck = SQ_NONE; // the duck's square, or SQ_NONE if not yet placed
    int halfmove = 0;
    int fullmove = 1;

    std::string duckString() const { return duck == SQ_NONE ? "" : SQ_NAMES[duck]; }

    // Serializes back to a STANDARD FEN (the duck rides alongside in a
    // separate field of the API, never inside the FEN) — mirrors State.FEN().
    std::string fen() const;
};

// Builds a DuckState from a standard FEN plus the duck square ("" = not yet
// placed). Illegal-by-classic-chess positions (a king "in check", or even a
// king ALREADY CAPTURED — a terminal Duck position) are ACCEPTED: Duck Chess
// has no check, and a captured king is a normal thing to see mid-replay (e.g.
// /duck/analyze-game). Only structurally malformed input (bad board/side/
// duck-square syntax, or a duck square that lands on a piece) is rejected.
// Mirrors gomachine's duckchess.Parse.
bool duck_parse(const std::string& fen, const std::string& duckStr, DuckState& out, std::string& err);

constexpr char DUCK_START_FEN[] = "rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1";

// ---- Move generation ----

// Every legal PIECE move for the side to move. "Legal" == "pseudo-legal,
// duck-aware": there is NO self-check filter and king captures ARE included
// (capturing the enemy king wins). The duck blocks every landing square and
// every sliding/pawn path; knights jump but may not land on the duck. Mirrors
// gomachine's State.LegalPieceMoves exactly (including per-square dispatch
// order, load-bearing for the search's "first king-capture wins" scan).
std::vector<DuckPieceMove> duck_legal_piece_moves(const DuckState& s);

// Reports whether m lands on the enemy king's square (mirrors
// State.capturesEnemyKing).
bool duck_captures_enemy_king(const DuckState& s, const DuckPieceMove& m);

// ---- Apply ----

// Applies ONLY the piece move (no duck relocation, no side flip, no fullmove
// bump). Updates castling rights, the en-passant target, and the halfmove
// clock; reports whether the enemy king was captured. Mirrors
// State.doPieceMove. The move is TRUSTED (callers validate via
// duck_legal_piece_moves/duck_find_legal first).
DuckState duck_do_piece_move(const DuckState& s, const DuckPieceMove& m, bool& capturedKing);

// Applies a full turn: the piece move THEN the duck relocation, flipping the
// side and bumping the move number. Mirrors State.MakeMove. `newDuck` is
// trusted (callers validate).
DuckState duck_make_move(const DuckState& s, const DuckPieceMove& m, Square newDuck, bool& capturedKing);

// Matches a parsed origin/destination/promo against the generated legal
// moves, recovering the ep/castle flags. Mirrors State.findLegal.
bool duck_find_legal(const DuckState& s, const DuckPieceMove& want, DuckPieceMove& out);

// ---- Status ----

enum class DuckStatus { Ongoing, WhiteWin, BlackWin, Draw };

std::string duck_status_result(DuckStatus st); // "1-0"/"0-1"/"1/2-1/2"/""
std::string duck_status_name(DuckStatus st);   // "ongoing"/"white_win"/"black_win"/"draw"

// Classifies the position `s` (the state AFTER a move) given who just moved
// and whether that move captured a king. Mirrors State.statusAfter.
DuckStatus duck_status_after(const DuckState& s, Color mover, bool capturedKing);

// Reports the terminal state of the CURRENT position (side to move has not
// yet moved) — mirrors State.Status(). Used to adjudicate a freshly parsed
// state (a replayed position in /duck/analyze-game, or the position a
// /duck/bestmove request carries).
DuckStatus duck_status(const DuckState& s);

// Reports whether either king is missing from the board (i.e. captured) —
// mirrors server.duckKingCaptured, used to distinguish a decisive
// king-capture win from a no-legal-moves loss in the analyze-game response.
bool duck_king_captured(const DuckState& s);

// ---- Apply composite move ----

// Validates and applies a composite move string "<pieceUCI>:<duckSquare>"
// (e.g. "e2e4:e5"). On success fills `out`/`outMove`/`outStatus` and returns
// true; on any rule violation returns false with `err` set. Mirrors
// State.ApplyComposite.
bool duck_apply_composite(const DuckState& s, const std::string& move, DuckState& out, DuckPieceMove& outMove,
                           DuckStatus& outStatus, std::string& err);

// ---- SAN ----

// Display-only human string for a composite move, e.g. "e4 \xF0\x9F\xA6\x86e5"
// ("e4 \U0001F986e5"), "Nf3 \U0001F986d4", "O-O \U0001F986h6". No check/mate
// suffix (Duck Chess has neither). `s` is the PRE-move state. Mirrors
// State.SAN.
std::string duck_san(const DuckState& s, const DuckPieceMove& m, Square duckTo);

// ---- Eval ----

// Centipawns from the SIDE-TO-MOVE's perspective: material + a small central
// bonus + a king-danger term. Verbatim port of gomachine's State.evaluate
// (eval.go) — constants unchanged.
int duck_evaluate(const DuckState& s);

// ---- Search ----

struct DuckLimits {
    int rating = 0;      // 0 = unset
    int level = -1;      // -1 = unset
    int depth = 0;        // 0 = unset
    int movetimeMs = 0;    // 0 = unset
    uint64_t nodes = 0;    // 0 = unset
};
inline DuckLimits duck_default_limits() { return DuckLimits{}; } // Level -1, everything else 0

struct DuckResult {
    DuckPieceMove move;
    Square duck = SQ_NONE;
    int score = 0;
    int mate = 0;      // signed mate-in-N (moves); 0 if not a forced king capture
    bool hasMove = false;
};

// Renders the composite move "<pieceUCI>:<duckSquare>" — mirrors
// Result.MoveString.
std::string duck_result_move_string(const DuckResult& r);

// Searches for the best composite move: plays an immediate king capture when
// available, otherwise runs a shallow alpha-beta over piece moves (with
// heuristic duck placement at every ply — NOT itself searched, mirroring
// gomachine's deliberate design), then applies deterministic rating-derived
// weakening (eval noise / blunder / sloppy duck placement) so bot difficulty
// matches gomachine's ladder. Mirrors duckchess.BestMove exactly.
DuckResult duck_best_move(const DuckState& s, const DuckLimits& lim);
