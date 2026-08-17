#!/usr/bin/env python3
"""Wave 3 of the sf-net experiment (docs/tasks/open/sf-net-experiment.md),
measurements 2 and 3: on the existing 560-position corpus
(test/sfnet_corpus.epd + its bit-exact SF oracle test/sfnet_corpus_ref.tsv,
BOTH READ-ONLY, reused as-is), ask:

  (2) How much of SF's blended output ("full") is explained by the psqt
      channel alone vs the positional channel alone, and does that split
      change as positions get more decided?

  (3) What fraction of positions fully rail our own net (l1live == 0),
      bucketed the same way, and is there a relationship between our rail
      rate and how much SF's psqt/positional channels are doing?

Decidedness axis: material imbalance computed directly from each FEN's own
piece counts (P/N/B/R/Q = 100/320/330/500/900, both colors, |white-black|).
This is intentionally NOT derived from psqt or positional -- using |sf_full|
or |psqt| as the decidedness axis would make "psqt explains more of full in
decided positions" partly circular. Material imbalance is an independent,
if imperfect (purely material, ignores positional decidedness), proxy.

Requires the corpus's `full` column from test/sfnet_corpus_ref.tsv, which is
the throwaway-SF-verified oracle blend (commit 3307312: 560/560 reproduced
independently) -- not recomputed here.

Usage:
    make -j8                      # if zugzwang binary is stale
    python3 tools/sfnet_channel_decomp.py > docs/sfnet_channel_summary.txt
    # raw per-row data written to test/sfnet_corpus_rail.tsv
"""
import chess
import collections
import math
import os
import subprocess
import sys

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
ENGINE = os.environ.get("ENG", os.path.join(ROOT, "zugzwang"))
CORPUS_EPD = os.path.join(ROOT, "test", "sfnet_corpus.epd")
CORPUS_REF = os.path.join(ROOT, "test", "sfnet_corpus_ref.tsv")
OUT_TSV = os.path.join(ROOT, "test", "sfnet_corpus_rail.tsv")

VAL = {chess.PAWN: 100, chess.KNIGHT: 320, chess.BISHOP: 330, chess.ROOK: 500, chess.QUEEN: 900}

BINS = [(0, 100), (100, 300), (300, 600), (600, 1000), (1000, 10 ** 9)]


def material_imbalance(fen):
    b = chess.Board(fen)
    w = sum(VAL.get(p.piece_type, 0) for p in b.piece_map().values() if p.color == chess.WHITE)
    bl = sum(VAL.get(p.piece_type, 0) for p in b.piece_map().values() if p.color == chess.BLACK)
    return abs(w - bl)


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
        return ev, 16 - lo - hi


def pearson(xs, ys):
    n = len(xs)
    if n < 2: return float("nan")
    mx = sum(xs) / n; my = sum(ys) / n
    sxy = sum((x - mx) * (y - my) for x, y in zip(xs, ys))
    sxx = sum((x - mx) ** 2 for x in xs)
    syy = sum((y - my) ** 2 for y in ys)
    if sxx == 0 or syy == 0: return float("nan")
    return sxy / math.sqrt(sxx * syy)


def main():
    ref_rows = {}
    with open(CORPUS_REF) as f:
        for line in f:
            parts = line.rstrip("\n").split("\t")
            if len(parts) != 5: continue
            fen, bucket, psqt, positional, full = parts
            ref_rows[fen] = dict(bucket=int(bucket), psqt=int(psqt), positional=int(positional), full=int(full))

    fens = [l.strip() for l in open(CORPUS_EPD) if l.strip()]
    missing = [f for f in fens if f not in ref_rows]
    if missing:
        print("WARNING: %d corpus FENs missing from ref TSV" % len(missing), file=sys.stderr)

    eng = Eng()
    rows = []
    for fen in fens:
        if fen not in ref_rows: continue
        ev, live = eng.probe(fen)
        r = dict(ref_rows[fen])
        r["fen"] = fen
        r["our_eval"] = ev
        r["our_l1live"] = live
        r["material_imb"] = material_imbalance(fen)
        rows.append(r)

    with open(OUT_TSV, "w") as f:
        cols = ["fen", "bucket", "psqt", "positional", "full", "material_imb", "our_eval", "our_l1live"]
        f.write("\t".join(cols) + "\n")
        for r in rows:
            f.write("\t".join(str(r[c]) for c in cols) + "\n")
    print("# wrote %d rows to %s" % (len(rows), OUT_TSV), file=sys.stderr)

    print("=== (2) Channel decomposition: psqt vs positional explaining SF's blended 'full', "
          "binned by material imbalance ===\n")
    print("%-12s %5s %10s %10s %10s | %8s %8s | %8s %8s" % (
        "imb bin", "n", "avg|imb|", "avg|full|", "avg|psqt|", "r(psqt,", "r(pos,", "R2 psqt", "R2 pos"))
    print("%-12s %5s %10s %10s %10s | %8s %8s | %8s %8s" % ("", "", "", "", "", "full)", "full)", "~full", "~full"))
    for lo, hi in BINS:
        sub = [r for r in rows if lo <= r["material_imb"] < hi]
        if len(sub) < 3:
            print("%-12s %5d  (too few for correlation)" % ("[%d,%d)" % (lo, hi), len(sub)))
            continue
        psqts = [r["psqt"] for r in sub]
        poss = [r["positional"] for r in sub]
        fulls = [r["full"] for r in sub]
        rp = pearson(psqts, fulls)
        rq = pearson(poss, fulls)
        avg_imb = sum(r["material_imb"] for r in sub) / len(sub)
        avg_full = sum(abs(r["full"]) for r in sub) / len(sub)
        avg_psqt = sum(abs(r["psqt"]) for r in sub) / len(sub)
        print("%-12s %5d %10.0f %10.0f %10.0f | %8.3f %8.3f | %8.3f %8.3f" % (
            "[%d,%d)" % (lo, hi), len(sub), avg_imb, avg_full, avg_psqt, rp, rq, rp * rp, rq * rq))

    print("\n=== (3) Rail incidence for our net (l1live==0), binned the same way, "
          "vs SF channel behaviour in the same bin ===\n")
    print("%-12s %5s %12s %14s %14s %14s" % (
        "imb bin", "n", "our_live==0", "avg our_live", "std(psqt)", "std(positional)"))
    for lo, hi in BINS:
        sub = [r for r in rows if lo <= r["material_imb"] < hi]
        if not sub: continue
        n = len(sub)
        railed = sum(1 for r in sub if r["our_l1live"] == 0)
        avg_live = sum(r["our_l1live"] for r in sub) / n
        psqts = [r["psqt"] for r in sub]
        poss = [r["positional"] for r in sub]
        def std(xs):
            m = sum(xs) / len(xs)
            return math.sqrt(sum((x - m) ** 2 for x in xs) / len(xs))
        print("%-12s %5d %10d (%4.1f%%) %14.2f %14.1f %14.1f" % (
            "[%d,%d)" % (lo, hi), n, railed, 100.0 * railed / n, avg_live, std(psqts), std(poss)))

    print("\n(raw per-row data: %s)" % OUT_TSV)


if __name__ == "__main__":
    main()
