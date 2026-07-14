#pragma once
// Crazyhouse: a self-contained variant module, additive-only on top of the
// standard-chess core — mirrors gomachine's internal/crazyhouse (Go) design
// exactly: pockets + a promoted-squares bitboard live ALONGSIDE a Position,
// piece moves reuse the core's fully-legal movegen (Rules::generate_legal),
// and only drops + pocket/promotion bookkeeping are new. Standard chess
// (Position, movegen.cpp, search.cpp, eval.cpp/NNUE) is completely untouched
// by this file — zero shared mutable state, so standard perft/golden are
// unaffected by anything here.
//
// Why a SEPARATE hand eval, not the shared NNUE (mirrors gomachine's own
// choice, internal/crazyhouse/eval.go): the NNUE net's 768 inputs are
// standard-board piece-squares only — it has no pocket features, so it is
// blind to material in hand, which dominates Crazyhouse strategy (a bare
// king near an enemy with a queen in hand is often just lost). Reusing NNUE
// for ZH would be a POCKET-BLIND eval that plays badly; gomachine's fix was a
// small material+center+pocket+king-danger hand eval, ported verbatim below.
//
// Why drops are NOT folded into the packed 16-bit core Move (move.h): all 4
// of its 2-bit MoveType slots (NORMAL/PROMOTION/EN_PASSANT/CASTLING) are
// already spoken for, and Move's 16 bits are load-bearing everywhere in the
// main search (TT entries, history/killer tables) — widening it would touch
// every one of those call sites for a variant that never runs through that
// search. ZHMove is a separate, wider type used ONLY in this file and the
// /crazyhouse/* HTTP handlers; a plain piece move still carries a real core
// Move (from Rules::generate_legal), so do_move/undo_move/SEE/SAN are reused
// unchanged for that half.
#include "position.h"
#include "move.h"
#include <cstdint>
#include <memory>
#include <string>
#include <vector>

// ---- Move ----

// Either a normal piece move (core, from the standard movegen — castling/ep
// included) or a drop (dropType onto the empty square `to`). Mirrors
// gomachine's crazyhouse.Move (move.go).
struct ZHMove {
    bool isDrop = false;
    PieceType dropType = NO_PIECE_TYPE; // valid iff isDrop (PAWN..QUEEN)
    Square to = SQ_NONE;                // drop target; valid iff isDrop
    Move core = MOVE_NONE;              // valid iff !isDrop

    std::string uci() const;
    bool operator==(const ZHMove& o) const {
        return isDrop == o.isDrop && dropType == o.dropType && to == o.to && core == o.core;
    }
};

// Parses "e2e4" / "e7e8q" / "N@f3" (piece letter always uppercase, per
// gomachine's UCI() rendering). false on any malformed input.
bool zh_parse_move(const std::string& s, ZHMove& out);

// ---- Position ----

// A complete Crazyhouse position: the board (Position, reused read/write for
// piece moves) plus each side's pocket and the promoted-squares bitboard.
// Mutated in place via zh_do/zh_undo (mirrors Position's own do_move/
// undo_move stack-mutation style — NOT gomachine's value-copy style, which
// relies on Go's cheap value semantics that Position's self-referential `st`
// pointer chain does not have in C++). `history` holds prior-position
// composite keys (zh_key) for threefold, oldest first.
struct ZHPosition {
    Position pos;
    int pockets[COLOR_NB][PIECE_TYPE_NB] = {}; // [color][PAWN..QUEEN] counts; KING/NO_PIECE_TYPE unused
    U64 promoted = 0;                          // squares whose piece is a promoted pawn (reverts on capture)
    std::vector<uint64_t> history;
    // Owns the StateInfo a one-shot zh_apply() pushed (Position::st keeps
    // pointing into it for the rest of this object's life — see zh_apply's
    // doc comment). Unused by zh_do/zh_undo (those take caller-owned
    // StateInfo&, matching Position::do_move's own contract).
    std::unique_ptr<StateInfo> appliedSt;
};

// Parses a Crazyhouse FEN: a standard FEN whose piece-placement field carries
// a "[pocket]" suffix and may mark promoted pieces with "~" (e.g.
// "rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR[] w KQkq - 0 1"). Throws
// ApiError{400,...} on a malformed pocket/promotion field; a malformed board
// is caught the same way the standard /move family does (Rules::
// valid_fen_structure + Position::set), via parse_legal_or_throw-equivalent
// checks the caller must still run on the stripped board field.
bool zh_parse(const std::string& fen, ZHPosition& out, std::string& err);

// Serializes back to the Crazyhouse FEN shape (board+"~" marks +
// "[pocket]" + the standard side/castling/ep/clock fields).
std::string zh_fen(const ZHPosition& z);

// Renders both pockets: white's pieces (uppercase) then black's (lowercase),
// each in descending-value order (Q,R,B,N,P) — mirrors gomachine's
// pocketString / State.PocketString.
std::string zh_pocket_string(const ZHPosition& z);

constexpr char ZH_START_FEN[] =
    "rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR[] w KQkq - 0 1";

