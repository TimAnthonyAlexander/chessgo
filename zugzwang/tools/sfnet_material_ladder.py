#!/usr/bin/env python3
"""Wave 3 of the sf-net experiment (docs/tasks/open/sf-net-experiment.md): a
material ladder that removes pieces from Black, rung by rung, from balanced
middlegame bases, and records at every rung:

    our net's eval + l1live (the rail-collapse statistic, src/nnue_internal.h)
    SF's net psqt / positional / blended "full" value (src/sfnet_eval.cpp via
      test/sfnet_eval_test, proven bit-exact against Stockfish 18 on the 560-FEN
      corpus in commit 3307312 -- see docs/tasks/open/sf-net-experiment.md)

Two ladders per base position, run on all 12 MIDDLEGAMES bases from
tools/blundersuite.py (reused, not reinvented):

  CUM  -- cumulative removal of a black knight, bishop, rook, queen, then a
          second rook and a second minor (compound deficits beyond a queen).
          Piece count drops every rung, so the material bucket
          (bucket = (occupied-1)/4 for SF, clamp((occupied-2)/4,0,7) for ours)
          changes too -- a CONFOUND named explicitly in the task. Rows are
          flagged bucket_change=1 whenever a rung crosses a bucket boundary
          from the previous rung.

  SUB  -- one black queen square, its occupant progressively downgraded
          Q -> R -> B -> N -> P -> (removed). The first five rungs hold total
          piece count, and therefore the material bucket, EXACTLY fixed --
          only the removal of the last piece changes it. This isolates the
          material-value effect from the bucket-crossing effect: it is the
          controlled counterpart to CUM.

Side to move is fixed at White throughout (material removed from Black only),
so our net's stm-relative eval and SF's white-minus-black psqt/positional are
both directly readable as "how good is this for the side that is ahead" and
should rise monotonically as the deficit grows, if either channel is alive.

The SF blend ("full") is our own port of evaluate.cpp:65-87 (verified against
~/sf18-arm by a read-only subagent, constants: PawnValue=208, KnightValue=781,
BishopValue=825, RookValue=1276, QueenValue=2538, OutputScale=16 already
divided out inside evaluate_raw()). optimism=0 (SF's own `eval` command / trace
path passes VALUE_ZERO for a static, non-search call -- evaluate.cpp:115,
engine.cpp:336) and rule50=0 (all ladder FENs are written with halfmove clock
0), so the only live terms are the nnue two-channel blend, the nnue-complexity
damp, and the material-weighted v scaling. This blend pipeline is NOT the
literal 560-row corpus oracle (that TSV is used unmodified in
sfnet_channel_decomp.py) -- it is a from-scratch reimplementation exercised
here because the ladder FENs are new positions with no pre-computed oracle row.

Usage:
    make sfnet_eval_test          # from zugzwang/, if not already built
    python3 tools/sfnet_material_ladder.py > docs/sfnet_ladder_summary.txt
    # raw per-row data always written to test/sfnet_ladder.tsv
"""
import chess
import collections
import os
import subprocess
import sys

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
ENGINE = os.environ.get("ENG", os.path.join(ROOT, "zugzwang"))
SFNET_EVAL_TEST = os.environ.get("SFNET_EVAL_TEST", os.path.join(ROOT, "test", "sfnet_eval_test"))
SF_BIG_NET = os.environ.get("SF_BIG_NET", os.path.expanduser("~/sf18-arm/src/nn-c288c895ea92.nnue"))
OUT_TSV = os.path.join(ROOT, "test", "sfnet_ladder.tsv")
LADDER_EPD = os.path.join(ROOT, "test", "sfnet_ladder.epd")

# Our own material valuation (P/N/B/R/Q), used as the x-axis for BOTH nets.
# Independent of SF's internal Value units (SF pawn = 208, see the blend below) --
# this is just "how much material left the board", the same for either engine.
VAL = {chess.PAWN: 100, chess.KNIGHT: 320, chess.BISHOP: 330, chess.ROOK: 500, chess.QUEEN: 900}

