#!/usr/bin/env python3
"""Wave 6 NPS bench: same 8 positions, go movetime 2000, OwnBook off, for both
./zugzwang and ./zugzwang_sfnet. Prints per-position depth/nps and the median of
each, so a before/after run is directly comparable. Not a permanent test — a
one-shot instrument for this wave's gate 4.
"""
import subprocess, sys, statistics, re

POSITIONS = [
    ("startpos",       "position startpos"),
    ("ruylopez_mg",     "position fen r1bq1rk1/pp2ppbp/2np1np1/2p5/2P1P3/2NP1NP1/PP3PBP/R1BQ1RK1 w - -"),
    ("kpk_endgame",     "position fen 8/8/8/8/1k1K1P2/8/8/8 b - -"),
    ("rook_tactical",   "position fen rr1k4/8/2P1bbP1/p2p2Np/P2P2PP/3q4/2n1R3/4RK2 b - - 6 56"),
    ("sicilian_mg",     "position fen r3k2r/pbppqppp/1pn2n2/4p3/2B1P3/2NP1N2/PPP2PPP/R1BQ1RK1 w KQkq -"),
    ("queen_endgame",   "position fen 8/5pk1/6p1/7p/8/5PPq/7P/6QK w - -"),
    ("closed_dense",    "position fen rnbqkb1r/pp3ppp/4pn2/2pp4/3P4/2N1PN2/PPP2PPP/R1BQKB1R w KQkq -"),
    ("reduced_material","position fen 8/pp3ppp/2n5/3p4/3P4/2N5/PP3PPP/8 w - -"),
]

def run_one(binary, posline, movetime_ms):
    cmds = f"uci\nsetoption name OwnBook value false\nisready\n{posline}\ngo movetime {movetime_ms}\nquit\n"
    p = subprocess.run([binary], input=cmds, capture_output=True, text=True, timeout=(movetime_ms/1000)+15)
    last_depth, last_nps, last_nodes = None, None, None
    for line in p.stdout.splitlines():
        if line.startswith("info depth"):
            m_depth = re.search(r"\bdepth (\d+)\b", line)
            m_nps = re.search(r"\bnps (\d+)\b", line)
            m_nodes = re.search(r"\bnodes (\d+)\b", line)
            if m_depth and m_nps:
                last_depth = int(m_depth.group(1))
                last_nps = int(m_nps.group(1))
                if m_nodes:
                    last_nodes = int(m_nodes.group(1))
    return last_depth, last_nps, last_nodes

def main():
    if len(sys.argv) < 2:
        print(f"usage: {sys.argv[0]} <binary> [movetime_ms=2000]", file=sys.stderr)
        sys.exit(2)
    binary = sys.argv[1]
    movetime_ms = int(sys.argv[2]) if len(sys.argv) > 2 else 2000

    depths, npss = [], []
    print(f"# {binary} movetime={movetime_ms}ms")
    print("name\tdepth\tnps\tnodes")
    for name, posline in POSITIONS:
        d, n, nodes = run_one(binary, posline, movetime_ms)
        depths.append(d or 0)
        npss.append(n or 0)
        print(f"{name}\t{d}\t{n}\t{nodes}")
    print(f"# median depth={statistics.median(depths)} median nps={statistics.median(npss):.0f}")

if __name__ == "__main__":
    main()
