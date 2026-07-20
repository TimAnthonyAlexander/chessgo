#!/usr/bin/env python3
"""Puzzle solve-rate benchmark for zugzwang.
Lichess convention: fen is BEFORE the opponent setup move; moves[0] is auto-played,
moves[1] is the first solution move the engine must find.
Usage: puzzlebench.py <engine> <tsv> <movetime_ms> <max_pieces|0=any> <sample> [ENV=VAL ...]
"""
import sys, json, subprocess, random, os, time

engine, tsv, mt, maxp, sample = sys.argv[1], sys.argv[2], int(sys.argv[3]), int(sys.argv[4]), int(sys.argv[5])
env = dict(os.environ)
for kv in sys.argv[6:]:
    k, v = kv.split("=", 1); env[k] = v

def pieces(fen):
    b = fen.split(" ", 1)[0]
    return sum(c.isalpha() for c in b)

rows = []
with open(tsv) as f:
    next(f)  # header
    for line in f:
        p = line.rstrip("\n").split("\t")
        if len(p) < 3: continue
        fen, mv = p[0], json.loads(p[1])
        if len(mv) < 2: continue
        if maxp and pieces(fen) > maxp: continue
        rows.append((fen, mv))
random.seed(12345)
random.shuffle(rows)
rows = rows[:sample] if sample else rows
print(f"[{' '.join(sys.argv[6:]) or 'baseline'}] puzzles={len(rows)} movetime={mt}ms maxp={maxp}", flush=True)

eng = subprocess.Popen([engine], stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL,
                       text=True, bufsize=1, env=env)
def send(s): eng.stdin.write(s + "\n"); eng.stdin.flush()
def wait_best():
    while True:
        ln = eng.stdout.readline()
        if not ln: return None
        if ln.startswith("bestmove"): return ln.split()[1]

send("uci")
while True:
    if eng.stdout.readline().startswith("uciok"): break
send("setoption name OwnBook value false")  # measure SEARCH, not book
send("isready"); eng.stdout.readline()

solved = 0; t0 = time.time()
for i, (fen, mv) in enumerate(rows):
    send("ucinewgame")
    send(f"position fen {fen} moves {mv[0]}")
    send(f"go movetime {mt}")
    bm = wait_best()
    if bm == mv[1]: solved += 1
    if (i + 1) % 250 == 0:
        print(f"  {i+1}/{len(rows)}  solved={solved} ({100*solved/(i+1):.1f}%)", flush=True)
send("quit")
dt = time.time() - t0
print(f"RESULT solved={solved}/{len(rows)} = {100*solved/len(rows):.2f}%  ({dt:.0f}s)", flush=True)
