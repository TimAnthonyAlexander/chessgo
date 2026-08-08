#!/usr/bin/env python3
"""
Build the Premove Trainer position pool (docs/tasks/open/premove-trainer.md §3).

Generates low-piece endgames and keeps only the ones where MANY moves win, which
is what makes the mode a premove drill rather than a tactics test.

Why this reads the tablebase directly instead of asking zugzwang
----------------------------------------------------------------
The first version drove the engine over HTTP. That does not work, for a reason
worth writing down: zugzwang's root tablebase probe is `tb_probe_root` (WDL,
chosen deliberately — see gomachine/CLAUDE.md on why the DTZ-ranked variant
shuffles a won KBN to a draw). A WDL-optimal move PRESERVES the win but does not
have to make progress toward mate, so the engine playing both sides of a won
endgame shuffles forever. Measured: 0 of 15 random KQvK positions reached mate at
100ms, 400ms or 1500ms per move. Any "can this be converted?" filter built on
engine self-play is therefore measuring nothing, and it was silently rejecting
57% of perfectly good positions.

Syzygy answers all three questions we actually have — is it won (WDL), how long
does it take (DTZ), and how many moves keep the win (WDL of each child) — exactly
and locally. It is also about 1200x faster: ~600 candidates/sec against files on
disk versus ~0.5/sec through the engine, with no sockets involved at all (the
HTTP version exhausted the machine's ephemeral port range).

Usage:
    python3 scripts/build_premove_positions.py [--limit=N] [--signature=KPvK]
                                               [--dry-run] [--seed=N]

    --limit=N      target kept positions overall (default 8000)
    --signature=X  restrict to one signature
    --dry-run      report keep rates, write nothing
    --seed=N       deterministic run

Requires python-chess + PyMySQL. Set PREMOVE_VENV to a venv that has them, or
install them into the interpreter you run this with.
"""

from __future__ import annotations

import os
import random
import re
import sys
import time
import uuid
from collections import Counter

import chess
import chess.syzygy
import pymysql

REPO = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
SYZYGY_PATH = os.environ.get("SYZYGY_PATH", os.path.join(REPO, "gomachine", "data", "syzygy"))

# --- Filters (spec §3.1) ---------------------------------------------------
MIN_WINNING_MOVES = 3      # absolute breadth floor
MIN_BREADTH_PCT = 40       # relative breadth floor — the load-bearing filter
MAX_CONVERSION_PLIES = 30  # must be finishable on the clock
MIN_CONVERSION_PLIES = 4   # below this it's a mate-in-2 gimme, not a conversion

# --- Signatures (spec §3.2), weighted toward promotion races ---------------
# (name, white pieces, black pieces, weight)
SIGNATURES = [
    ("KPvK",   [chess.PAWN],               [],           5),
    ("KPPvK",  [chess.PAWN, chess.PAWN],   [],           4),
    ("KPvKP",  [chess.PAWN],               [chess.PAWN], 4),
    ("KPPvKP", [chess.PAWN, chess.PAWN],   [chess.PAWN], 3),
    ("KQvK",   [chess.QUEEN],              [],           3),
    ("KRvK",   [chess.ROOK],               [],           3),
    ("KRPvKR", [chess.ROOK, chess.PAWN],   [chess.ROOK], 2),
    ("KQvKP",  [chess.QUEEN],              [chess.PAWN], 2),
    ("KRvKP",  [chess.ROOK],               [chess.PAWN], 2),
]
SIG_BY_NAME = {s[0]: s for s in SIGNATURES}

# --- Rating heuristic ------------------------------------------------------
# EXPLICITLY UNCALIBRATED. Difficulty here is conversion length and narrowness:
# a long win with few winning moves is hard to premove, a short wide one is easy.
# Every input is stored on the row so this can be refit from real attempt data
# without regenerating the pool — do that before trusting these numbers.
RATING_BASE = 500
RATING_PER_PLY = 45              # each extra ply of conversion
RATING_PER_NARROWNESS = 7        # each point of (100 - breadth_pct)
RATING_PER_EXTRA_PIECE = 40      # each piece beyond the 3-piece floor
RATING_MIN, RATING_MAX = 400, 2400