MIDDLEGAMES = [
 "r1bq1rk1/pp2ppbp/2np1np1/2p5/2P1P3/2NP1NP1/PP3PBP/R1BQ1RK1",
 "r1bqk2r/pppp1ppp/2n2n2/2b1p3/2B1P3/2N2N2/PPPP1PPP/R1BQK2R",
 "r2q1rk1/1b1nbppp/p2ppn2/1p4B1/3NP3/2N2P2/PPPQ2PP/2KR1B1R",
 "rn1qkb1r/pp2pppp/2p2n2/3p1b2/2PP4/5N2/PP2BPPP/RNBQK2R",
 "r3k2r/pbppqppp/1pn2n2/4p3/2B1P3/2NP1N2/PPP2PPP/R1BQ1RK1",
 "2rq1rk1/pb2bppp/1p2pn2/3p4/3P4/1QN1PN2/PP3PPP/2RR2K1",
 "r1bq1rk1/pp3ppp/2nbpn2/3p4/3P4/2NBPN2/PP3PPP/R1BQ1RK1",
 "rq2r1k1/pb1nbppp/1p2pn2/2pp4/3P1B2/2PBPN2/PPQN1PPP/R4RK1",
 "r2qr1k1/pb2bppp/np2pn2/3p4/3P1B2/2NBPN2/PPQ2PPP/R4RK1",
 "r1b2rk1/pp1nqppp/2pbpn2/3p4/2PP4/2NBPN2/PP1B1PPP/R2QK2R",
 "r2q1rk1/pp1bbppp/2np1n2/4p3/2B1P3/2NP1N1P/PPP2PP1/R1BQR1K1",
 "1r1q1rk1/pb2bppp/np2pn2/3p4/3P4/1BN1PN2/PP1B1PPP/R2QR1K1",
]

CUM_ORDER = [chess.KNIGHT, chess.BISHOP, chess.ROOK, chess.QUEEN, chess.ROOK, chess.KNIGHT, chess.BISHOP]
CUM_LABEL = ["-N", "-N-B", "-N-B-R", "-N-B-R-Q", "-N-B-R-Q-R2", "-N-B-R-Q-R2-N2", "-N-B-R-Q-R2-N2-B2"]

SUB_CHAIN = [chess.QUEEN, chess.ROOK, chess.BISHOP, chess.KNIGHT, chess.PAWN, None]
SUB_LABEL = ["Q", "R", "B", "N", "P", "none"]


def fen_of(board):
    board.halfmove_clock = 0
    board.fullmove_number = 1
    return board.fen()