// Composite key over the board + both pockets + the promoted set, so two
// positions with an identical board but different pockets/promotions are
// distinct for this module's own threefold detection (mirrors gomachine's
// crazyhouse.State.key, though the hash itself need not match bit-for-bit —
// it is never compared across the Go/C++ boundary).
uint64_t zh_key(const ZHPosition& z);

// ---- Move generation ----

// Every legal move for the side to move: standard piece moves (fully legal —
// check/pins/castling/ep included) plus every legal drop. Empty exactly when
// the game is over (checkmate or stalemate).
void zh_legal_moves(ZHPosition& z, std::vector<ZHMove>& out);

// ---- Apply / undo ----

// Snapshot of the ZH-specific (non-Position) state, saved before a move and
// restored on undo — pockets/promoted are tiny (2*7 ints + one U64), so a
// full snapshot-and-restore is simplest-correct rather than hand-computing
// deltas.
struct ZHSnapshot {
    int pockets[COLOR_NB][PIECE_TYPE_NB];
    U64 promoted;
};

// Plays a move already known to be legal (see zh_legal_moves/zh_is_legal).
// `st` is caller-owned StateInfo storage (same contract as Position::do_move)
// — a piece move calls pos.do_move, a drop calls pos.do_drop. Pocket/
// promotion bookkeeping mirrors gomachine's advance() (apply.go): a capture
// drops the victim into the mover's pocket (a captured PROMOTED piece reverts
// to a pawn), and the promoted-square set follows a promoting/moving piece.
// Does NOT append to `z.history` (mirrors gomachine's advance vs applyLegal
// split — the search hot path skips repetition bookkeeping); callers that
// need threefold (HTTP /move, /bestmove) push z.pos.key()-based zh_key
// themselves via zh_apply.
void zh_do(ZHPosition& z, const ZHMove& m, StateInfo& st, ZHSnapshot& save);
void zh_undo(ZHPosition& z, const ZHMove& m, const ZHSnapshot& save);

// zh_do + records the pre-move composite key into z.history (mirrors
// gomachine's applyLegal) — what the HTTP handlers use (never undone; each
// HTTP call parses a throwaway ZHPosition from a FEN and applies exactly one
// move to it).
void zh_apply(ZHPosition& z, const ZHMove& m);

bool zh_is_legal(ZHPosition& z, const ZHMove& m);

// Parses a UCI/drop move string AND validates it's legal in z, filling `out`
// on success. This is what the HTTP handlers (and zh_apply's callers) use —
// a drop is checked against zh_legal_moves (pocket + empty-square + pawn-rank
// + king-safety); a plain move string is resolved+validated in one step via
// Rules::parse_uci_move (which only returns a move if it is FULLY legal).
bool zh_parse_and_validate(ZHPosition& z, const std::string& s, ZHMove& out);

// ---- Status ----

enum class ZHStatus { Ongoing, WhiteWin, BlackWin, Draw };

// A "mate" is real only when NO legal drop also escapes the check —
// zh_legal_moves already includes drops, so no legal move + in check is
// genuine checkmate; no legal move without check is stalemate. Also checks
// threefold (via z.history) and a 400-fullmove safety-valve draw (mirrors
// gomachine's drawMoveCap).
ZHStatus zh_status(ZHPosition& z);
std::string zh_status_result(ZHStatus st); // "1-0"/"0-1"/"1/2-1/2"/""

// SAN for a legal move: "<PIECE>@<square>" for a drop, standard SAN
// (Rules::san, stripped of its +/# suffix) for a piece move, with the +/#
// suffix recomputed ZH-aware (a standard-chess "mate" may not be one here —
// a drop can interpose).
std::string zh_san(ZHPosition& z, const ZHMove& m);

// ---- Eval ----

// Centipawns from the SIDE-TO-MOVE's perspective: board material + a small
// center term + pocket material + a drop-aware king-danger term. Verbatim
// port of gomachine's crazyhouse.evaluate (eval.go) — constants unchanged.
int zh_evaluate(const ZHPosition& z);

// ---- Search ----

struct ZHLimits {
    int rating = 0;   // 0 = unset
    int level = -1;   // -1 = unset
    int depth = 0;    // 0 = unset
    int movetimeMs = 0;
    uint64_t nodes = 0;
};

struct ZHResult {
    std::string move;
    int score = 0;
    int mate = 0; // signed mate-in-N (moves); 0 if not a forced mate
    bool hasMove = false;
    int depth = 0;
    uint64_t nodes = 0;
};

// Iterative-deepening alpha-beta with capture/check quiescence, then
// deterministic rating-derived weakening — a close port of gomachine's
// crazyhouse.BestMove (search.go): same depth ladder / noise / blunder
// constants per rating band, so bot difficulty feels the same as before the
// engine swap. Does not mutate z (works on an internal copy of the position
// state via zh_do/zh_undo + restore).
ZHResult zh_best_move(ZHPosition& z, const ZHLimits& lim);

// ---- Perft (validation only — not used by serve) ----

uint64_t zh_perft(ZHPosition& z, int depth);

// CLI entry point: `./zugzwang zhperft <fen> <depth> [divide]`. Prints the
// node count (and a divide breakdown) to stdout; returns a process exit code.
int zh_perft_main(int argc, char** argv);
