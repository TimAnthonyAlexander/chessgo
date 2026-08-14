#!/usr/bin/env python3
"""The serve boundary never emits a raw tablebase score as an evaluation.

WHY
---
zugzwang scores a Syzygy win as VALUE_TB_WIN = 31497 internally (src/types.h).
That is not an evaluation, it is a verdict — but it used to leave `serve` as an
ordinary `{"type":"cp","value":31497}`, and every consumer on the site divides
cp by 100. A won five-man ending therefore rendered as "+314.97" on the eval
bar while the engine shuffled a knight for thirty moves, and the same number
went into ACPL/accuracy in a player's Tutor report.

The fix (src/serve_json.h) keeps the object backward-compatible for a client
that predates it — `type` stays "cp" and `value` stays a sane, usable number
(TB_EVAL_CP = 1000) — and ADDS an optional `"tb": "win"|"loss"` carrying the
truth. This suite pins both halves.

WHAT IT ASSERTS
---------------
For every eval object appearing ANYWHERE in a response (the walk is recursive,
so a nested `lines[]`/`moves[]`/`positions[]` eval is covered, and a newly added
one is covered automatically):

  (a) no `cp` value ever has |value| >= 31000 — the whole point;
  (b) `tb`, when present, is exactly "win" or "loss" and rides on a `cp` object
      whose value is ±1000 with the matching sign;
  (c) on a KNOWN won <=5-man position, `tb` IS present — proving the tag isn't
      merely well-formed but is actually being produced;
  (d) an ordinary middlegame position produces no `tb` at all, so the tag can't
      have been wired to fire on everything;
  (e) a position DRAWN BY THE CLOCK — a cursed win or a blessed loss, where the
      halfmove counter has eaten the win — reports exactly cp 0 and carries no
      `tb` verdict at all.

(a) is deliberately broader than the TB band. It is a boundary assertion: NO
eval leaves this server with an absurd centipawn number, whatever produced it.

(e) IS THE SECOND HALF OF THE SAME BUG. Once the root DTZ ranking landed, a
≤5-man root reported `tbScore`, and in the cursed/blessed band that is not a
value — it is SF's 1..49cp "keep pressing" ORDERING incentive (tbprobe.cpp:1669,
"assign at least 1 cp to cursed wins"), rescaled to zug's 100cp pawn. So the
game position `8/3k1KPb/8/8/8/5N2/8/8 b - - 98 106` printed -47 above a PV
(Be4 g8=Q Bd5 Kxg8 …) that walks into the 50-move draw and ends in bare KN vs K:
a header contradicting its own line. Under the 50-move rule a cursed win IS a
draw, so reported_score() (src/search.cpp) now reports VALUE_DRAW there and
leaves tbRank — the ordering — alone in every band.

The cursed cases are GENERATED at runtime from tools/tbdefend, the same oracle
tb_conversion/tb_insearch use, rather than pinned: probe a won position for its
DTZ D, set the halfmove clock to 101 - D so that dtz + cnt50 = 101 (past SF's
`dtz + cnt50 <= 99` certain test AND past Fathom's own `<= 100`), then re-probe
and require the tables themselves to now say CURSED_WIN/BLESSED_LOSS before
asserting anything about the engine. The reported-game position is pinned
verbatim alongside them. Assertion (c) is the positive control that keeps (e)
from being satisfiable by simply never emitting a verdict.

UCI IS OUT OF SCOPE, ON PURPOSE. `zugzwang` on stdin still prints
`score cp 31497`, exactly as Stockfish does (~/sf18-arm/src/uci.cpp:531-541
prints `cp 20000 - plies` for a TB verdict). CCRL and external GUIs expect a
large cp there; only the JSON API has room for a second field.

USAGE
-----
  ./test/tb_eval_wire.py            # starts its own serve on a free port
  ./test/tb_eval_wire.py -v

Starts its OWN `zugzwang serve`, never :6476 (the dev instance). Nonzero exit
if any assertion fails.
"""

