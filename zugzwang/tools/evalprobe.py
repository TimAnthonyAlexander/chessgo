#!/usr/bin/env python3
"""Measure (A) material-gradient monotonicity of a UCI engine's static eval and
(B) whether it hangs material when up/down a lot.  Engine-agnostic; config via env."""
import chess, os, subprocess, sys, itertools, json

ENGINE = os.environ.get("ENG", "/Users/tim.alexander/chessgo/zugzwang/zugzwang")
ARGS   = os.environ.get("ENGARGS", "uci").split()
MT     = int(os.environ.get("MT", "1000"))
VAL    = {chess.PAWN:100, chess.KNIGHT:320, chess.BISHOP:330, chess.ROOK:500, chess.QUEEN:900}

class Eng:
    def __init__(self):
        self.p = subprocess.Popen([ENGINE]+ARGS, stdin=subprocess.PIPE, stdout=subprocess.PIPE,
                                  stderr=subprocess.DEVNULL, text=True, bufsize=1,
                                  cwd=os.path.dirname(ENGINE))
        self.send("uci"); self.wait("uciok")
        self.send("isready"); self.wait("readyok")
    def send(self, s): self.p.stdin.write(s+"\n"); self.p.stdin.flush()
    def wait(self, tok, timeout_lines=100000):
        for _ in range(timeout_lines):
            l = self.p.stdout.readline()
            if not l: raise RuntimeError("engine died")
            if l.startswith(tok): return l.strip()
        raise RuntimeError("no "+tok)
    def static_eval(self, fen):
        self.send("position fen "+fen); self.send("eval")
        return int(self.wait("eval").split()[1])
    def best(self, fen, mt=None):
        self.send("position fen "+fen); self.send("go movetime %d" % (mt or MT))
        return self.wait("bestmove").split()[1]

# ---------- A: material-gradient ladder ----------
# Remove black material step by step; black to move.  Static eval is stm-relative,
# so each removal must make it STRICTLY MORE NEGATIVE by ~the piece value.
BASES = [
 ("english",  "r1bq1rk1/pp2ppbp/2np1np1/2p5/2P1P3/2NP1NP1/PP3PBP/R1BQ1RK1"),
 ("italian",  "r1bqk2r/pppp1ppp/2n2n2/2b1p3/2B1P3/2N2N2/PPPP1PPP/R1BQK2R"),
 ("sicilian", "r2q1rk1/1b1nbppp/p2ppn2/1p4B1/3NP3/2N2P2/PPPQ2PP/2KR1B1R"),
 ("qgd",      "rn1qkb1r/pp2pppp/2p2n2/3p1b2/2PP4/5N2/PP2BPPP/RNBQK2R"),
]
LADDER = ["q", "r", "n", "b", "r", "n", "p", "p"]   # black pieces removed, in order

def ladder(base):
    """yield (label, fen, true_material_deficit_cp) with black to move"""
    b = chess.Board(base + " b - - 0 1")
    removed, deficit = [], 0
    yield ("+0", b.fen(), 0)
    for want in LADDER:
        pt = chess.Piece.from_symbol(want).piece_type
        sq = next((s for s in b.pieces(pt, chess.BLACK)), None)
        if sq is None: continue
        b.remove_piece_at(sq); removed.append(want); deficit += VAL[pt]
        if not b.is_valid(): continue
        yield ("-"+"".join(removed), b.fen(), deficit)

def run_A(e):
    print("=" * 96)
    print("A) MATERIAL-GRADIENT MONOTONICITY  (black to move; eval is stm-relative, must DROP each row)")
    print("=" * 96)
    bad = flat = 0; rows = 0
    for name, base in BASES:
        print("\n%-9s %-22s %9s %9s %9s %8s" % (name, "removed", "true_cp", "eval", "d_eval", "d_true"))
        prev_e = prev_d = None
        for label, fen, deficit in ladder(base):
            ev = e.static_eval(fen)
            de = "" if prev_e is None else "%+d" % (ev - prev_e)
            dt = "" if prev_d is None else "%+d" % (-(deficit - prev_d))
            flag = ""
            if prev_e is not None:
                rows += 1
                real = ev - prev_e
                want = -(deficit - prev_d)
                if real > 0:                    flag = "  <== WRONG SIGN"; bad += 1
                elif real > want * 0.35:        flag = "  <== FLAT (<35%% of %d)" % (-want); flat += 1
            print("%-9s %-22s %9d %9d %9s %8s%s" % ("", label, -deficit, ev, de, dt, flag))
            prev_e, prev_d = ev, deficit
    print("\n  --> %d/%d steps WRONG-SIGN, %d/%d steps FLAT   (total broken: %d/%d = %.0f%%)"
          % (bad, rows, flat, rows, bad+flat, rows, 100.0*(bad+flat)/max(rows,1)))
    return bad, flat, rows

# ---------- B: does it hang material when the game is already decided? ----------
def max_see_gain(b):
    """largest material the side to move can win with a single capture (SEE>0)."""
    best = 0
    for m in b.legal_moves:
        if b.is_capture(m):
            g = b.piece_at(m.to_square)
            gain = VAL.get(g.piece_type, 0) if g else 100
            if b.is_en_passant(m): gain = 100
            if not b.is_attacked_by(not b.turn, m.to_square):
                best = max(best, gain)                        # free
            else:
                att = b.piece_at(m.from_square)
                net = gain - VAL.get(att.piece_type, 0)
                best = max(best, net)
    return best

def run_B(e, odds):
    print("\n" + "=" * 96)
    print("B) HANGS-MATERIAL TEST  (side to move is DOWN %s; movetime %dms)" % (odds, MT))
    print("   'hung' = free/winning material available to opponent AFTER our move that wasn't there before")
    print("=" * 96)
    print("%-9s %-6s %8s %8s %7s  %s" % ("pos", "move", "before", "after", "HUNG", "fen"))
    tot = worst = 0; n = 0; hangs = 0
    for name, base in BASES:
        for label, fen, deficit in ladder(base):
            if label != odds: continue
            b = chess.Board(fen)
            before = max_see_gain(b.mirror() if False else b.copy(stack=False).mirror()) if False else None
            # material opponent can win right now (opponent to move)
            b2 = b.copy(stack=False); b2.turn = not b2.turn
            before = max_see_gain(b2)
            mv = e.best(fen)
            b3 = b.copy(stack=False); b3.push(chess.Move.from_uci(mv))
            after = max_see_gain(b3)
            hung = max(0, after - max(before, 0))
            n += 1; tot += hung; worst = max(worst, hung); hangs += (hung >= 100)
            print("%-9s %-6s %8d %8d %7s  %s" % (name, mv, before, after,
                  ("+%d" % hung) if hung else "-", fen))
    print("\n  --> %d/%d moves hang >=100cp | total hung %dcp | worst %dcp | avg %.0fcp"
          % (hangs, n, tot, worst, tot/max(n,1)))
    return hangs, n, tot

if __name__ == "__main__":
    e = Eng()
    what = sys.argv[1] if len(sys.argv) > 1 else "AB"
    if "A" in what: run_A(e)
    if "B" in what:
        for odds in ("-q", "-qr", "-qrn", "-qrnb"):
            run_B(e, odds)
