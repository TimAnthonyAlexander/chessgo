#!/usr/bin/env python3
"""
pgn_to_jsonl.py — transcode zstd-compressed (or plain) Lichess PGN, annotated
with [%eval] / [%clk], into normalized JSONL for the chessgo Tutor feature's
PHP metric engine.

Environment setup used to build/run this (already done on this machine):

    python3 -m venv ~/tutor-data/venv
    ~/tutor-data/venv/bin/pip install chess zstandard

Usage:

    ~/tutor-data/venv/bin/python3 scripts/tutor/pgn_to_jsonl.py \
        --in ~/tutor-data/eval_games_2026-06.pgn.zst \
        --out ~/tutor-data/games_2026-06.jsonl.zst

    # stdin/stdout also work, and plain (non-.zst) PGN is auto-detected:
    zstd -dc corpus.pgn.zst | ~/tutor-data/venv/bin/python3 scripts/tutor/pgn_to_jsonl.py > out.jsonl

Output: one JSON object per line, one per emitted game. See the field
contract in the ply-loop comment below — the eval/clock offset there is the
whole point of this script and must not be "fixed" without re-reading it.

    --limit N       stop after N EMITTED games (for quick testing/verification)
    --out PATH      default stdout; if PATH ends in .zst, output is zstd-compressed
    --progress-every N   games-read interval for stderr progress (default 10000)
"""

import argparse
import io
import json
import re
import sys
import time

import chess
import chess.pgn

try:
    import zstandard as zstd
except ImportError:  # pragma: no cover - required at runtime for .zst I/O
    zstd = None

ZSTD_MAGIC = b"\x28\xb5\x2f\xfd"

EVAL_RE = re.compile(r"\[%eval\s+([^\]]+)\]")
CLK_RE = re.compile(r"\[%clk\s+([0-9:]+)\]")
TC_RE = re.compile(r"^(\d+)\+(\d+)$")

NP_TYPES = (chess.KNIGHT, chess.BISHOP, chess.ROOK, chess.QUEEN)

TERM_MAP = {
    "time forfeit": "timeout",
    "normal": "normal",
    "abandoned": "abandoned",
}


class _PrefixedReader:
    """A binary reader that replays already-consumed prefix bytes first.

    Lets us sniff the zstd magic number from the first 4 bytes of a stream
    (file or stdin, seekable or not) without losing them.
    """

    def __init__(self, prefix: bytes, f):
        self._buf = prefix
        self._f = f

    def read(self, n=-1):
        if self._buf:
            if n == -1:
                out = self._buf + self._f.read(-1)
                self._buf = b""
                return out
            if n >= len(self._buf):
                need = n - len(self._buf)
                out = self._buf + self._f.read(need)
                self._buf = b""
                return out
            out, self._buf = self._buf[:n], self._buf[n:]
            return out
        return self._f.read(n)


def open_input(path):
    """Open path (or '-'/None for stdin) as a text stream, transparently
    decompressing zstd input regardless of whether the source is seekable."""
    raw = sys.stdin.buffer if (path is None or path == "-") else open(path, "rb")
    head = raw.read(4)
    prefixed = _PrefixedReader(head, raw)
    if head == ZSTD_MAGIC:
        if zstd is None:
            raise SystemExit("input looks zstd-compressed but `zstandard` is not installed")
        dctx = zstd.ZstdDecompressor()
        stream = dctx.stream_reader(prefixed)
        return io.TextIOWrapper(stream, encoding="utf-8", errors="replace")
    return io.TextIOWrapper(prefixed, encoding="utf-8", errors="replace")


def open_output(path):
    if path is None or path == "-":
        return sys.stdout
    if path.endswith(".zst"):
        if zstd is None:
            raise SystemExit("output path ends in .zst but `zstandard` is not installed")
        f = open(path, "wb")
        cctx = zstd.ZstdCompressor(level=9)
        stream = cctx.stream_writer(f)
        return io.TextIOWrapper(stream, encoding="utf-8")
    return open(path, "w", encoding="utf-8")


def count_np_pieces(board: chess.Board) -> int:
    n = 0
    for pt in NP_TYPES:
        n += len(board.pieces(pt, chess.WHITE)) + len(board.pieces(pt, chess.BLACK))
    return n


def parse_eval(comment: str):
    m = EVAL_RE.search(comment)
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


def parse_clk_ms(comment: str):
    m = CLK_RE.search(comment)
    if not m:
        return None
    parts = m.group(1).split(":")
    try:
        parts = [int(p) for p in parts]
    except ValueError:
        return None
    if len(parts) == 3:
        h, mnt, s = parts
    elif len(parts) == 2:
        h, (mnt, s) = 0, parts
    else:
        return None
    return (h * 3600 + mnt * 60 + s) * 1000


def parse_time_control(tc: str):
    """Returns (category, base_ms, inc_ms). category='correspondence' with
    null base/inc when unparseable (still emit the game)."""
    if not tc:
        return "correspondence", None, None
    m = TC_RE.match(tc.strip())
    if not m:
        return "correspondence", None, None
    base_s, inc_s = int(m.group(1)), int(m.group(2))
    est = base_s + 40 * inc_s
    if est < 180:
        cat = "bullet"
    elif est < 480:
        cat = "blitz"
    elif est < 1500:
        cat = "rapid"
    else:
        cat = "classical"
    return cat, base_s * 1000, inc_s * 1000