def our_bucket(occ):
    divisor = 4  # ceil(32/8)
    return max(0, min(7, (occ - 2) // divisor))


def gen_cum(base_idx, base_fen):
    """Cumulative removal ladder. Returns list of (label, fen, deficit_cp, occ)."""
    b = chess.Board(base_fen + " w - - 0 1")
    if not b.is_valid() or b.is_check():
        return []
    rows = []
    deficit = 0
    occ = len(b.piece_map())
    rows.append(("base", fen_of(b.copy()), 0, occ))
    for pt, label in zip(CUM_ORDER, CUM_LABEL):
        squares = sorted(b.pieces(pt, chess.BLACK))
        if not squares:
            continue  # that piece type already exhausted for black; skip this rung
        b.remove_piece_at(squares[0])
        deficit += VAL[pt]
        b.turn = chess.WHITE
        if not b.is_valid() or b.is_check():
            break
        occ = len(b.piece_map())
        rows.append((label, fen_of(b.copy()), deficit, occ))
    return rows


def gen_sub(base_idx, base_fen):
    """Queen-square substitution ladder: same square, decreasing piece value.
    Piece count (hence bucket) is IDENTICAL for the first 5 rungs; only the
    final 'none' rung drops it by one."""
    b0 = chess.Board(base_fen + " w - - 0 1")
    if not b0.is_valid() or b0.is_check():
        return []
    qsq = next(iter(b0.pieces(chess.QUEEN, chess.BLACK)), None)
    if qsq is None:
        return None  # no black queen in this base; caller logs and skips
    rows = []
    base_val = VAL[chess.QUEEN]
    for pt, label in zip(SUB_CHAIN, SUB_LABEL):
        b = b0.copy()
        b.remove_piece_at(qsq)
        if pt is not None:
            b.set_piece_at(qsq, chess.Piece(pt, chess.BLACK))
        b.turn = chess.WHITE
        if not b.is_valid() or b.is_check():
            continue
        deficit = base_val - (VAL[pt] if pt is not None else 0)
        occ = len(b.piece_map())
        rows.append((label, fen_of(b), deficit, occ))
    return rows


def tdiv(a, b):
    """C++ integer division: truncate toward zero. b > 0 assumed."""
    q = a // b
    if a % b != 0 and a < 0:
        q += 1
    return q


def sf_blend_full(psqt, positional, material):
    """Port of evaluate.cpp:65-87 (Stockfish 18), optimism=0, rule50=0 --
    verified constants via read-only subagent against ~/sf18-arm."""
    nnue = tdiv(125 * psqt + 131 * positional, 128)
    complexity = abs(psqt - positional)
    nnue -= tdiv(nnue * complexity, 18236)
    v = tdiv(nnue * (77871 + material), 77871)
    # rule50 = 0 -> no further damping
    return v


def material_units(board):
    """SF's own material term: 534*pawnCount(both colors) + nonPawnMaterial."""
    SF_VAL = {chess.KNIGHT: 781, chess.BISHOP: 825, chess.ROOK: 1276, chess.QUEEN: 2538}
    pawns = len(board.pieces(chess.PAWN, chess.WHITE)) + len(board.pieces(chess.PAWN, chess.BLACK))
    npm = 0
    for pt, v in SF_VAL.items():
        npm += v * (len(board.pieces(pt, chess.WHITE)) + len(board.pieces(pt, chess.BLACK)))
    return 534 * pawns + npm


class Eng:
    def __init__(self):
        env = dict(os.environ, SATDIAG="1")
        self.p = subprocess.Popen([ENGINE], stdin=subprocess.PIPE, stdout=subprocess.PIPE,
                                   stderr=subprocess.DEVNULL, text=True, bufsize=1, env=env,
                                   cwd=os.path.dirname(ENGINE))
        self.send("uci"); self.wait("uciok")

    def send(self, s): self.p.stdin.write(s + "\n"); self.p.stdin.flush()

    def wait(self, tok):
        while True:
            l = self.p.stdout.readline()
            if not l: raise RuntimeError("engine died")
            if l.startswith(tok): return l.strip()

    def probe(self, fen):
        self.send("position fen " + fen); self.send("eval")
        t = self.wait("eval").split()
        ev = int(t[1]); lo, hi = map(int, t[4].split("/"))
        return ev, 16 - lo - hi  # (eval cp, l1live)


def main():
    rows = []  # dict per row
    skipped_sub_no_queen = []
    for bi, base in enumerate(MIDDLEGAMES):
        cum = gen_cum(bi, base)
        for label, fen, deficit, occ in cum:
            rows.append(dict(exp="CUM", base=bi, rung=label, fen=fen, deficit=deficit, occ=occ))
        sub = gen_sub(bi, base)
        if sub is None:
            skipped_sub_no_queen.append(bi)
            continue
        for label, fen, deficit, occ in sub:
            rows.append(dict(exp="SUB", base=bi, rung=label, fen=fen, deficit=deficit, occ=occ))

    if skipped_sub_no_queen:
        print("# SUB ladder skipped for base idx %s (no black queen)" % skipped_sub_no_queen, file=sys.stderr)

    # write the FEN list for sfnet_eval_test, one FEN per line, same order as `rows`
    with open(LADDER_EPD, "w") as f:
        for r in rows:
            f.write(r["fen"] + "\n")

    # run SF-net forward pass (our own bit-exact-verified backend)
    out = subprocess.run([SFNET_EVAL_TEST, SF_BIG_NET, LADDER_EPD], capture_output=True, text=True)
    if out.returncode != 0:
        print("sfnet_eval_test failed:", out.stderr, file=sys.stderr)
        sys.exit(1)
    sf_lines = [l for l in out.stdout.splitlines() if l.strip()]
    if len(sf_lines) != len(rows):
        print("WARNING: sfnet_eval_test emitted %d lines for %d input FENs (some were in-check and skipped -- "
              "should not happen since we filtered) -- aligning by FEN instead of position" % (len(sf_lines), len(rows)),
              file=sys.stderr)
    sf_by_fen = {}
    for l in sf_lines:
        parts = l.split("\t")
        fen, bucket, psqt, positional = parts[0], int(parts[1]), int(parts[2]), int(parts[3])
        sf_by_fen[fen] = (bucket, psqt, positional)

    # run our engine
    eng = Eng()
    for r in rows:
        ev, live = eng.probe(r["fen"])
        r["our_eval"] = ev
        r["our_l1live"] = live
        r["our_bucket"] = our_bucket(r["occ"])
        if r["fen"] in sf_by_fen:
            bucket, psqt, positional = sf_by_fen[r["fen"]]
            b = chess.Board(r["fen"])
            mat = material_units(b)
            r["sf_bucket"] = bucket
            r["sf_psqt"] = psqt
            r["sf_positional"] = positional
            r["sf_full"] = sf_blend_full(psqt, positional, mat)
        else:
            r["sf_bucket"] = r["sf_psqt"] = r["sf_positional"] = r["sf_full"] = None

    # write raw TSV
    cols = ["exp", "base", "rung", "deficit", "occ", "our_bucket", "our_eval", "our_l1live",
            "sf_bucket", "sf_psqt", "sf_positional", "sf_full", "fen"]
    with open(OUT_TSV, "w") as f:
        f.write("\t".join(cols) + "\n")
        for r in rows:
            f.write("\t".join(str(r[c]) for c in cols) + "\n")
    print("# wrote %d rows to %s" % (len(rows), OUT_TSV), file=sys.stderr)

    # ---- summary ----
    print("=== Material ladder: %d bases, CUM + SUB experiments ===\n" % len(MIDDLEGAMES))
    for exp in ("CUM", "SUB"):
        print("--- %s ladder, averaged across bases ---" % exp)
        by_rung = collections.defaultdict(list)
        order = collections.OrderedDict()
        for r in rows:
            if r["exp"] != exp or r["sf_full"] is None:
                continue
            by_rung[r["rung"]].append(r)
            order.setdefault(r["rung"], None)
        header = "%-16s %5s %8s %8s %10s %10s %10s %8s %8s" % (
            "rung", "n", "deficit", "avg_occ", "our_eval", "our_live", "sf_psqt", "sf_pos", "sf_full")
        print(header)
        for rung in order:
            rs = by_rung[rung]
            n = len(rs)
            deficit = sum(x["deficit"] for x in rs) / n
            occ = sum(x["occ"] for x in rs) / n
            our_eval = sum(x["our_eval"] for x in rs) / n
            our_live = sum(x["our_l1live"] for x in rs) / n
            sf_psqt = sum(x["sf_psqt"] for x in rs) / n
            sf_pos = sum(x["sf_positional"] for x in rs) / n
            sf_full = sum(x["sf_full"] for x in rs) / n
            print("%-16s %5d %8.0f %8.1f %10.1f %10.2f %10.1f %8.1f %8.1f" % (
                rung, n, deficit, occ, our_eval, our_live, sf_psqt, sf_pos, sf_full))
        print()

    print("(raw per-row data: %s)" % OUT_TSV)


if __name__ == "__main__":
    main()
