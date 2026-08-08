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
MIN_CHAIN_LEN = 3          # 2 is a gimme; below this there is nothing to queue
MAX_CHAIN_LEN = 12         # must fit the clock and MAX_CHAIN on the server
CHAIN_FRONTIER_CAP = 2000  # belief-state ceiling; above this, give up on the position.
                           # Measured: raising it to 20000 found no extra positions
                           # (27% hit rate either way) but made each MISS cost 1.64s
                           # instead of ~0.2s, since a doomed search expands to the
                           # cap before conceding. Misses dominate, so the small cap
                           # is ~7x faster end to end.

# --- Signatures (spec §3.2), weighted toward promotion races ---------------
# (name, white pieces, black pieces, weight)
SIGNATURES = [
    # Forcing requires a BARE enemy king. Any defending material multiplies their
    # options and no chain survives contact: KQvKR measured 0/30, KPvK 0/20 even
    # with 26-move chains, KRvK 0/30 (a lone rook cannot herd a king blind).
    ("KQvK",  [chess.QUEEN],                 [], 5),
    ("KQNvK", [chess.QUEEN, chess.KNIGHT],   [], 4),
    ("KQQvK", [chess.QUEEN, chess.QUEEN],    [], 3),
    ("KRRvK", [chess.ROOK, chess.ROOK],      [], 3),
    ("KQBvK", [chess.QUEEN, chess.BISHOP],   [], 3),
    ("KQRvK", [chess.QUEEN, chess.ROOK],     [], 2),
]
SIG_BY_NAME = {s[0]: s for s in SIGNATURES}

# --- Rating heuristic ------------------------------------------------------
# EXPLICITLY UNCALIBRATED. Difficulty here is conversion length and narrowness:
# a long win with few winning moves is hard to premove, a short wide one is easy.
# Every input is stored on the row so this can be refit from real attempt data
# without regenerating the pool — do that before trusting these numbers.
RATING_BASE = 500
RATING_PER_CHAIN_MOVE = 190      # each move of the forced chain
RATING_PER_EXTRA_PIECE = 60      # extra attacking material makes it EASIER to see
RATING_MIN, RATING_MAX = 400, 2400

FLUSH_EVERY = 50   # rows between DB writes; a run is long, don't hold work in memory

PREMOVE_NS = uuid.UUID("2b7e9a3c-4f1d-4e8a-9b6f-1c2d3e4f5a6b")


def rating_for(chain_len: int, piece_count: int) -> int:
    """Difficulty is chain length: a longer forced sequence is strictly more to
    hold in your head and type before the clock runs out. Material is a minor
    term (two queens are easier to see than one). Explicitly uncalibrated —
    every input is stored so this can be refit from real attempts."""
    r = (RATING_BASE
         + chain_len * RATING_PER_CHAIN_MOVE
         - max(0, piece_count - 3) * RATING_PER_EXTRA_PIECE)
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


def forced_mate_chain(board: chess.Board, tb: chess.syzygy.Tablebase,
                      maxlen: int = MAX_CHAIN_LEN,
                      cap: int = CHAIN_FRONTIER_CAP) -> list[str] | None:
    """The chain of premoves that MATES against every defence, or None.

    This is the whole filter. Track the SET of positions you might be facing (the
    belief state a premover is actually in), pick a move that is legal and still
    winning in every one of them, expand by ALL defender replies, repeat — until
    every branch is mate.

    An earlier version only required each move to stay legal and winning, not to
    progress. That is satisfiable by shuffling, so a queen circling a corner
    scored a perfect 10 and the mode still played like tactics. Requiring mate is
    what makes it premoving.

    Greedy on worst-case DTZ across the belief state, so a None here is a floor,
    not a proof: a smarter chain may exist. That is fine for a filter — we only
    ever need positions we are CERTAIN about.

    Deduplicating the frontier is load-bearing, not an optimisation: defender
    lines transpose heavily and without it the set explodes past any cap after
    ~3 plies, at which point the function measures the cap instead of the chess.
    """
    def key(b: chess.Board) -> str:
        return b.board_fen() + (" w" if b.turn else " b")

    frontier = {key(board): board.copy()}
    chain: list[str] = []

    for _ in range(maxlen):
        boards = list(frontier.values())

        common: set[tuple[int, int]] | None = None
        for b in boards:
            moves = {(m.from_square, m.to_square) for m in b.legal_moves}
            common = moves if common is None else (common & moves)
            if not common:
                break
        if not common:
            return None

        scored: list[tuple[int, int, int]] = []
        for fr, to in common:
            worst = -1
            ok = True
            for b in boards:
                mv = next((m for m in b.legal_moves if m.from_square == fr and m.to_square == to), None)
                if mv is None:
                    ok = False
                    break
                b.push(mv)
                try:
                    if b.is_checkmate():
                        d = 0
                    elif not any(b.legal_moves) or tb.probe_wdl(b) >= 0:
                        ok = False
                        d = 0
                    else:
                        d = abs(tb.probe_dtz(b))
                finally:
                    b.pop()
                if not ok:
                    break
                worst = max(worst, d)
            if ok:
                scored.append((worst, fr, to))
        if not scored:
            return None

        scored.sort()
        _, fr, to = scored[0]

        nxt: dict[str, chess.Board] = {}
        mated_everywhere = True
        for b in boards:
            mv = next(m for m in b.legal_moves if m.from_square == fr and m.to_square == to)
            b.push(mv)
            try:
                if not b.is_game_over():
                    mated_everywhere = False
                    for reply in b.legal_moves:
                        b.push(reply)
                        nxt[key(b)] = b.copy()
                        b.pop()
            finally:
                b.pop()

        chain.append(chess.square_name(fr) + chess.square_name(to))
        if mated_everywhere:
            return chain
        if len(nxt) > cap:
            return None
        frontier = nxt

    return None


