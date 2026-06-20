#!/usr/bin/env python3
"""Generate a point-symmetric endgame opening book for SPRT-ing endgame eval terms.

Each position is built from a WHITE-only setup (king + optional minor + pawns) and
its 180° rotation for Black (square s -> 63-s, same piece type). A point-symmetric
position with White to move is theoretically dead-equal (~0.00), so the book is
balanced by construction (your own analysis of the lost position). King-to-passer
distance is exactly what decides these races, so they are the right instrument to
measure the king-proximity term: a real gain shows up as wins out of a drawn book,
not as converting an already-won position.

Output: one FEN per line (LoadBook reads .fen as one position per line).
"""

FILES = "abcdefgh"


def sq(file_ch, rank):  # rank is 1..8
    return (rank - 1) * 8 + FILES.index(file_ch)


def mirror(idx):
    return 63 - idx


def build(white):
    """white: dict algebraic-square -> piece char (uppercase). Returns FEN."""
    board = [None] * 64
    for alg, pc in white.items():
        idx = sq(alg[0], int(alg[1]))
        board[idx] = pc
        board[mirror(idx)] = pc.lower()  # Black mirror, same type
    rows = []
    for rank in range(8, 0, -1):
        row, empty = "", 0
        for f in range(8):
            pc = board[(rank - 1) * 8 + f]
            if pc is None:
                empty += 1
            else:
                if empty:
                    row += str(empty)
                    empty = 0
                row += pc
        if empty:
            row += str(empty)
        rows.append(row)
    return "/".join(rows) + " w - - 0 1"


# --- White setups (mirrored to Black). Knights/bishops kept off squares that would
#     give check after mirroring; pawns on ranks 2..5. Variety in king placement so
#     the king-to-passer term is genuinely exercised. ---
SETUPS = [
    # A) K+N + three connected queenside pawns -> opposite-wing race (the lost family)
    {"e1": "K", "d1": "N", "a2": "P", "b2": "P", "c2": "P"},   # exact lost position
    {"e2": "K", "f3": "N", "a2": "P", "b2": "P", "c2": "P"},
    {"d2": "K", "c3": "N", "a3": "P", "b2": "P", "c2": "P"},
    {"e1": "K", "g1": "N", "a2": "P", "b3": "P", "c2": "P"},
    {"f1": "K", "d2": "N", "a2": "P", "b2": "P", "c3": "P"},
    {"g1": "K", "e2": "N", "a2": "P", "b2": "P", "c2": "P"},   # king far from pawns
    {"d1": "K", "f2": "N", "a4": "P", "b2": "P", "c2": "P"},   # one advanced
    {"e1": "K", "b1": "N", "a2": "P", "b3": "P", "c4": "P"},   # staggered
    {"c1": "K", "g2": "N", "a2": "P", "b2": "P", "c2": "P"},
    {"e2": "K", "d4": "N", "a3": "P", "b3": "P", "c2": "P"},
    {"f2": "K", "h3": "N", "a2": "P", "b2": "P", "c2": "P"},
    {"d1": "K", "e3": "N", "a2": "P", "b4": "P", "c2": "P"},
    # B) K+N + central/kingside pawn trio (different race geometry)
    {"e1": "K", "c1": "N", "c2": "P", "d2": "P", "e2": "P"},
    {"f1": "K", "d1": "N", "d2": "P", "e2": "P", "f2": "P"},
    {"e2": "K", "g3": "N", "c2": "P", "d3": "P", "e2_dup": None},  # fixed below
    {"d2": "K", "b3": "N", "b2": "P", "c2": "P", "d3": "P"},
    # C) pure K + three pawns (king activity alone decides) — opposite-wing
    {"e1": "K", "a2": "P", "b2": "P", "c2": "P"},
    {"d1": "K", "a2": "P", "b3": "P", "c2": "P"},
    {"f1": "K", "a3": "P", "b2": "P", "c3": "P"},
    {"g1": "K", "a2": "P", "b2": "P", "c2": "P"},   # king on far wing
    {"c2": "K", "a2": "P", "b2": "P", "c3": "P"},   # king escorting already
    {"e2": "K", "a4": "P", "b2": "P", "c2": "P"},
    {"h2": "K", "a2": "P", "b3": "P", "c2": "P"},
    {"e1": "K", "b2": "P", "c2": "P", "d2": "P"},
    # D) pure K + pawns with an outside passer (a-pawn vs mirrored h-pawn)
    {"e1": "K", "a2": "P", "e2": "P", "f2": "P"},
    {"d2": "K", "a3": "P", "f2": "P", "g2": "P"},
    {"e2": "K", "a4": "P", "e3": "P", "f2": "P"},
    {"f1": "K", "a2": "P", "d2": "P", "e2": "P"},
    # E) K + bishop + three pawns
    {"e1": "K", "c1": "B", "a2": "P", "b2": "P", "c2": "P"},
    {"e2": "K", "f1": "B", "a2": "P", "b2": "P", "c2": "P"},
    {"d1": "K", "g2": "B", "a3": "P", "b2": "P", "c2": "P"},
    {"f2": "K", "d3": "B", "c2": "P", "d2": "P", "e2": "P"},
    {"g1": "K", "e3": "B", "a2": "P", "b3": "P", "c2": "P"},
    {"c1": "K", "h2": "B", "a2": "P", "b2": "P", "c3": "P"},
    # F) fewer pawns — K+N+2 and K+B+2 (sharper, lower draw rate)
    {"e1": "K", "d1": "N", "a2": "P", "b2": "P"},
    {"e2": "K", "f3": "N", "b2": "P", "c2": "P"},
    {"d2": "K", "c3": "N", "a3": "P", "c2": "P"},
    {"e1": "K", "c1": "B", "a2": "P", "b2": "P"},
    {"f1": "K", "d2": "B", "b2": "P", "c3": "P"},
    {"g1": "K", "e2": "N", "a2": "P", "c2": "P"},
    # G) K+N + four pawns (longer races)
    {"e1": "K", "d1": "N", "a2": "P", "b2": "P", "c2": "P", "h2": "P"},
    {"e2": "K", "f3": "N", "a2": "P", "b2": "P", "c2": "P", "g3_x": None},  # fixed below
]