def map_reason(term: str) -> str:
    if not term:
        return ""
    t = term.strip().lower()
    return TERM_MAP.get(t, t)


def opening_family(opening: str) -> str:
    if not opening:
        return ""
    idx = len(opening)
    for sep in (":", ","):
        p = opening.find(sep)
        if p != -1:
            idx = min(idx, p)
    return opening[:idx].strip()


def game_id_from_site(site: str) -> str:
    if not site:
        return ""
    return site.rstrip("/").rsplit("/", 1)[-1]


def transcode_game(game: chess.pgn.Game):
    """Returns (record_dict_or_None, skip_reason_or_None)."""
    headers = game.headers

    white_elo_raw = headers.get("WhiteElo", "")
    black_elo_raw = headers.get("BlackElo", "")
    try:
        white_rating = int(white_elo_raw)
        black_rating = int(black_elo_raw)
    except (ValueError, TypeError):
        return None, "no_rating"

    result = headers.get("Result", "*")
    if result == "*":
        return None, "star_result"

    # --- Walk the mainline once, building one `plies` entry per POSITION. ---
    #
    # Contract (see task spec): entry i describes the position BEFORE move i
    # and carries the move played FROM it (san/piece). The PGN [%eval] that
    # follows move i in the source text describes the position AFTER move i
    # — i.e. the position at entry i+1 — so it is applied to entry i+1, one
    # index ahead of the move/clock it was written next to. The [%clk] that
    # follows move i is the mover's remaining clock immediately after playing
    # move i, so it stays on entry i (the entry whose san IS move i).
    plies = []
    board = game.board()
    node = game
    pending_eval = None  # eval carried forward from the previous move's comment
    eval_count = 0

    while node.variations:
        nxt = node.variations[0]
        move = nxt.move

        san = board.san(move)
        piece_obj = board.piece_at(move.from_square)
        piece_letter = chess.piece_symbol(piece_obj.piece_type).upper() if piece_obj else None
        np_pieces = count_np_pieces(board)

        comment = nxt.comment or ""
        this_clk = parse_clk_ms(comment)
        this_eval = parse_eval(comment)

        if pending_eval is not None:
            eval_count += 1
        plies.append({
            "evalWhite": pending_eval,
            "san": san,
            "piece": piece_letter,
            "npPieces": np_pieces,
            "clockMs": this_clk,
        })

        pending_eval = this_eval
        board.push(move)
        node = nxt

    # Terminal (last) entry: no move follows.
    if pending_eval is not None:
        eval_count += 1
    plies.append({
        "evalWhite": pending_eval,
        "san": None,
        "piece": None,
        "npPieces": count_np_pieces(board),
        "clockMs": None,
    })

    num_moves = len(plies) - 1
    if num_moves < 10:
        return None, "too_few_plies"
    if eval_count < 6:
        return None, "too_few_evals"

    category, base_ms, inc_ms = parse_time_control(headers.get("TimeControl", ""))

    record = {
        "id": game_id_from_site(headers.get("Site", "")),
        "category": category,
        "whiteRating": white_rating,
        "blackRating": black_rating,
        "result": result,
        "reason": map_reason(headers.get("Termination", "")),
        "opening": opening_family(headers.get("Opening", "")),
        "eco": headers.get("ECO", ""),
        "baseMs": base_ms,
        "incMs": inc_ms,
        "plies": plies,
    }
    return record, None


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("input", nargs="?", default="-", help="PGN(.zst) path, or '-'/omit for stdin")
    ap.add_argument("--in", dest="in_path", default=None, help="alias for the positional input path")
    ap.add_argument("--out", dest="out_path", default="-", help="output path (.jsonl or .jsonl.zst); default stdout")
    ap.add_argument("--limit", type=int, default=None, help="stop after N emitted games")
    ap.add_argument("--progress-every", type=int, default=10000, help="games-read interval for stderr progress")
    args = ap.parse_args()

    in_path = args.in_path if args.in_path is not None else args.input

    in_stream = open_input(in_path)
    out_stream = open_output(args.out_path)

    emitted = 0
    read = 0
    skip_counts = {}
    start = time.time()

    try:
        while True:
            if args.limit is not None and emitted >= args.limit:
                break
            game = chess.pgn.read_game(in_stream)
            if game is None:
                break
            read += 1

            record, skip_reason = transcode_game(game)
            if skip_reason is not None:
                skip_counts[skip_reason] = skip_counts.get(skip_reason, 0) + 1
            else:
                out_stream.write(json.dumps(record, separators=(",", ":")))
                out_stream.write("\n")
                emitted += 1

            if read % args.progress_every == 0:
                elapsed = time.time() - start
                rate = read / elapsed if elapsed > 0 else 0.0
                print(
                    f"[progress] read={read} emitted={emitted} skipped={read - emitted} "
                    f"rate={rate:.1f} games/s elapsed={elapsed:.1f}s",
                    file=sys.stderr,
                )
    finally:
        out_stream.flush()
        if out_stream is not sys.stdout:
            out_stream.close()

    elapsed = time.time() - start
    rate = read / elapsed if elapsed > 0 else 0.0
    print(f"[done] read={read} emitted={emitted} skipped={read - emitted} "
          f"elapsed={elapsed:.1f}s rate={rate:.1f} games/s", file=sys.stderr)
    print(f"[skip reasons] {json.dumps(skip_counts)}", file=sys.stderr)


if __name__ == "__main__":
    main()