import argparse
import json
import os
import socket
import subprocess
import sys
import time
import urllib.request

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))

# The band assertion. VALUE_TB_WIN is 31497 and VALUE_TB_WIN_IN_MAX_PLY is
# 31251; 31000 sits below both and far above any real evaluation, so it catches
# a raw TB score however it was ply-adjusted on the way out.
ABSURD_CP = 31000

# What a tagged verdict must report, from src/serve_json.h.
TB_EVAL_CP = 1000

# <=5-man positions the tables solve outright. The first is the one from the
# bug report: White is winning and the old wire format called it "+314.97".
TB_WON = [
    ("8/6Pb/5K2/4N3/4k3/8/8/8 w - - 71 93", "KNP vs KB, White winning"),
    ("8/8/8/4k3/8/8/4KQ2/8 w - - 0 1", "KQ vs K"),
    ("8/8/8/8/8/4k3/4p3/4K3 b - - 0 1", "KP vs K, Black winning"),
]

# Ordinary positions, no tablebase in sight.
NON_TB = [
    ("rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1", "start position"),
    ("r1bqkbnr/pppp1ppp/2n5/4p3/2B1P3/5N2/PPPP1PPP/RNBQK2R b KQkq - 3 3", "Italian"),
]

# Won positions to WIND THE CLOCK FORWARD on for (e). Each is re-probed at
# cnt50 = 101 - DTZ and only used if tbdefend then calls it cursed/blessed.
CURSE_SEEDS = [
    ("8/6Pb/5K2/4N3/4k3/8/8/8 w - - 0 93", "KNP vs KB (the reported game)"),
    ("8/8/8/4k3/8/8/4KQ2/8 w - - 0 1", "KQ vs K"),
    ("8/8/8/8/8/4k3/4p3/4K3 b - - 0 1", "KP vs K, Black winning"),
    ("8/8/8/8/4k3/8/4KR2/8 w - - 0 1", "KR vs K"),
]

# Pinned drawn-by-clock positions. The first is the reported game verbatim, two
# plies from the 50-move draw, and is what printed -47 above a drawn PV.
CLOCK_DRAWN = [
    ("8/3k1KPb/8/8/8/5N2/8/8 b - - 98 106", "reported game, blessed loss at clock 98"),
    ("8/5KPb/2k5/8/8/5N2/8/8 w - - 99 107", "reported game, cursed win at the cliff"),
]

# tbdefend's WDL codes (Fathom's, halfmove clock applied): 0 LOSS, 1 BLESSED_LOSS,
# 2 DRAW, 3 CURSED_WIN, 4 WIN. 1 and 3 are exactly "won but for the clock".
WDL_BLESSED_LOSS, WDL_CURSED_WIN = 1, 3


def free_port():
    """An ephemeral port the OS just handed us. Never :6476 — the dev serve."""
    while True:
        s = socket.socket()
        s.bind(("127.0.0.1", 0))
        p = s.getsockname()[1]
        s.close()
        if p != 6476:
            return p


class Serve:
    def __init__(self, quiet=True):
        self.port = free_port()
        log = subprocess.DEVNULL if quiet else None
        self.proc = subprocess.Popen(
            [os.path.join(ROOT, "zugzwang"), "serve", "-addr", "127.0.0.1:%d" % self.port],
            cwd=ROOT, stdout=log, stderr=log)
        deadline = time.time() + 60
        while time.time() < deadline:
            if self.proc.poll() is not None:
                raise RuntimeError("serve died on startup (exit %s)" % self.proc.returncode)
            try:
                urllib.request.urlopen("http://127.0.0.1:%d/healthz" % self.port, timeout=1).read()
                return
            except Exception:
                time.sleep(0.2)
        raise RuntimeError("serve did not come up on port %d" % self.port)

    def post(self, path, obj):
        req = urllib.request.Request(
            "http://127.0.0.1:%d%s" % (self.port, path),
            data=json.dumps(obj).encode(), headers={"content-type": "application/json"})
        return json.loads(urllib.request.urlopen(req, timeout=300).read())

    def close(self):
        try:
            self.proc.terminate()
            self.proc.wait(timeout=10)
        except Exception:
            self.proc.kill()