def write_rows(rows: list[tuple]) -> None:
    """Flush a batch to premove_position. Called after EVERY signature, not once
    at the very end: a run takes over an hour, and writing only at the end meant
    an interrupt — a reboot, a stray pkill, a full disk — threw away all of it."""
    if not rows:
        return
    conn = pymysql.connect(host="127.0.0.1", port=3306, autocommit=False, **db_credentials())
    try:
        with conn.cursor() as cur:
            for i in range(0, len(rows), 500):
                cur.executemany(
                    "INSERT IGNORE INTO premove_position "
                    "(id, fen, signature, side_to_move, piece_count, breadth_pct, winning_moves,"
                    " legal_moves, forced_chain_len, rating, created_at, updated_at) "
                    "VALUES (%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,NOW(),NOW())", rows[i:i + 500])
        conn.commit()
    finally:
        conn.close()
    print(f"  wrote {len(rows)} row(s)", flush=True)


def db_credentials() -> dict[str, str]:
    """Read DB_* straight out of .env. Deliberately not taken from the shell
    environment: exporting them per invocation meant every run of this script was
    a shell command carrying secrets, which is both noisy and needless."""
    env: dict[str, str] = {}
    with open(os.path.join(REPO, ".env")) as fh:
        for line in fh:
            line = line.strip()
            if line and not line.startswith("#") and "=" in line:
                k, v = line.split("=", 1)
                env[k.strip()] = v.strip()
    return {"user": env["DB_USER"], "password": env["DB_PASSWORD"], "database": env["DB_NAME"]}


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
        flushed = len(rows)
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
            # The one filter that matters. Everything else is recorded, not gated.
            chain = forced_mate_chain(board, tb)
            if chain is None:
                st["no_forced_chain"] += 1
                continue
            if not (MIN_CHAIN_LEN <= len(chain) <= MAX_CHAIN_LEN):
                st["chain_length"] += 1
                continue
            win_moves, legal = breadth(board, tb)
            pct = round(100 * win_moves / legal) if legal else 0
            fen = board.fen()
            if fen in seen:
                st["dupe"] += 1
                continue
            seen.add(fen)
            st["kept"] += 1
            kept += 1
            if not dry and len(rows) - flushed >= FLUSH_EVERY:
                write_rows(rows[flushed:])
                flushed = len(rows)
            pieces = chess.popcount(board.occupied)
            rows.append((
                str(uuid.uuid5(PREMOVE_NS, fen)), fen, name, "w", pieces,
                pct, win_moves, legal, len(chain), rating_for(len(chain), pieces),
            ))
        if not dry:
            write_rows(rows[flushed:])
        print(f"  {name:8} kept {kept:5}/{want:<5} from {attempts:6} attempts "
              f"({100*kept/max(1,attempts):4.1f}%)  " +
              " ".join(f"{k}={v}" for k, v in sorted(stats[name].items()) if k != "kept"))

    tb.close()
    el = time.time() - t0
    print(f"\n{len(rows)} kept in {el:.1f}s ({len(rows)/max(el,0.001):.0f}/s)")

    # No final write: each signature already flushed its own rows above. Doing it
    # again here would be a harmless no-op (INSERT IGNORE on a deterministic id)
    # but it re-sends every row for nothing.
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
