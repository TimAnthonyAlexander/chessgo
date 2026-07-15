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
struct BoardSnapshot {
    U64   byType[PIECE_TYPE_NB];
    U64   byColor[COLOR_NB];
    Piece board[SQUARE_NB];
    U64   occ()                          const { return byType[0]; }
    Piece piece_on(Square s)             const { return board[s]; }
    U64   pieces(Color c, PieceType pt)  const { return byColor[c] & byType[pt]; }
    U64   attackers_to(Square s, U64 o)  const { return Position::attackers_to(byType, byColor, s, o); }
};

// changed_edges_delta — the move-aware threat delta (cut-1 "correct-by-construction
// enumerate" variant, mirroring gomachine's pushMoveAwareEnumerate). Given the pre-move
// board `oldb` and the fully-formed child, it appends the flat base+threat feature
// indices to SUBTRACT (parent) and ADD (child) so the incremental halves reach the
// child's active set — for whichever perspectives are requested (doW/doB). A requested
// perspective's king MUST NOT have crossed a bucket/mirror boundary (callers rebuild
// such halves from scratch instead). Index encoding is byte-identical to
// active_features (both route threats through the same emit path).
void changed_edges_delta(const BoardSnapshot& oldb, const Position& child,
                         bool doW, std::vector<int>& subW, std::vector<int>& addW,
                         bool doB, std::vector<int>& subB, std::vector<int>& addB);

// perspective_bucket_key packs (bucket, mirror) for `persp`'s king square into a small
// int — a king move that changes this key invalidates that perspective's incremental
// delta (new bucket copy or every square reflected) and forces a from-scratch refresh.
int perspective_bucket_key(Square ksq, Color persp);

// threat_delta_enabled reads the THREATDELTA env once (default ON, banked +43 Elo):
// THREATDELTA=0 is the parity/debug kill-switch back to the full-enumerate push().
bool threat_delta_enabled();

} // namespace NNUE
