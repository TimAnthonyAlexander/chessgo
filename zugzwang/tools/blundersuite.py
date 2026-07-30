#!/usr/bin/env python3
"""Bigger 'does it hang material when the game is already decided' suite.
Counts only TRULY FREE captures (undefended target) — the exact thing being
complained about.  Runs both the losing side AND the winning side, since the
net rails on both."""
import chess, os, subprocess, sys

ENGINE = "/Users/tim.alexander/chessgo/zugzwang/zugzwang"
MT     = int(os.environ.get("MT", "300"))
VAL    = {chess.PAWN:100, chess.KNIGHT:320, chess.BISHOP:330, chess.ROOK:500, chess.QUEEN:900}

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
LADDER = [("q",), ("q","r"), ("q","r","n"), ("r",), ("r","n"), ("n","b")]

def strip(base, syms, side):
    b = chess.Board(base + (" w" if side == chess.WHITE else " b") + " - - 0 1")
    for s in syms:
        pt = chess.Piece.from_symbol(s).piece_type
        sq = next((q for q in b.pieces(pt, side)), None)
        if sq is None: return None, 0
        b.remove_piece_at(sq)
    b.turn = side                       # the WEAKENED side is to move
    return (b, sum(VAL[chess.Piece.from_symbol(s).piece_type] for s in syms)) \
           if b.is_valid() else (None, 0)

def free_material(b):
    """largest UNDEFENDED piece the side to move can just take."""
    best = 0
    for m in b.legal_moves:
        if not b.is_capture(m) or b.is_en_passant(m): continue
        tgt = b.piece_at(m.to_square)
        b.push(m)
        safe = not b.is_attacked_by(b.turn, m.to_square)
        b.pop()
        if safe: best = max(best, VAL.get(tgt.piece_type, 0))
    return best

class Eng:
    def __init__(self):
        self.p = subprocess.Popen([ENGINE], stdin=subprocess.PIPE, stdout=subprocess.PIPE,
                                  stderr=subprocess.DEVNULL, text=True, bufsize=1,
                                  cwd=os.path.dirname(ENGINE))
        self.send("uci"); self.wait("uciok")
    def send(self, s): self.p.stdin.write(s+"\n"); self.p.stdin.flush()
    def wait(self, tok):
        while True:
            l = self.p.stdout.readline()
            if not l: raise RuntimeError("dead")
            if l.startswith(tok): return l.strip()
    def best(self, fen):
        self.send("position fen "+fen); self.send("go movetime %d" % MT)
        return self.wait("bestmove").split()[1]

e = Eng()
rows = hangs = tot = 0
worst = []
for role, side in (("LOSING", chess.BLACK), ("WINNING", chess.WHITE)):
    # role LOSING: black is stripped and black moves.  role WINNING: black is
    # stripped but WHITE moves -> the engine plays the side that is far ahead.
    for base in MIDDLEGAMES:
        for syms in LADDER:
            b, deficit = strip(base, syms, chess.BLACK)
            if b is None: continue
            if role == "WINNING":
                b.turn = chess.WHITE
                if not b.is_valid(): continue
            fen = b.fen()
            before = free_material(chess.Board(fen).mirror()) if False else None
            b2 = chess.Board(fen); b2.turn = not b2.turn
            before = free_material(b2) if b2.is_valid() else 0
            mv = e.best(fen)
            b3 = chess.Board(fen)
            m = chess.Move.from_uci(mv)
            # net out whatever our own move captured, so a normal trade or a
            # capture-then-recapture isn't scored as hanging material.
            won = 0
            if b3.is_capture(m):
                won = 100 if b3.is_en_passant(m) else VAL.get(b3.piece_at(m.to_square).piece_type, 0)
            b3.push(m)
            after = free_material(b3)
            hung = max(0, after - before - won)
            rows += 1; tot += hung
            if hung >= 300:
                hangs += 1
                worst.append((role, hung, mv, fen))
print("SATFIX=%s  positions=%d   hung>=300cp: %d (%.1f%%)   total hung: %dcp   avg: %.1fcp"
      % (os.environ.get("SATFIX", "0"), rows, hangs, 100.0*hangs/max(rows,1), tot, tot/max(rows,1)))
for role, hung, mv, fen in worst[:8]:
    print("   %-7s hangs %4dcp  move %-6s  %s" % (role, hung, mv, fen))
