#!/usr/bin/env python3
"""Secret Queen end-to-end self-play against a live zugzwang serve.

Plays bot-vs-bot games through the real HTTP endpoints and asserts, on EVERY
ply, the invariants that unit tests cannot see:

  * the move the bot returns is in that position's own legal-move list
  * the canonical FEN's secret field only ever shrinks (a secret is never
    re-hidden once revealed) and a revealed queen really appears on the board
  * REDACTION: White's view never names Black's secret square, Black's never
    names White's, and the spectator board FEN names neither
  * games terminate, with a status/result the caller can act on

Usage: python3 sq_selfplay.py [games] [base-url]
"""
import json
import random
import sys
import urllib.request

BASE = sys.argv[2] if len(sys.argv) > 2 else "http://127.0.0.1:6476"
GAMES = int(sys.argv[1]) if len(sys.argv) > 1 else 6
START = "rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1"
MAX_PLIES = 300

failures = []
PREV = {"fen": "", "move": ""}


def post(path, body):
    req = urllib.request.Request(
        BASE + path, data=json.dumps(body).encode(), headers={"Content-Type": "application/json"}
    )
    with urllib.request.urlopen(req, timeout=60) as r:
        return json.loads(r.read())


def secrets_of(fen):
    """(white_square, black_square) from a canonical FEN's trailing [w|b]."""
    tail = fen.split(" ")[-1]
    if not (tail.startswith("[") and tail.endswith("]")):
        return (None, None)
    w, b = tail[1:-1].split("|")
    return (None if w == "-" else w, None if b == "-" else b)


def board_field(fen):
    return fen.split(" ")[0]


def piece_at(board, square):
    """Piece char on `square` (e.g. 'e2') in a FEN board field, or None."""
    file_i = "abcdefgh".index(square[0])
    rank_i = int(square[1]) - 1
    rows = board.split("/")  # rows[0] is rank 8
    row = rows[7 - rank_i]
    col = 0
    for ch in row:
        if ch.isdigit():
            col += int(ch)
        else:
            if col == file_i:
                return ch
            col += 1
    return None


def king_square(board, color):
    want = "K" if color == "w" else "k"
    for rank_i in range(8):
        for file_i in range(8):
            sq = "abcdefgh"[file_i] + str(rank_i + 1)
            if piece_at(board, sq) == want:
                return sq
    return None


def king_capturable_by_visible(fen, victim):
    """Can the side to move capture `victim`'s king with a piece `victim` can SEE?

    A capture by the opponent's still-hidden queen is the ambush the variant is
    built on and is excluded — the victim could not have known.
    """
    ksq = king_square(board_field(fen), victim)
    if ksq is None:
        return None
    opp_secret = secrets_of(fen)[1 if victim == "w" else 0]
    for mv in post("/secretqueen/legal-moves", {"fen": fen})["moves"]:
        if mv[2:4] == ksq and mv[0:2] != opp_secret:
            return mv
    return None


def check_king_not_hung_to_visible(game_i, ply, fen, mover):
    """The bot must never lose its king to a piece it could SEE — IF it had a way out.

    Losing the king to a visible piece is not automatically a blunder here. A
    chess-checkmated position in this variant is genuinely lost: every move
    (including the ones chess forbids, which are exactly the ones that leave
    your own king attacked) still ends with the king captured. The engine
    correctly returns no move there and the bot falls back to grabbing material.

    So the real test is counterfactual: did the mover have SOME alternative
    after which the king was not capturable in plain sight? Only then was this
    a blunder. That second pass costs a request per alternative, so it runs
    only when the cheap check has already fired.
    """
    mv = king_capturable_by_visible(fen, mover)
    if mv is None:
        return

    for alt in post("/secretqueen/legal-moves", {"fen": PREV["fen"]})["moves"]:
        if alt == PREV["move"]:
            continue
        try:
            after = post("/secretqueen/move", {"fen": PREV["fen"], "move": alt})
        except Exception:
            continue
        if after["kingCaptured"]:
            continue  # this alternative wins outright — not a "save", but fine
        if king_capturable_by_visible(after["newFen"], mover) is None:
            fail(
                game_i,
                ply,
                f"{mover} hung its king to a VISIBLE piece ({mv}) when {alt} would "
                f"have saved it\n"
                f"      pre-move  : {PREV['fen']}\n"
                f"      played    : {PREV['move']}\n"
                f"      post-move : {fen}",
            )
            return


