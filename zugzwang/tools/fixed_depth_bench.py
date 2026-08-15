#!/usr/bin/env python3
import subprocess, sys, time, re, statistics

POSITIONS = [
    "position startpos",
    "position fen r1bq1rk1/pp2ppbp/2np1np1/2p5/2P1P3/2NP1NP1/PP3PBP/R1BQ1RK1 w - -",
    "position fen r3k2r/pbppqppp/1pn2n2/4p3/2B1P3/2NP1N2/PPP2PPP/R1BQ1RK1 w KQkq -",
    "position fen rnbqkb1r/pp3ppp/4pn2/2pp4/3P4/2N1PN2/PPP2PPP/R1BQKB1R w KQkq -",
]

def run_one(binary, posline, depth):
    cmds = f"uci\nsetoption name OwnBook value false\nisready\n{posline}\ngo depth {depth}\nquit\n"
    t0 = time.perf_counter()
    p = subprocess.run([binary], input=cmds, capture_output=True, text=True, timeout=120)
    elapsed = time.perf_counter() - t0
    last_nodes = None
    for line in p.stdout.splitlines():
        if line.startswith("info depth"):
            m = re.search(r"\bnodes (\d+)\b", line)
            if m:
                last_nodes = int(m.group(1))
    return last_nodes, elapsed

def main():
    binary = sys.argv[1]
    depth = int(sys.argv[2]) if len(sys.argv) > 2 else 16
    reps = int(sys.argv[3]) if len(sys.argv) > 3 else 2
    all_nps = []
    for posline in POSITIONS:
        for r in range(reps):
            nodes, elapsed = run_one(binary, posline, depth)
            nps = nodes / elapsed if nodes and elapsed > 0 else 0
            all_nps.append(nps)
            print(f"{posline[:50]:50s} rep{r} nodes={nodes} wall={elapsed:.3f}s nps={nps:.0f}")
    print(f"# {binary} depth={depth}: median nps={statistics.median(all_nps):.0f}  mean={statistics.mean(all_nps):.0f}")

if __name__ == "__main__":
    main()
