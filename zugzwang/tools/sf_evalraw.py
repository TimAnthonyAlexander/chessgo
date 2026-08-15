#!/usr/bin/env python3
"""Feed a FEN corpus through a patched throwaway Stockfish 18 build's
`evalraw` UCI command and emit the raw-int oracle TSV for the sf-net
experiment (docs/tasks/open/sf-net-experiment.md).

The patched binary lives OUTSIDE this repo (a throwaway copy of
~/sf18-arm, never ~/sf18-arm itself) and prints, per position:

    RAW<TAB><bucket><TAB><psqt><TAB><positional>
    FULL<TAB><value>

or `SKIP` if the side to move is in check. This script drives one
Stockfish process with the whole corpus batched over stdin (loading the
104 MB big net once, not once per position) and writes:

    fen<TAB>bucket<TAB>psqt<TAB>positional<TAB>full

to stdout, one line per corpus FEN, in corpus order.

Usage:
    python3 tools/sf_evalraw.py <path-to-patched-stockfish> <corpus.epd> > out.tsv
"""
import subprocess
import sys


def main():
    if len(sys.argv) != 3:
        sys.stderr.write(f"usage: {sys.argv[0]} <patched-stockfish-binary> <corpus.epd>\n")
        sys.exit(1)

    sf_bin = sys.argv[1]
    corpus_path = sys.argv[2]

    with open(corpus_path) as f:
        fens = [line.strip() for line in f if line.strip()]

    cmds = []
    for fen in fens:
        cmds.append(f"position fen {fen}")
        cmds.append("evalraw")
    cmds.append("quit")
    stdin_data = "\n".join(cmds) + "\n"

    proc = subprocess.run(
        [sf_bin],
        input=stdin_data,
        capture_output=True,
        text=True,
        cwd=None,
    )

    if proc.returncode != 0:
        sys.stderr.write(f"stockfish exited {proc.returncode}\nstderr:\n{proc.stderr}\n")
        sys.exit(1)

    # Pull out only our RAW/FULL/SKIP lines, in emitted order.
    events = []
    for line in proc.stdout.splitlines():
        if line.startswith("RAW\t") or line.startswith("FULL\t") or line == "SKIP":
            events.append(line)

    fi = 0
    ei = 0
    skip_count = 0
    out_lines = []
    while fi < len(fens):
        fen = fens[fi]
        if ei >= len(events):
            sys.stderr.write(f"ERROR: ran out of engine output at fen[{fi}]={fen!r}\n")
            sys.exit(1)
        ev = events[ei]
        if ev == "SKIP":
            skip_count += 1
            sys.stderr.write(f"SKIP (in check, should not be in corpus): {fen}\n")
            ei += 1
            fi += 1
            continue
        if not ev.startswith("RAW\t"):
            sys.stderr.write(f"ERROR: expected RAW, got {ev!r} at fen[{fi}]={fen!r}\n")
            sys.exit(1)
        _, bucket, psqt, positional = ev.split("\t")
        ei += 1
        if ei >= len(events) or not events[ei].startswith("FULL\t"):
            sys.stderr.write(f"ERROR: expected FULL after RAW at fen[{fi}]={fen!r}\n")
            sys.exit(1)
        _, full = events[ei].split("\t")
        ei += 1
        out_lines.append(f"{fen}\t{bucket}\t{psqt}\t{positional}\t{full}")
        fi += 1

    for line in out_lines:
        print(line)

    sys.stderr.write(f"wrote {len(out_lines)} rows, {skip_count} SKIPs, from {len(fens)} corpus FENs\n")


if __name__ == "__main__":
    main()
