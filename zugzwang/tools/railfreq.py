#!/usr/bin/env python3
"""How often is the eval completely blind in a real game?  Plays self-play games
from book openings and records the L1 rail state of every position reached."""
import chess, os, subprocess, random, collections

ENGINE = "/Users/tim.alexander/chessgo/zugzwang/zugzwang"
MT     = int(os.environ.get("MT", "100"))
GAMES  = int(os.environ.get("GAMES", "8"))

class Eng:
    def __init__(self):
        env = dict(os.environ, SATDIAG="1")
        self.p = subprocess.Popen([ENGINE], stdin=subprocess.PIPE, stdout=subprocess.PIPE,
                                  stderr=subprocess.DEVNULL, text=True, bufsize=1, env=env,
                                  cwd=os.path.dirname(ENGINE))
        self.send("uci"); self.wait("uciok")
    def send(self, s): self.p.stdin.write(s+"\n"); self.p.stdin.flush()
    def wait(self, tok):
        while True:
            l = self.p.stdout.readline()
            if not l: raise RuntimeError("dead")
            if l.startswith(tok): return l.strip()
    def probe(self, fen):
        self.send("position fen "+fen); self.send("eval")
        t = self.wait("eval").split()
        # eval N sat l1 LO/HI of 16  l2 ...
        ev = int(t[1]); lo, hi = map(int, t[4].split("/"))
        return ev, 16 - lo - hi
    def best(self, fen):
        self.send("position fen "+fen); self.send("go movetime %d" % MT)
        return self.wait("bestmove").split()[1]

e = Eng()
random.seed(7)
hist = collections.Counter(); blind = 0; n = 0
blind_by_phase = collections.Counter(); phase_n = collections.Counter()
for g in range(GAMES):
    b = chess.Board()
    for _ in range(random.choice([4, 6, 8])):          # varied openings
        ms = list(b.legal_moves)
        if not ms: break
        b.push(random.choice(ms))
    ply = 0
    while not b.is_game_over(claim_draw=True) and ply < 140:
        ev, live = e.probe(b.fen())
        hist[live] += 1; n += 1
        ph = "opening" if ply < 20 else ("middlegame" if ply < 60 else "endgame")
        phase_n[ph] += 1
        if live == 0: blind += 1; blind_by_phase[ph] += 1
        mv = e.best(b.fen())
        try: b.push(chess.Move.from_uci(mv))
        except Exception: break
        ply += 1
    print("  game %d: %d plies, result %s" % (g+1, ply, b.result(claim_draw=True)))

print("\n=== L1 live-lane histogram over %d real game positions (of 16 lanes) ===" % n)
for k in sorted(hist):
    print("   live=%-3d %6d  %5.1f%%%s" % (k, hist[k], 100.0*hist[k]/n,
          "   <== EVAL IS A CONSTANT, ZERO INFORMATION" if k == 0 else ""))
print("\n   BLIND (live==0): %d/%d = %.1f%% of all positions played" % (blind, n, 100.0*blind/n))
for ph in ("opening", "middlegame", "endgame"):
    if phase_n[ph]:
        print("      %-11s %5.1f%%  (%d/%d)" % (ph, 100.0*blind_by_phase[ph]/phase_n[ph],
                                                blind_by_phase[ph], phase_n[ph]))
