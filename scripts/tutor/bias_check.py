#!/usr/bin/env python3
"""
Is the analyzed subset of Lichess games representative?

The Tutor peer baselines are built only from games carrying `%eval`
annotations, because those are the games we can measure without spending our
own engine time on somebody else's corpus. But a Lichess game has evals
because a HUMAN requested analysis of it — and people request analysis on
games they found interesting, which is exactly the selection bias Lichess's
own lead dev conceded about Tutor in their beta thread.

So this measures the bias instead of assuming it away. It streams the raw,
UNFILTERED dump and computes outcome-only statistics — win rate, draw rate,
loss-on-time rate — separately for annotated and unannotated games at matched
rating bands. Those statistics need no engine and no board, so they are
directly comparable between the two groups.

If the two groups agree, the eval'd subset is representative on the things we
can check, and the baselines built from it are trustworthy. If they diverge,
that divergence is a real caveat that belongs on the page.

Usage:
  ~/tutor-data/venv/bin/python3 scripts/tutor/bias_check.py \
      --in ~/tutor-data/raw_sample.pgn --limit 400000
"""

from __future__ import annotations

import argparse
import io
import re
import sys
from collections import defaultdict

import zstandard

HEADER_RE = re.compile(r'^\[(\w+)\s+"(.*)"\]$')
BAND = 200  # wide bands: this is about population shape, not per-cell precision


def open_stream(path: str):
    if path == "-":
        return sys.stdin
    if path.endswith(".zst"):
        fh = open(path, "rb")
        reader = zstandard.ZstdDecompressor().stream_reader(fh)
        return io.TextIOWrapper(reader, encoding="utf-8", errors="replace")
    return open(path, "r", encoding="utf-8", errors="replace")


def category(tc: str) -> str:
    try:
        base, inc = tc.split("+")
        est = int(base) + 40 * int(inc)
    except (ValueError, AttributeError):
        return "unknown"
    if est < 180:
        return "bullet"
    if est < 480:
        return "blitz"
    if est < 1500:
        return "rapid"
    return "classical"


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--in", dest="src", required=True)
    ap.add_argument("--limit", type=int, default=400000)
    args = ap.parse_args()

    # stats[(annotated, category, band)] -> counters
    stats: dict[tuple, dict[str, float]] = defaultdict(
        lambda: {"games": 0, "white_win": 0, "draw": 0, "time_loss": 0, "plies": 0}
    )

    headers: dict[str, str] = {}
    in_movetext = False
    annotated = False
    movetext_plies = 0
    seen = 0

    def flush():
        nonlocal headers, annotated, movetext_plies
        try:
            we = int(headers.get("WhiteElo", ""))
            be = int(headers.get("BlackElo", ""))
        except ValueError:
            return
        result = headers.get("Result", "")
        if result not in ("1-0", "0-1", "1/2-1/2"):
            return
        cat = category(headers.get("TimeControl", ""))
        if cat == "unknown":
            return

        avg = (we + be) // 2
        band = (avg // BAND) * BAND
        key = (annotated, cat, band)
        s = stats[key]
        s["games"] += 1
        s["plies"] += movetext_plies
        if result == "1-0":
            s["white_win"] += 1
        elif result == "1/2-1/2":
            s["draw"] += 1
        if "Time forfeit" in headers.get("Termination", ""):
            s["time_loss"] += 1

    with open_stream(args.src) as fh:
        for line in fh:
            line = line.rstrip("\n")
            m = HEADER_RE.match(line)
            if m:
                if in_movetext:
                    flush()
                    seen += 1
                    if seen >= args.limit:
                        break
                    if seen % 100000 == 0:
                        print(f"  {seen:,} games", file=sys.stderr)
                    headers = {}
                    annotated = False
                    movetext_plies = 0
                    in_movetext = False
                headers[m.group(1)] = m.group(2)
            elif line.strip():
                in_movetext = True
                if "%eval" in line:
                    annotated = True
                movetext_plies += line.count(".")

        if in_movetext:
            flush()

    # --- report ---------------------------------------------------------
    print(f"\n{'category':<11} {'band':>10} {'group':>12} {'games':>9} "
          f"{'white win%':>11} {'draw%':>8} {'time loss%':>11}")
    print("-" * 78)

    keys = sorted({(c, b) for (_, c, b) in stats}, key=lambda x: (x[0], x[1]))
    deltas = []

    for cat, band in keys:
        rows = {}
        for flag in (True, False):
            s = stats.get((flag, cat, band))
            if not s or s["games"] < 200:
                continue
            g = s["games"]
            rows[flag] = (g, 100 * s["white_win"] / g, 100 * s["draw"] / g,
                          100 * s["time_loss"] / g)

        if len(rows) < 2:
            continue

        for flag in (True, False):
            g, ww, dr, tl = rows[flag]
            label = "annotated" if flag else "plain"
            print(f"{cat:<11} {band:>10} {label:>12} {g:>9,} {ww:>10.1f}% "
                  f"{dr:>7.1f}% {tl:>10.1f}%")

        a, p = rows[True], rows[False]
        deltas.append((abs(a[1] - p[1]), abs(a[2] - p[2]), abs(a[3] - p[3])))
        print(f"{'':<11} {'':>10} {'delta':>12} {'':>9} "
              f"{a[1]-p[1]:>+10.1f}% {a[2]-p[2]:>+7.1f}% {a[3]-p[3]:>+10.1f}%")
        print()

    if deltas:
        n = len(deltas)
        print(f"Mean absolute delta across {n} matched cells: "
              f"white-win {sum(d[0] for d in deltas)/n:.2f}pp, "
              f"draw {sum(d[1] for d in deltas)/n:.2f}pp, "
              f"time-loss {sum(d[2] for d in deltas)/n:.2f}pp")
        print("\nSmall deltas mean the analyzed subset behaves like the whole")
        print("population on everything measurable without an engine, so the")
        print("baselines built from it are representative. Large deltas would")
        print("be a caveat that belongs on the report page itself.")

    return 0


if __name__ == "__main__":
    raise SystemExit(main())
