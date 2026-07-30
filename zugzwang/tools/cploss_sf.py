#!/usr/bin/env python3
"""Average centipawn loss of zugzwang's move, judged by Stockfish 18.

Exact-move agreement is a poor metric in decided positions (several moves are equally
winning, and SF's pick among them is near-arbitrary).  This instead asks SF how much
worse zug's chosen move is than SF's own: for each position, score SF's best move, then
score zug's move via `searchmoves`, and take the difference.  That is standard ACPL and
it is the direct measurement of "the suggestions get worse the further from zero".

Oracle is SF18 (linear psqt head, does not collapse in ordinary up/down-a-piece
positions).  Restricted to positions where zug's eval is fully railed.
"""
import chess, os, subprocess

ZUG  = os.environ.get("ENG", "/tmp/zugsoft/zugzwang/zugzwang")
SF   = "/Users/tim.alexander/sf18-arm/src/stockfish"
MT   = int(os.environ.get("MT", "300"))
SFMT = int(os.environ.get("SFMT", "600"))
MATE = 30000

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
        t = self.wait("eval").split(); lo, hi = map(int, t[4].split("/"))
        return (16 - lo - hi) == 0
    def score(self, fen, ms, move=None):
        """score of the position (or of one specific move), stm-relative cp."""
        self.send("position fen "+fen)
        self.send("go movetime %d%s" % (ms, (" searchmoves "+move) if move else ""))
        last = None
        while True:
            l = self.p.stdout.readline()
            if not l: raise RuntimeError("dead")
            if l.startswith("info ") and " score " in l: last = l
            if l.startswith("bestmove"): break
        t = last.split()
        i = t.index("score")
        if t[i+1] == "mate":
            n = int(t[i+2]); return MATE - abs(n) if n > 0 else -(MATE - abs(n))
        return int(t[i+2])

probe = Eng(ZUG, {"SATDIAG": "1"})
pos = []
for base in MIDDLEGAMES:
    for syms in LADDER:
        for role in ("LOSING", "WINNING"):
            b = chess.Board(base + " w - - 0 1"); ok = True
            for s in syms:
                pt = chess.Piece.from_symbol(s).piece_type
                sq = next((q for q in b.pieces(pt, chess.BLACK)), None)
                if sq is None: ok = False; break
                b.remove_piece_at(sq)
            if not ok: continue
            b.turn = chess.BLACK if role == "LOSING" else chess.WHITE
            if b.is_valid() and probe.railed(b.fen()): pos.append((role, b.fen()))
probe.p.kill()

moves = {}
for label, env in (("baseline", {}), ("SATSOFT", {"SATSOFT": "1000"})):
    e = Eng(ZUG, env)
    moves[label] = {fen: e.best(fen, MT) for _, fen in pos}
    e.p.kill()

sf = Eng(SF)
res = {l: {"LOSING": [0, 0], "WINNING": [0, 0]} for l in moves}
for role, fen in pos:
    top = sf.score(fen, SFMT)
    for label in moves:
        got = sf.score(fen, SFMT, moves[label][fen])
        loss = max(0, top - got)
        res[label][role][0] += loss
        res[label][role][1] += 1
sf.p.kill()

print("collapsed positions: %d   zug %dms, SF18 oracle %dms" % (len(pos), MT, SFMT))
print("average centipawn loss vs SF18 (lower = better suggestions):")
for label in ("baseline", "SATSOFT"):
    L, W = res[label]["LOSING"], res[label]["WINNING"]
    tot, n = L[0]+W[0], L[1]+W[1]
    print("  %-9s  ALL %6.0f cp   LOSING %6.0f cp   WINNING %6.0f cp"
          % (label, tot/max(n,1), L[0]/max(L[1],1), W[0]/max(W[1],1)))