PREMOVE_NS = uuid.UUID("2b7e9a3c-4f1d-4e8a-9b6f-1c2d3e4f5a6b")


def rating_for(plies: int, breadth_pct: int, piece_count: int) -> int:
    r = (RATING_BASE
         + plies * RATING_PER_PLY
         + (100 - breadth_pct) * RATING_PER_NARROWNESS
         + max(0, piece_count - 3) * RATING_PER_EXTRA_PIECE)
    return max(RATING_MIN, min(RATING_MAX, r))


def random_position(white: list[int], black: list[int], rng: random.Random) -> chess.Board | None:
    """One random legal placement. Pawns never on rank 1 or 8. White to move and
    White is always the winning side — the caller checks WDL."""
    n = 2 + len(white) + len(black)
    sqs = rng.sample(range(64), n)
    board = chess.Board(None)
    board.set_piece_at(sqs[0], chess.Piece(chess.KING, chess.WHITE))
    board.set_piece_at(sqs[1], chess.Piece(chess.KING, chess.BLACK))
    i = 2
    for pt in white:
        if pt == chess.PAWN and chess.square_rank(sqs[i]) in (0, 7):
            return None
        board.set_piece_at(sqs[i], chess.Piece(pt, chess.WHITE))
        i += 1
    for pt in black:
        if pt == chess.PAWN and chess.square_rank(sqs[i]) in (0, 7):
            return None
        board.set_piece_at(sqs[i], chess.Piece(pt, chess.BLACK))
        i += 1
    board.turn = chess.WHITE
    return board if board.is_valid() else None


def breadth(board: chess.Board, tb: chess.syzygy.Tablebase) -> tuple[int, int]:
    """(winning_moves, legal_moves). A move keeps the win iff it mates outright
    or leaves the opponent in a lost position."""
    legal = list(board.legal_moves)
    keep = 0
    for m in legal:
        board.push(m)
        try:
            # is_game_over() re-checks insufficient material and repetition on
            # every call, which dominates the runtime here. A direct legal-move
            # test answers mate/stalemate for a fraction of the cost.
            if not any(board.legal_moves):
                if board.is_check():
                    keep += 1  # mate: the widest possible way of keeping the win
            elif tb.probe_wdl(board) < 0:
                keep += 1
        finally:
            board.pop()
    return keep, len(legal)


def conversion_plies(board: chess.Board, tb: chess.syzygy.Tablebase,
                     cap: int = MAX_CONVERSION_PLIES + 1) -> int | None:
    """Plies to mate under optimal play: the winner mates as fast as possible,
    the defender survives as long as possible. This is the real length of the
    win — unlike engine self-play (see the module docstring) it always
    terminates in mate.

    Cost discipline matters here, it is the hot loop. probe_wdl is ~0.01ms but
    probe_dtz is ~0.185ms, so every move is WDL-screened first and only the
    moves that survive that screen pay for a DTZ probe. The walk also aborts one
    ply past the cap rather than running to a natural end, since anything longer
    is rejected regardless of how much longer it is.
    """
    b = board.copy()
    winner = board.turn

    for ply in range(cap):
        if b.is_checkmate():
            return ply
        if b.is_game_over():
            return None  # stalemate / insufficient material: not a conversion

        best = None
        best_key: tuple[int, int] | None = None
        maximising = b.turn != winner  # the defender stalls

        for m in b.legal_moves:
            b.push(m)
            try:
                if b.is_checkmate():
                    # Mate on the board ends it. Only the winner can want this.
                    key = (0, 0) if not maximising else None
                    if key is None:
                        continue
                    b.pop()
                    b.push(m)
                    best, best_key = m, key
                    break
                if b.is_game_over():
                    continue  # a draw is never the winner's choice, nor the defender's escape
                if not maximising and tb.probe_wdl(b) >= 0:
                    continue  # cheap screen: this move throws the win away
                dtz = abs(tb.probe_dtz(b))
                key = (1, -dtz) if maximising else (1, dtz)
            finally:
                if b.move_stack and b.peek() == m:
                    b.pop()
            if best_key is None or key < best_key:
                best_key, best = key, m

        if best is None:
            return None
        b.push(best)

    return None


