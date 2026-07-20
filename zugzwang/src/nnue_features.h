#pragma once
#include <vector>
#include "position.h"
#include "types.h"

// Active NNUE feature indices for one perspective (White or Black), computed
// from-scratch off the current board. See spec §2 (base = king-bucketed +
// horizontally-mirrored PSQ; threat = SF full-threats via sfThreatIndex).
//
// IMPORTANT index conventions (bit-exact with gomachine):
//   - base indices  live in [0, PsqSize)          = [0, 12288)
//   - threat indices live in [PsqSize, InputTotal) = [12288, 92144)
//   - gomachine PieceType is 0-indexed (Pawn=0..King=5); chesshce is 1-indexed
//     (PAWN=1..KING=6) — subtract 1 when forming the feature index.
//   - gomachine Color: White=0, Black=1 (matches chesshce WHITE=0/BLACK=1).
namespace NNUE {

struct Features {
    std::vector<int> base;    // [0, 12288)
    std::vector<int> threat;  // [12288, 92144)
};

// Fills `out` with the active base+threat features for `persp`. The perspective's
// own king selects the bucket + horizontal mirror, applied to every feature square.
void active_features(const Position& pos, Color persp, Features& out);

// BoardSnapshot — a lightweight copy of just the piece placement (piece bitboards +
// mailbox) of a position taken BEFORE a move. do_move mutates Position in place, so
// the move-aware threat delta captures this at the top of do_move to still be able to
// query the OLD board once the child is formed. ~136 bytes; cheap to memcpy per node.
//
// LAZYACC2 (see nnue_accumulator.h): changed_edges_delta is templatized on the CHILD
// board type so materialize() can recompute a slot's delta from two stored
// BoardSnapshots (parent.childBoard, this.childBoard) instead of a live Position.
// That requires a BoardSnapshot to answer every query the delta machinery makes of
// `child` — king_square/pieces()/castling_rook_square, alongside the pre-existing
// occ/piece_on/pieces(c,pt)/attackers_to. castlingRookFrom mirrors Position's (fixed
// for the whole game — see Position::castling_rook_square), needed only by
// THREATDELTA_SF's build_touch_plan_sf when Board=BoardSnapshot; filled by
// Position::fill_board_snapshot alongside the piece-placement arrays.
struct BoardSnapshot {
    U64    byType[PIECE_TYPE_NB];
    U64    byColor[COLOR_NB];
    Piece  board[SQUARE_NB];
    Square castlingRookFrom[4]; // indexed WHITE_OO=0,WHITE_OOO=1,BLACK_OO=2,BLACK_OOO=3 (Position::castling_right_index order)
    U64    occ()                          const { return byType[0]; }
    U64    pieces()                       const { return occ(); }   // all-occupancy, matches Position::pieces()
    Piece  piece_on(Square s)             const { return board[s]; }
    U64    pieces(Color c, PieceType pt)  const { return byColor[c] & byType[pt]; }
    U64    attackers_to(Square s, U64 o)  const { return Position::attackers_to(byType, byColor, s, o); }
    Square king_square(Color c)           const { return BB::lsb(pieces(c, KING)); }
    Square castling_rook_square(int right) const {
        const int idx = (right == WHITE_OO) ? 0 : (right == WHITE_OOO) ? 1 : (right == BLACK_OO) ? 2 : 3;
        return castlingRookFrom[idx];
    }
};

// changed_edges_delta — the move-aware threat delta (cut-1 "correct-by-construction
// enumerate" variant, mirroring gomachine's pushMoveAwareEnumerate). Given the pre-move
// board `oldb` and the fully-formed child, it appends the flat base+threat feature
// indices to SUBTRACT (parent) and ADD (child) so the incremental halves reach the
// child's active set — for whichever perspectives are requested (doW/doB). A requested
// perspective's king MUST NOT have crossed a bucket/mirror boundary (callers rebuild
// such halves from scratch instead). Index encoding is byte-identical to
// active_features (both route threats through the same emit path).
// `baseSkip*` = true means: for that perspective, emit ONLY threat deltas — skip the
// base-768 D-loop entirely — because the caller is instead doing a full base-column
// swap via `emit_base_swap` (a bucket-cross-same-mirror king move: base shifts by the
// bucket offset for EVERY piece, not just the D squares, so the cheap D-loop diff would
// be wrong; the threat loops stay correct because this perspective's mirror — and hence
// every threat feature index — did not change). Default false = current behavior
// (base D-loop always runs alongside the threat delta).
void changed_edges_delta(const BoardSnapshot& oldb, const Position& child,
                         bool doW, std::vector<int>& subW, std::vector<int>& addW,
                         bool doB, std::vector<int>& subB, std::vector<int>& addB,
                         bool baseSkipW = false, bool baseSkipB = false);

// LAZYACC2 overload — identical semantics, `child` is a stored BoardSnapshot instead of
// a live Position (materialize() recomputing a deferred delta from two saved boards).
// Both share one templated implementation (changed_edges_delta_impl in the .cpp); this
// is just the second concrete instantiation exposed to callers outside the .cpp.
void changed_edges_delta(const BoardSnapshot& oldb, const BoardSnapshot& child,
                         bool doW, std::vector<int>& subW, std::vector<int>& addW,
                         bool doB, std::vector<int>& subB, std::vector<int>& addB,
                         bool baseSkipW = false, bool baseSkipB = false);

// perspective_bucket_key packs (bucket, mirror) for `persp`'s king square into a small
// int — a king move that changes this key invalidates that perspective's incremental
// delta (new bucket copy or every square reflected) and forces a from-scratch refresh.
int perspective_bucket_key(Square ksq, Color persp);

// THREATGATE (default OFF): on a king move that changes the base bucket but NOT the
// mirror, keep the threat half on the delta path (threat indices are mirror-only — see
// `perspective_mirror`) and swap only the base columns via `emit_base_swap`. This is
// byte-identical to a full refresh (see `emit_base_swap`'s comment for the proof) and
// targets the dominant (≤128-feature threat rebuild) cost on the common case where a
// king move crosses a rank-bucket boundary without crossing the d/e mirror line. SF18
// takes exactly this shortcut: `FullThreats::requires_refresh` gates on the mirror bit
// only (`& 0b100`), not the finer PSQ bucket — this is the same optimization applied to
// our king-bucketed (not just mirrored) base block. THREATGATE=0/unset => legacy full
// refresh on ANY bucket-or-mirror cross, i.e. byte-identical to the pre-THREATGATE code.
bool threat_gate_enabled();

// perspective_mirror — just the mirror bit (0 or 7) of persp's king transform, i.e. the
// `PerspXform::mir` half of `perspective_bucket_key` without the bucket term. A king
// move that leaves this unchanged keeps every threat feature index stable for `persp`
// (threat indices are built from `x.orient(sq)` = `^56`(black)`^mir` — no bucket term —
// so the mirror bit is the ONLY part of the king transform threats depend on).
int perspective_mirror(Square ksq, Color persp);

// emit_base_swap — for each requested perspective, append the FULL base-768 swap for a
// bucket-cross-same-mirror king move: subtract every piece's base index under the OLD
// king transform (from `oldb`), add every piece's base index under the NEW king
// transform (from `child`). Threats are handled separately (by `changed_edges_delta`
// with `baseSkip*` set) since the mirror — and hence every threat index — is unchanged.
// Appends to the same sub/add lists `changed_edges_delta` uses, so a single `apply_diff`
// call applies both the threat delta and the base swap together.
void emit_base_swap(const BoardSnapshot& oldb, const Position& child,
                    bool doW, std::vector<int>& subW, std::vector<int>& addW,
                    bool doB, std::vector<int>& subB, std::vector<int>& addB);

// threat_delta_enabled reads the THREATDELTA env once (default ON, banked +43 Elo):
// THREATDELTA=0 is the parity/debug kill-switch back to the full-enumerate push().
bool threat_delta_enabled();

// threat_delta_fast_enabled reads THREATDELTA_FAST once (default OFF): =1 switches
// changed_edges_delta's Group-2 (attacker-identity-unchanged) inner loop from the
// enumerate variant's full old/new edge re-enumeration to the leaper/slider
// masked-line diff (docs/tasks/open/threat-delta-followon.md §1) — fewer threatIndex
// calls, byte-identical resulting edge multiset. Only meaningful when
// threat_delta_enabled() is true.
bool threat_delta_fast_enabled();

// threat_delta_sf_enabled reads THREATDELTA_SF once (default OFF): =1 switches
// changed_edges_delta's per-perspective threat loop to the SF18-ported "touch-only-D"
// path (docs/tasks — SF18 touch-only-D port spec): rather than building an `affected`
// set (D plus every attacker of a D square under old/new occupancy) and re-emitting
// each affected attacker's FULL edge set, it touches ONLY the <=4 D squares directly,
// emitting each touched piece's own outgoing edges, the touched square's incoming edges
// (one threatIndex call per attacker), and one discovered/blocked edge per slider found
// while computing incoming edges. Byte-identical resulting edge multiset to the
// enumerate path (ASSERT-checked) — a third, mutually-exclusive alternative to
// threat_delta_fast_enabled()'s masked-line diff, not a replacement for it. The
// enumerate path remains the default/oracle; THREATDELTA_SF=0/unset leaves behavior
// byte-for-byte unchanged. Only meaningful when threat_delta_enabled() is true.
bool threat_delta_sf_enabled();

} // namespace NNUE