def tbdefend(fens):
    """Ask tools/tbdefend for `<uci> <wdl> <dtz>` per FEN. The tables ARE the
    oracle here: the suite never asserts a position is cursed on its own say-so."""
    exe = os.path.join(ROOT, "tools", "tbdefend")
    if not os.path.exists(exe):
        raise RuntimeError("tools/tbdefend missing — `make tbdefend`")
    out = subprocess.run([exe] + list(fens), cwd=ROOT, capture_output=True, text=True)
    if out.returncode != 0:
        raise RuntimeError("tbdefend failed: %s" % out.stderr.strip())
    rows = [ln.split() for ln in out.stdout.strip().splitlines()]
    return [(r[0], int(r[1]), int(r[2])) for r in rows]


def with_clock(fen, cnt50):
    """The same FEN with its halfmove clock replaced. Nothing else moves, so the
    position is identical and only the 50-move budget differs."""
    f = fen.split()
    f[4] = str(cnt50)
    return " ".join(f)


def clock_drawn_cases():
    """(e)'s corpus: the pinned positions plus one generated per CURSE_SEED,
    every one of them confirmed cursed/blessed by tbdefend at its stated clock."""
    cases = list(CLOCK_DRAWN)
    seeds = [f for f, _ in CURSE_SEEDS]
    for (fen, note), (_mv, _wdl, dtz) in zip(CURSE_SEEDS, tbdefend(seeds)):
        cnt50 = 101 - dtz
        # cnt50 >= 100 is already a dead draw and would never be ranked cursed;
        # a negative clock is not a position. Both mean this seed cannot be wound.
        if not 0 <= cnt50 <= 99:
            continue
        cases.append((with_clock(fen, cnt50), "%s, clock %d (dtz %d)" % (note, cnt50, dtz)))

    verdicts = tbdefend([f for f, _ in cases])
    out, bad = [], []
    for (fen, note), (_mv, wdl, dtz) in zip(cases, verdicts):
        if wdl in (WDL_BLESSED_LOSS, WDL_CURSED_WIN):
            out.append((fen, "%s [tbdefend wdl=%d dtz=%d]" % (note, wdl, dtz)))
        else:
            bad.append("%s: tbdefend says wdl=%d, not cursed/blessed — %s" % (note, wdl, fen))
    return out, bad


def walk_evals(node, path="$"):
    """Every {"type","value"} eval object anywhere in a decoded response, with
    the JSON path it was found at. Recursive on purpose: a handler that starts
    nesting evals somewhere new is covered without touching this file."""
    if isinstance(node, dict):
        if node.get("type") in ("cp", "mate") and "value" in node:
            yield path, node
        for k, v in node.items():
            yield from walk_evals(v, "%s.%s" % (path, k))
    elif isinstance(node, list):
        for i, v in enumerate(node):
            yield from walk_evals(v, "%s[%d]" % (path, i))