def fail(game_i, ply, msg):
    failures.append(f"game {game_i} ply {ply}: {msg}")
    print(f"  FAIL game {game_i} ply {ply}: {msg}")


def check_redaction(game_i, ply, resp):
    """The whole variant rests on this: no view names the other side's secret."""
    canon_w, canon_b = secrets_of(resp["newFen"])
    vw_w, vw_b = secrets_of(resp["fenWhite"])
    vb_w, vb_b = secrets_of(resp["fenBlack"])

    if vw_w != canon_w:
        fail(game_i, ply, f"White's view lost their own secret ({vw_w} != {canon_w})")
    if vw_b is not None:
        fail(game_i, ply, f"White's view LEAKS Black's secret ({vw_b})")
    if vb_b != canon_b:
        fail(game_i, ply, f"Black's view lost their own secret ({vb_b} != {canon_b})")
    if vb_w is not None:
        fail(game_i, ply, f"Black's view LEAKS White's secret ({vb_w})")
    if "[" in resp["boardFen"]:
        fail(game_i, ply, f"spectator board FEN carries a secret field: {resp['boardFen']}")

    # A hidden queen must be a PAWN on the board in every view — the disguise is
    # the board itself, not something layered on top of it.
    for who, sq, want in (("white", canon_w, "P"), ("black", canon_b, "p")):
        if sq is None:
            continue
        got = piece_at(board_field(resp["newFen"]), sq)
        if got != want:
            fail(game_i, ply, f"{who} hidden queen on {sq} renders as {got!r}, expected {want!r}")


def play_game(game_i, rating):
    fen = START
    # Designate both sides on random home-rank pawns.
    for color, rank in (("w", "2"), ("b", "7")):
        sq = random.choice("abcdefgh") + rank
        fen = post("/secretqueen/designate", {"fen": fen, "color": color, "square": sq})["newFen"]

    w0, b0 = secrets_of(fen)
    print(f"game {game_i}: white={w0} black={b0} rating={rating}")

    prev_w, prev_b = w0, b0
    reveals = 0
    for ply in range(MAX_PLIES):
        legal = post("/secretqueen/legal-moves", {"fen": fen})["moves"]
        if not legal:
            print(f"  ply {ply}: no legal moves")
            return "no-moves", reveals

        resp = post(
            "/secretqueen/bestmove",
            {"fen": fen, "limits": {"rating": rating, "movetime": 60}},
        )
        bm = resp.get("bestmove")
        if bm is None:
            return "no-bestmove", reveals
        if bm not in legal:
            fail(game_i, ply, f"bestmove {bm} is NOT in the legal list")
            return "illegal", reveals

        check_redaction(game_i, ply, resp)

        w, b = secrets_of(resp["newFen"])
        # A secret may vanish (revealed/captured/promoted) or move to another
        # square, but a side that has none must never acquire one again.
        if prev_w is None and w is not None:
            fail(game_i, ply, "White's secret came back from the dead")
        if prev_b is None and b is not None:
            fail(game_i, ply, "Black's secret came back from the dead")

        rv = resp.get("reveal") or {}
        if rv.get("moved") or rv.get("promoted"):
            reveals += 1
            sq = rv["square"]
            got = piece_at(board_field(resp["newFen"]), sq)
            if got not in ("Q", "q"):
                fail(game_i, ply, f"reveal on {sq} left {got!r}, expected a queen")

        prev_w, prev_b = w, b
        mover = "w" if resp["sideToMove"] == "b" else "b"
        PREV["fen"], PREV["move"] = fen, bm
        fen = resp["newFen"]

        if resp["status"] == "ongoing":
            check_king_not_hung_to_visible(game_i, ply, fen, mover)

        if resp["status"] != "ongoing":
            print(
                f"  ended ply {ply}: {resp['status']} {resp['result']} "
                f"(kingCaptured={resp['kingCaptured']}, reveals={reveals})"
            )
            return resp["status"], reveals

    print(f"  hit the {MAX_PLIES}-ply cap")
    return "cap", reveals


def main():
    results = {}
    total_reveals = 0
    for i in range(GAMES):
        rating = random.choice([800, 1500, 2200, 3500])
        st, rv = play_game(i, rating)
        results[st] = results.get(st, 0) + 1
        total_reveals += rv

    print("\noutcomes:", results)
    print("total reveals:", total_reveals)
    if failures:
        print(f"\n{len(failures)} FAILURE(S)")
        return 1
    print("\nall self-play invariants held")
    return 0


sys.exit(main())