def main() -> int:
    args = dict(re.match(r"--([^=]+)=?(.*)", a).groups() for a in sys.argv[1:] if a.startswith("--"))
    limit = int(args.get("limit") or 8000)
    only = args.get("signature") or ""
    dry = "dry-run" in args
    rng = random.Random(int(args.get("seed") or 20260808))

    sigs = [SIG_BY_NAME[only]] if only else SIGNATURES
    if only and only not in SIG_BY_NAME:
        print(f"unknown signature {only}; known: {', '.join(SIG_BY_NAME)}")
        return 2

    total_weight = sum(s[3] for s in sigs)
    targets = {s[0]: max(1, round(limit * s[3] / total_weight)) for s in sigs}

    tb = chess.syzygy.open_tablebase(SYZYGY_PATH)
    print(f"BUILD: {limit} positions from {SYZYGY_PATH}  ({'dry run' if dry else 'writing'})")

    rows: list[tuple] = []
    stats: dict[str, Counter] = {s[0]: Counter() for s in sigs}
    t0 = time.time()

    for name, white, black, _w in sigs:
        want = targets[name]
        kept = 0
        attempts = 0
        seen: set[str] = set()
        budget = want * 400
        while kept < want and attempts < budget:
            attempts += 1
            st = stats[name]
            board = random_position(white, black, rng)
            if board is None:
                st["illegal"] += 1
                continue
            if board.is_game_over():
                st["terminal"] += 1
                continue
            if tb.probe_wdl(board) <= 0:
                st["not_win"] += 1
                continue
            win_moves, legal = breadth(board, tb)
            pct = round(100 * win_moves / legal) if legal else 0
            if win_moves < MIN_WINNING_MOVES or pct < MIN_BREADTH_PCT:
                st["low_breadth"] += 1
                continue
            plies = conversion_plies(board, tb)
            if plies is None or plies > MAX_CONVERSION_PLIES or plies < MIN_CONVERSION_PLIES:
                st["bad_length"] += 1
                continue
            fen = board.fen()
            if fen in seen:
                st["dupe"] += 1
                continue
            seen.add(fen)
            st["kept"] += 1
            kept += 1
            pieces = chess.popcount(board.occupied)
            rows.append((
                str(uuid.uuid5(PREMOVE_NS, fen)), fen, name, "w", pieces,
                pct, win_moves, legal, plies, rating_for(plies, pct, pieces),
            ))
        print(f"  {name:8} kept {kept:5}/{want:<5} from {attempts:6} attempts "
              f"({100*kept/max(1,attempts):4.1f}%)  " +
              " ".join(f"{k}={v}" for k, v in sorted(stats[name].items()) if k != "kept"))

    tb.close()
    el = time.time() - t0
    print(f"\n{len(rows)} kept in {el:.1f}s ({len(rows)/max(el,0.001):.0f}/s)")

    if dry or not rows:
        return 0

    conn = pymysql.connect(host="127.0.0.1", port=3306, user=os.environ["DB_USER"],
                           password=os.environ["DB_PASSWORD"], database=os.environ["DB_NAME"],
                           autocommit=False)
    try:
        with conn.cursor() as cur:
            for i in range(0, len(rows), 500):
                chunk = rows[i:i + 500]
                cur.executemany(
                    "INSERT IGNORE INTO premove_position "
                    "(id, fen, signature, side_to_move, piece_count, breadth_pct, winning_moves,"
                    " legal_moves, conversion_plies, rating, created_at, updated_at) "
                    "VALUES (%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,NOW(),NOW())", chunk)
            conn.commit()
    finally:
        conn.close()
    print(f"wrote {len(rows)} row(s) to premove_position (INSERT IGNORE, re-runnable)")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