def check_response(label, resp, failures, verbose):
    """(a) and (b) for every eval in one response. Returns the set of tb tags
    seen, so the caller can assert presence/absence."""
    seen = set()
    for path, ev in walk_evals(resp):
        where = "%s %s" % (label, path)
        value, kind, tb = ev.get("value"), ev.get("type"), ev.get("tb")

        if kind == "cp" and isinstance(value, int) and abs(value) >= ABSURD_CP:
            failures.append("%s: cp %d — a raw internal score reached the wire" % (where, value))

        if tb is not None:
            seen.add(tb)
            if tb not in ("win", "loss"):
                failures.append("%s: tb=%r, expected 'win' or 'loss'" % (where, tb))
            elif kind != "cp":
                failures.append("%s: tb rides on type=%r, expected 'cp'" % (where, kind))
            else:
                want = TB_EVAL_CP if tb == "win" else -TB_EVAL_CP
                if value != want:
                    failures.append("%s: tb=%s with value %r, expected %d" % (where, tb, value, want))
        if verbose:
            print("    %-52s %s" % (where, json.dumps(ev)))
    return seen


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("-v", "--verbose", action="store_true")
    ap.add_argument("--movetime", type=int, default=300)
    args = ap.parse_args()

    if not os.path.exists(os.path.join(ROOT, "zugzwang")):
        print("tb_eval_wire: build zugzwang first (make)", file=sys.stderr)
        return 1

    srv = Serve(quiet=not args.verbose)
    failures = []
    try:
        for fen, note in TB_WON:
            print("TB  %-44s %s" % (note, fen))
            calls = [
                ("/bestmove", {"fen": fen, "limits": {"movetime": args.movetime}}),
                ("/candidates", {"fen": fen, "limits": {"movetime": args.movetime, "multipv": 4}}),
                ("/analyze-game", {"startFen": fen, "moves": [], "movetime": args.movetime}),
            ]
            tags = set()
            for path, body in calls:
                resp = srv.post(path, body)
                tags |= check_response("%s %s" % (path, note), resp, failures, args.verbose)
            # (c) the tag is actually produced, not just well-formed when present.
            if not tags:
                failures.append("%s: no `tb` on a solved <=5-man position — the "
                                "verdict is being reported as an evaluation" % note)

        for fen, note in NON_TB:
            print("--  %-44s %s" % (note, fen))
            for path, body in [
                ("/bestmove", {"fen": fen, "limits": {"movetime": args.movetime}}),
                ("/candidates", {"fen": fen, "limits": {"movetime": args.movetime, "multipv": 4}}),
            ]:
                resp = srv.post(path, body)
                tags = check_response("%s %s" % (path, note), resp, failures, args.verbose)
                # (d) the tag must not fire on ordinary positions.
                if tags:
                    failures.append("%s %s: tagged %s on a position with no tablebase"
                                    % (path, note, sorted(tags)))

        # (e) drawn by the clock — the report must say so, and must agree with the
        # PV printed beneath it. A cursed win is a draw under the 50-move rule.
        cases, oracle_failures = clock_drawn_cases()
        failures.extend(oracle_failures)
        for fen, note in cases:
            print("50  %-44s %s" % (note[:44], fen))
            bm = srv.post("/bestmove", {"fen": fen, "limits": {"movetime": args.movetime}})
            check_response("/bestmove %s" % note, bm, failures, args.verbose)
            ev = bm.get("eval") or {}
            if ev.get("type") != "cp" or ev.get("value") != 0 or "tb" in ev:
                failures.append("/bestmove %s: eval %s — a position drawn by the halfmove "
                                "clock must report cp 0 with no tb verdict" % (note, json.dumps(ev)))

            cand = srv.post("/candidates",
                            {"fen": fen, "limits": {"movetime": args.movetime, "multipv": 4}})
            tags = check_response("/candidates %s" % note, cand, failures, args.verbose)
            # A sibling that loses outright is legitimately tagged `loss`; nothing in a
            # position the clock has drawn may be tagged a WIN.
            if "win" in tags:
                failures.append("/candidates %s: tagged `win` on a position drawn by the "
                                "halfmove clock" % note)
            top = (cand.get("moves") or [{}])[0].get("eval") or {}
            if top.get("type") != "cp" or top.get("value") != 0 or "tb" in top:
                failures.append("/candidates %s: best line eval %s, expected cp 0 with no tb"
                                % (note, json.dumps(top)))
    finally:
        srv.close()

    if failures:
        print("\nFAIL (%d)" % len(failures))
        for f in failures:
            print("  " + f)
        return 1

    print("\nPASS — no eval on any endpoint carries |cp| >= %d; every `tb` is "
          "well-formed and present exactly where a tablebase decides it; every "
          "position the halfmove clock has drawn reports 0.00 and no verdict." % ABSURD_CP)
    return 0


if __name__ == "__main__":
    sys.exit(main())
