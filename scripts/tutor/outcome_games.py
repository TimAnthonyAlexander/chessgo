#!/usr/bin/env python3
"""
Emit minimal normalized games for the ENTIRE population, not just the analyzed
subset.

Why this exists: scripts/tutor/bias_check.py measured the analyzed subset
against the whole population and found them equivalent on win rate (1.6pp) and
draw rate (1.3pp), but NOT on losses to the clock — annotated games flag about
3 percentage points less often, consistently, across every rating band. That is
a real selection effect and an obvious one in hindsight: nobody requests
analysis of a game they lost on time.

`flagging_loss` is graded on a 15pp scale, so a baseline 3pp too low would tip
ordinary players over the "slightly worse" threshold on a metric they are in
fact average at — a false finding, shown confidently.

The fix is to measure the outcome metrics on everything. They need no engine
and no evals, only headers, so streaming the raw dump is cheap. Games come out
in the same normalized shape the metric engine already eats, just with no
plies: TutorMetrics then computes exactly the metrics the data supports
(win_rate, flagging_loss) and none of the ones it doesn't.

Feed the result to the importer with --only=win_rate,flagging_loss so it
populates those cells and leaves the engine-derived ones alone.

Usage:
  curl -s -r 0-2000000000 https://database.lichess.org/standard/lichess_db_standard_rated_2026-06.pgn.zst \
    | zstdcat | ~/tutor-data/venv/bin/python3 scripts/tutor/outcome_games.py --in - \
    --out ~/tutor-data/outcomes_2026-06.jsonl.zst
"""

from __future__ import annotations

import argparse
import io
import json
import re
import sys

import zstandard

HEADER_RE = re.compile(r'^\[(\w+)\s+"(.*)"\]$')
MIN_PLIES = 10


def open_stream(path: str):
    if path == "-":
        return sys.stdin
    if path.endswith(".zst"):
        fh = open(path, "rb")
        return io.TextIOWrapper(
            zstandard.ZstdDecompressor().stream_reader(fh),
            encoding="utf-8", errors="replace")
    return open(path, "r", encoding="utf-8", errors="replace")


def open_out(path: str):
    if path == "-":
        return sys.stdout
    if path.endswith(".zst"):
        fh = open(path, "wb")
        return io.TextIOWrapper(
            zstandard.ZstdCompressor(level=3).stream_writer(fh), encoding="utf-8")
    return open(path, "w", encoding="utf-8")


def category(tc: str) -> tuple[str, int | None, int]:
    """TimeControl header -> (category, baseMs, incMs)."""
    try:
        base_s, inc_s = tc.split("+")
        base, inc = int(base_s), int(inc_s)
    except (ValueError, AttributeError):
        return "correspondence", None, 0
    est = base + 40 * inc
    if est < 180:
        cat = "bullet"
    elif est < 480:
        cat = "blitz"
    elif est < 1500:
        cat = "rapid"
    else:
        cat = "classical"
    return cat, base * 1000, inc * 1000


def reason_of(termination: str) -> str:
    t = (termination or "").lower()
    if "time forfeit" in t:
        return "timeout"
    if "abandoned" in t:
        return "abandoned"
    return t or "normal"


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--in", dest="src", required=True)
    ap.add_argument("--out", dest="out", default="-")
    ap.add_argument("--limit", type=int, default=0, help="0 = no limit")
    args = ap.parse_args()

    headers: dict[str, str] = {}
    in_movetext = False
    plies = 0
    emitted = 0
    read = 0

    out = open_out(args.out)

    def flush() -> bool:
        try:
            we = int(headers.get("WhiteElo", ""))
            be = int(headers.get("BlackElo", ""))
        except ValueError:
            return False
        result = headers.get("Result", "")
        if result not in ("1-0", "0-1", "1/2-1/2"):
            return False
        if plies < MIN_PLIES:
            return False
        cat, base_ms, inc_ms = category(headers.get("TimeControl", ""))
        if cat == "correspondence":
            return False

        out.write(json.dumps({
            "category": cat,
            "whiteRating": we,
            "blackRating": be,
            "result": result,
            "reason": reason_of(headers.get("Termination", "")),
            "opening": "",
            "baseMs": base_ms,
            "incMs": inc_ms,
            # No plies: the metric engine will compute exactly the metrics this
            # data supports and skip every eval-derived one.
            "plies": [],
        }) + "\n")
        return True

    with open_stream(args.src) as fh:
        for line in fh:
            line = line.rstrip("\n")
            m = HEADER_RE.match(line)
            if m:
                if in_movetext:
                    read += 1
                    if flush():
                        emitted += 1
                    if args.limit and emitted >= args.limit:
                        break
                    if read % 200000 == 0:
                        print(f"  read {read:,} emitted {emitted:,}", file=sys.stderr)
                    headers, in_movetext, plies = {}, False, 0
                headers[m.group(1)] = m.group(2)
            elif line.strip():
                in_movetext = True
                plies += line.count(".")

        if in_movetext:
            read += 1
            if flush():
                emitted += 1

    if out is not sys.stdout:
        out.close()

    print(f"read {read:,} games, emitted {emitted:,}", file=sys.stderr)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
