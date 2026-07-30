#!/usr/bin/env python3
"""Suggestion quality against an INDEPENDENT oracle.

The complaint is that the moves zugzwang suggests get worse the further the eval is
from zero.  Measuring that with zugzwang's own deep search would be circular, so the
oracle is Stockfish 18, which has a linear psqt head and does not collapse in ordinary
up/down-a-piece positions.  Metric: how often zug's 300ms move matches SF's 1s move,
over positions where zug's eval is fully railed.
"""
import chess, os, subprocess

ZUG = os.environ.get("ENG", "/tmp/zugsoft/zugzwang/zugzwang")
SF  = "/Users/tim.alexander/sf18-arm/src/stockfish"
MT  = int(os.environ.get("MT", "300"))
SFMT = int(os.environ.get("SFMT", "1000"))
VAL = {chess.PAWN:100, chess.KNIGHT:320, chess.BISHOP:330, chess.ROOK:500, chess.QUEEN:900}

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
LADDER = [("q",), ("q","r"), ("r",), ("n","b"), ("q","r","n"), ("r","n")]

class Eng:
    def __init__(self, path, env=None):
        self.p = subprocess.Popen([path], stdin=subprocess.PIPE, stdout=subprocess.PIPE,
                                  stderr=subprocess.DEVNULL, text=True, bufsize=1,
                                  env=dict(os.environ, **(env or {})),
                                  cwd=os.path.dirname(path))
        self.send("uci"); self.wait("uciok")
    def send(self, s): self.p.stdin.write(s+"\n"); self.p.stdin.flush()
    def wait(self, tok):
        while True:
            l = self.p.stdout.readline()
            if not l: raise RuntimeError("engine died")
            if l.startswith(tok): return l.strip()
    def best(self, fen, ms):
        self.send("position fen "+fen); self.send("go movetime %d" % ms)
        return self.wait("bestmove").split()[1]
    def railed(self, fen):
        self.send("position fen "+fen); self.send("eval")
        t = self.wait("eval").split()
        lo, hi = map(int, t[4].split("/"))
        return (16 - lo - hi) == 0

def positions():
    probe = Eng(ZUG, {"SATDIAG": "1"})
    out = []
    for base in MIDDLEGAMES:
        for syms in LADDER:
            for role in ("LOSING", "WINNING"):
                b = chess.Board(base + " w - - 0 1")
                ok = True
                for s in syms:
                    pt = chess.Piece.from_symbol(s).piece_type
                    sq = next((q for q in b.pieces(pt, chess.BLACK)), None)
                    if sq is None: ok = False; break
                    b.remove_piece_at(sq)
                if not ok: continue
                b.turn = chess.BLACK if role == "LOSING" else chess.WHITE
                if not b.is_valid(): continue
                fen = b.fen()
                if probe.railed(fen):          # only collapsed positions matter here
                    out.append((role, fen))
    probe.p.kill()
    return out

pos = positions()
sf  = Eng(SF)
print("collapsed positions: %d (SF oracle at %dms, zug at %dms)" % (len(pos), SFMT, MT))
oracle = {}
for role, fen in pos:
    oracle[fen] = sf.best(fen, SFMT)
sf.p.kill()

for label, env in (("baseline", {}), ("SATSOFT", {"SATSOFT": "1000"})):
    e = Eng(ZUG, env)
    agree = {"LOSING": [0, 0], "WINNING": [0, 0]}
    for role, fen in pos:
        m = e.best(fen, MT)
        agree[role][1] += 1
        if m == oracle[fen]: agree[role][0] += 1
    e.p.kill()
    tot = sum(a[0] for a in agree.values()); n = sum(a[1] for a in agree.values())
    print("  %-9s agrees with SF18: %3d/%3d = %5.1f%%   (LOSING %4.1f%%  WINNING %4.1f%%)"
          % (label, tot, n, 100.0*tot/n,
             100.0*agree["LOSING"][0]/max(agree["LOSING"][1],1),
             100.0*agree["WINNING"][0]/max(agree["WINNING"][1],1)))
