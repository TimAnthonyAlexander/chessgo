#!/usr/bin/env python3
"""
Extract a small calibration set: the same games, with Lichess's evals AND the
UCI move list needed to replay them through zugzwang.

The peer baselines are measured from Lichess's `%eval` annotations, which come
from their fishnet grid at whatever depth it ran. A user's own games are
measured by zugzwang at 100ms per position. Those are different engines at
different depths, so before comparing a player to the baseline we need to know
whether the two eval sources even agree on scale — otherwise every one of our
users looks worse (or better) than their peers for a reason that has nothing to
do with how they play.

This emits the input for that check. scripts/calibrate_tutor_evals.php replays
these games through our engine and compares the resulting metrics per game.

Usage:
  ~/tutor-data/venv/bin/python3 scripts/tutor/calibration_set.py \
      --in ~/tutor-data/eval_games_2026-06.pgn.zst \
      --out ~/tutor-data/calibration.jsonl --limit 400
"""

from __future__ import annotations

import argparse
import io
import json
import re
import sys

import chess
import chess.pgn
import zstandard

EVAL_RE = re.compile(r"\[%eval ([^\]]+)\]")


def open_pgn(path: str):
    if path.endswith(".zst"):
        fh = open(path, "rb")
        reader = zstandard.ZstdDecompressor().stream_reader(fh)
        return io.TextIOWrapper(reader, encoding="utf-8", errors="replace")
    return open(path, "r", encoding="utf-8", errors="replace")


def parse_eval(comment: str):
    """'[%eval 0.24]' -> {'type':'cp','value':24}; '#-3' -> mate. White POV."""
    m = EVAL_RE.search(comment or "")
    if not m:
        return None
    raw = m.group(1).strip()
    if raw.startswith("#"):
        try:
            return {"type": "mate", "value": int(raw[1:])}
        except ValueError:
            return None
    try:
        return {"type": "cp", "value": int(round(float(raw) * 100))}
    except ValueError:
        return None


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--in", dest="src", required=True)
    ap.add_argument("--out", dest="out", required=True)
    ap.add_argument("--limit", type=int, default=400)
    ap.add_argument("--max-plies", type=int, default=120,
                    help="skip longer games so one calibration run stays quick")
    args = ap.parse_args()

    emitted = 0
    read = 0

    with open_pgn(args.src) as pgn, open(args.out, "w", encoding="utf-8") as out:
        while emitted < args.limit:
            game = chess.pgn.read_game(pgn)
            if game is None:
                break
            read += 1

            headers = game.headers
            if headers.get("Result") not in ("1-0", "0-1", "1/2-1/2"):
                continue

            try:
                white = int(headers.get("WhiteElo", ""))
                black = int(headers.get("BlackElo", ""))
            except ValueError:
                continue

            board = game.board()
            ucis: list[str] = []
            evals: list[dict | None] = [None]  # start position carries no eval

            for node in game.mainline():
                ucis.append(node.move.uci())
                evals.append(parse_eval(node.comment))
                board.push(node.move)

            if len(ucis) < 20 or len(ucis) > args.max_plies:
                continue

            # Only useful if most positions actually carry an eval.
            annotated = sum(1 for e in evals if e is not None)
            if annotated < len(evals) * 0.9:
                continue

            out.write(json.dumps({
                "id": headers.get("Site", "").rstrip("/").split("/")[-1],
                "result": headers.get("Result"),
                "whiteRating": white,
                "blackRating": black,
                "ucis": ucis,
                "lichessEvals": evals,
            }) + "\n")
            emitted += 1

    print(f"read {read} games, emitted {emitted} calibration games -> {args.out}",
          file=sys.stderr)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