def clean(setup):
    return {k: v for k, v in setup.items() if v is not None and not k.endswith(("_dup", "_x"))}


# Repair the two intentionally-broken rows above (kept the slot to preserve count).
SETUPS[14] = {"e2": "K", "g3": "N", "c2": "P", "d3": "P", "e3": "P"}
SETUPS[40] = {"e2": "K", "f3": "N", "a2": "P", "b2": "P", "c2": "P", "g3": "P"}

# --- EXTRA material variety for the GATING book (post-tune SPRT). Point symmetry
#     forces same material both sides and preserves bishop color, so OCB and
#     material imbalance can't come from here — those need curated asymmetric
#     positions (TODO). What it DOES give: rook endings (where king-proximity is
#     famously nuanced — rook-behind-passer, key squares — so the term can mislead
#     and we want to catch that), more pure K+P, single-minor, and opposition
#     battles where closing on the stop square is the WRONG idea. ---
EXTRA = [
    # H) rook endings (K+R+pawns) — the sharpest test of "approach vs hold".
    #    NOTE: the rook must not sit on the file of the mirrored enemy king (d-file,
    #    since Ke1->Kd8) unless a pawn blocks it, or White's move leaves Black in
    #    check down the open file (illegal). Rooks placed off the d-file / blocked.
    {"e1": "K", "b1": "R", "a2": "P", "b2": "P", "c2": "P"},   # rook behind b-pawn
    {"e1": "K", "a1": "R", "a2": "P", "b2": "P", "c2": "P"},   # rook behind own passer
    {"f1": "K", "e1": "R", "b2": "P", "c2": "P", "d2": "P"},
    {"g1": "K", "h1": "R", "a2": "P", "b2": "P", "c2": "P"},   # king far, rook on h-file
    {"e2": "K", "h1": "R", "a3": "P", "b2": "P", "c2": "P"},
    {"e1": "K", "b1": "R", "a2": "P", "b2": "P"},              # K+R+2P
    {"f1": "K", "c1": "R", "f2": "P", "g2": "P"},
    # more rook endings (the class most at risk of king-proximity mislead — we want
    # a robust per-class read). Any illegal mirror is dropped by the perft filter.
    {"d2": "K", "a1": "R", "a4": "P", "b2": "P", "c2": "P"},   # advanced passer, rook behind
    {"f2": "K", "b1": "R", "a2": "P", "b2": "P", "c3": "P"},
    {"e1": "K", "h2": "R", "b2": "P", "c2": "P", "d2": "P"},   # rook on the flank
    {"g2": "K", "a1": "R", "a2": "P", "b2": "P"},              # king far, rook behind passer
    {"e2": "K", "c1": "R", "c2": "P", "d2": "P", "e3": "P"},   # central pawns
    {"d1": "K", "h1": "R", "a2": "P", "b3": "P", "c2": "P"},
    {"c2": "K", "a1": "R", "a3": "P", "b2": "P"},              # king escorting + rook behind
    # I) pure K+P with richer pawn geometry (4 pawns, split majorities, outside passer)
    {"e1": "K", "a2": "P", "b2": "P", "g2": "P", "h2": "P"},   # split majorities
    {"d1": "K", "a2": "P", "b2": "P", "c2": "P", "d3": "P"},   # 4 connected
    {"e2": "K", "a2": "P", "b3": "P", "c2": "P", "h3": "P"},   # 3 + outside passer
    {"f2": "K", "b2": "P", "c2": "P", "f2_x": None},           # fixed below
    # J) single minor + four pawns (longer conversion)
    {"e1": "K", "d1": "N", "a2": "P", "b2": "P", "c2": "P", "d2": "P"},
    {"e1": "K", "c1": "B", "a2": "P", "b2": "P", "c2": "P", "h2": "P"},
    {"d2": "K", "f3": "N", "c2": "P", "d2_x": None},           # fixed below
    # K) opposition / key-square battles — king should take opposition or hold a
    #    key square, NOT generically close on the stop square (term mislead test)
    {"e1": "K", "e2": "P"},                                    # K+P vs K+P, central
    {"d1": "K", "d2": "P"},
    {"c1": "K", "c2": "P", "f2": "P"},
    {"e1": "K", "e3": "P", "a2": "P"},
]
EXTRA[10] = {"f2": "K", "b2": "P", "c2": "P", "d2": "P"}        # repair fixed slot
EXTRA[13] = {"d2": "K", "f3": "N", "c2": "P", "d3": "P", "e2": "P"}


def emit(setups, path):
    seen, out = set(), []
    for s in setups:
        fen = build(clean(s))
        if fen not in seen:
            seen.add(fen)
            out.append(fen)
    with open(path, "w") as fh:
        fh.write("\n".join(out) + "\n")
    return len(out)


import os
here = os.path.dirname(os.path.abspath(__file__))
data = os.path.join(here, "..", "data")
n_t = emit(SETUPS, os.path.join(data, "endgame_book.fen"))
n_m = emit(SETUPS + EXTRA, os.path.join(data, "endgame_book_mixed.fen"))
print(f"targeted: {n_t} positions  ->  data/endgame_book.fen")
print(f"mixed:    {n_m} positions  ->  data/endgame_book_mixed.fen")
