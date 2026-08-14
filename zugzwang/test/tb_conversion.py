#!/usr/bin/env python3
"""Tablebase-conversion suite: does the engine actually WIN a won <=5-man ending?

WHY
---
zugzwang draws won tablebase endings on the website. Two things combine:

  * `TB::probe_root` (the DTZ root probe, which is the ONLY thing that knows how
    to make PROGRESS) is called from `Search::start_smp` only — the UCI entry
    point. The HTTP serve path everything on the site uses (/bestmove,
    /candidates, /analyze, bot games) goes through `Search::start_group` ->
    `run_lazy_smp` and never probes DTZ.
  * WDL-in-search returns +-(VALUE_TB_WIN - ply) the moment popcount <= 5. In a
    5-man ending EVERY child of the root is a TB hit, so every winning move ties
    at the same score and search is effectively depth 1. Move ordering picks,
    the engine bounces a knight around, and the 50-move rule ends it.

So the bug is invisible to eval, to depth, and to any "did it find the best
move" test — all the winning moves ARE winning. The only thing that separates
them is whether they progress toward the next zeroing move fast enough to stay
inside the halfmove clock. That is what this suite measures.

HOW
---
White is zugzwang. Black is `tools/tbdefend`, Fathom's DTZ root probe, which for
a losing side returns the DTZ-MAXIMIZING move: perfect play for the 50-move
draw, the hardest defence that exists. A softer opponent would walk into the
mate and hide the bug.

Rules, legality and adjudication all come from the engine's own /move endpoint —
there is no second chess implementation here, and python-chess is deliberately
not a dependency.

A position PASSES only if all three hold:

  (a) the game ends in checkmate delivered by White;
  (b) the halfmove clock never reaches 100;
  (c) at EVERY White-to-move node the Syzygy root probe still reports a genuine
      TB_WIN — never CURSED_WIN. This is the sharp one. Fathom's root WDL folds
      the halfmove clock in (dtz_to_wdl, src/syzygy/tbprobe.cpp:559: TB_WIN iff
      `dtz + rule50 <= 100`), so the first node that reads CURSED_WIN names the
      exact move that threw the win away — long before the draw actually
      happens, and with the DTZ-optimal alternative right there to print.

Note (c) is NOT what src/zug_tb.cpp's probe_wdl() does: that one calls
tb_probe_wdl_impl, which ignores rule50 entirely and so reports a cursed win as
a full win. That mismatch is part of the bug, which is why the suite judges with
the root probe instead.

USAGE
-----
  ./test/tb_conversion.py                    # serve path (the website's path)
  ./test/tb_conversion.py --path uci         # UCI path (has the DTZ probe)
  ./test/tb_conversion.py --movetime 500 -v

The suite starts its OWN `zugzwang serve` on a free port and kills it on exit,
so it never touches a dev instance on :6476. Exit code is nonzero if any
position fails.
"""

import argparse
import json
import os
import socket
import subprocess
import sys
import time
import urllib.error
import urllib.request

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))

# Fathom WDL codes, from the side to move's point of view, with the halfmove
# clock already applied (src/syzygy/tbprobe.h:98).
WDL_NAME = {-1: "unknown", 0: "LOSS", 1: "BLESSED_LOSS", 2: "DRAW", 3: "CURSED_WIN", 4: "WIN"}
TB_WIN = 4

# Statuses from Rules::adjudicate (src/rules.cpp:196) that mean "keep playing".
ONGOING = "ongoing"


# ------------------------------------------------------------------ helpers

def free_port():
    """An ephemeral port the OS just handed us. Never :6476 — the dev serve."""
    while True:
        s = socket.socket()
        s.bind(("127.0.0.1", 0))
        p = s.getsockname()[1]
        s.close()
        if p != 6476:
            return p


def parse_epd(path):
    """`<FEN> ; <comment>` per line, # comments and blanks skipped."""
    out = []
    with open(path) as f:
        for raw in f:
            line = raw.strip()
            if not line or line.startswith("#"):
                continue
            fen, _, comment = line.partition(";")
            out.append((fen.strip(), comment.strip()))
    return out


# ------------------------------------------------------------------ players

class Serve:
    """A private `zugzwang serve`. Owns rules for both paths, and White's moves
    on --path serve."""

    def __init__(self, root, movetime, quiet=True):
        self.root = root
        self.movetime = movetime
        self.port = free_port()
        self.log = subprocess.DEVNULL if quiet else None
        self.proc = subprocess.Popen(
            [os.path.join(root, "zugzwang"), "serve", "-addr", "127.0.0.1:%d" % self.port],
            cwd=root, stdout=self.log, stderr=self.log)
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

    def bestmove(self, fen):
        r = self.post("/bestmove", {"fen": fen, "limits": {"movetime": self.movetime}})
        if not r.get("bestmove"):
            raise RuntimeError("serve /bestmove returned none: %s" % r.get("reason"))
        ev = r.get("eval") or {}
        return r["bestmove"], "eval=%s%s d=%s" % (ev.get("type", "?"), ev.get("value", "?"), r.get("depth"))

    def stop(self):
        self.proc.kill()
        self.proc.wait()


class Uci:
    """`./zugzwang uci` driving White. Rules still come from Serve — this speaks
    only `position fen` / `go movetime`."""

    def __init__(self, root, movetime):
        self.movetime = movetime
        self.proc = subprocess.Popen(
            [os.path.join(root, "zugzwang"), "uci"], cwd=root, text=True, bufsize=1,
            stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL)
        self._send("uci")
        self._wait("uciok")
        self._send("isready")
        self._wait("readyok")

    def _send(self, cmd):
        self.proc.stdin.write(cmd + "\n")
        self.proc.stdin.flush()

    def _wait(self, token):
        while True:
            line = self.proc.stdout.readline()
            if not line:
                raise RuntimeError("zugzwang uci died waiting for '%s'" % token)
            if line.startswith(token):
                return line.strip()

    def newgame(self):
        self._send("ucinewgame")
        self._send("isready")
        self._wait("readyok")

    def bestmove(self, fen):
        self._send("position fen " + fen)
        self._send("go movetime %d" % self.movetime)
        score, depth = "?", "?"
        while True:
            line = self.proc.stdout.readline()
            if not line:
                raise RuntimeError("zugzwang uci died during search")
            if line.startswith("info ") and " score " in line:
                score = line.split(" score ", 1)[1].split(" nodes")[0].split(" pv")[0].strip()
                parts = line.split()
                if "depth" in parts:
                    depth = parts[parts.index("depth") + 1]
            if line.startswith("bestmove"):
                return line.split()[1], "score=%s d=%s" % (score, depth)

    def stop(self):
        self.proc.kill()
        self.proc.wait()


class TbDefend:
    """One long-lived tools/tbdefend, so the tables are mapped once per run."""

    def __init__(self, root, syzygy):
        self.proc = subprocess.Popen(
            [os.path.join(root, "tools", "tbdefend"), "--path", syzygy], cwd=root,
            text=True, bufsize=1, stdin=subprocess.PIPE, stdout=subprocess.PIPE)

    def probe(self, fen):
        """-> (uci-or-sentinel, wdl, dtz), all from the side to move's view."""
        self.proc.stdin.write(fen + "\n")
        self.proc.stdin.flush()
        line = self.proc.stdout.readline()
        if not line:
            raise RuntimeError("tbdefend died")
        mv, wdl, dtz = line.split()
        return mv, int(wdl), int(dtz)

    def stop(self):
        self.proc.kill()
        self.proc.wait()


# ------------------------------------------------------------------ the game

class Failure(Exception):
    def __init__(self, kind, detail):
        super().__init__("%s: %s" % (kind, detail))
        self.kind = kind
        self.detail = detail


def play(fen, white, serve, tb, max_plies, verbose):
    """Play one position out. Returns (plies, max_rule50) or raises Failure."""
    ply = 0
    max_r50 = int(fen.split()[4])
    last_white = None  # (ply, move played, dtz-optimal move, budget before)

    while True:
        fields = fen.split()
        stm, rule50 = fields[1], int(fields[4])
        max_r50 = max(max_r50, rule50)

        # (b) the 50-move counter is the actual draw mechanism.
        if rule50 >= 100:
            raise Failure("50-move draw", "halfmove clock hit %d at ply %d" % (rule50, ply))
        if ply >= max_plies:
            raise Failure("no mate", "still playing after %d plies (r50=%d)" % (ply, rule50))

        mv, wdl, dtz = tb.probe(fen)
        if mv == "none":
            raise Failure("probe failed", "tbdefend cannot probe %s" % fen)

        if stm == "w":
            # (c) the sharp assertion: is this still a REAL win, or has the
            # halfmove clock already eaten it? Fathom's root WDL knows.
            if wdl != TB_WIN:
                if last_white:
                    lp, played, best, budget = last_white
                    detail = ("win lost by White's ply %d: played %s, DTZ-optimal was %s "
                              "(budget was %d/100, now %s)" % (lp, played, best, budget, WDL_NAME[wdl]))
                else:
                    detail = "start position is not a WIN (%s) — the EPD line is wrong" % WDL_NAME[wdl]
                raise Failure("win thrown away", detail)
            best, budget = mv, rule50 + dtz
            played, info = white.bestmove(fen)
            last_white = (ply + 1, played, best, budget)  # 1-based, matches the -v log
            tag = "zug   %-6s %-22s tbBest=%-6s budget=%3d/100%s" % (
                played, info, best, budget, "" if played == best else "  (not DTZ-optimal)")
        else:
            played = mv
            tag = "tbdef %-6s %-22s wdl=%s dtz=%d" % (played, "", WDL_NAME[wdl], dtz)

        r = serve.post("/move", {"fen": fen, "move": played})
        if not r.get("legal"):
            raise Failure("illegal move", "%s in %s" % (played, fen))
        fen = r["newFen"]
        ply += 1
        if verbose:
            print("   %3d %s -> %s" % (ply, tag, fen))

        status = r["status"]
        if status != ONGOING:
            # (a) only a White checkmate counts. Stalemate, insufficient
            # material and the rest are all failures to convert.
            if status == "checkmate" and r.get("result") == "1-0":
                return ply, max_r50
            raise Failure("no mate", "game ended '%s' (%s) at ply %d" % (status, r.get("result"), ply))


# ------------------------------------------------------------------ main

def main():
    ap = argparse.ArgumentParser(description=__doc__.split("\n")[0])
    ap.add_argument("--path", choices=("serve", "uci"), default="serve",
                    help="which entry point plays White (default: serve — the website's)")
    ap.add_argument("--movetime", type=int, default=200, help="ms per White move (default 200)")
    ap.add_argument("--max-plies", type=int, default=300, help="give up after this many plies")
    ap.add_argument("--positions", default=os.path.join(ROOT, "test", "tb_positions.epd"))
    ap.add_argument("--syzygy", default="syzygy", help="Syzygy dir, cwd-relative to the engine root")
    ap.add_argument("--root", default=ROOT, help="zugzwang root (where ./zugzwang lives)")
    ap.add_argument("-v", "--verbose", action="store_true", help="print every ply")
    args = ap.parse_args()

    for need in (os.path.join(args.root, "zugzwang"), os.path.join(args.root, "tools", "tbdefend")):
        if not os.path.exists(need):
            sys.exit("missing %s — run `make && make tbdefend`" % need)

    positions = parse_epd(args.positions)
    serve = Serve(args.root, args.movetime, quiet=not args.verbose)
    tb = TbDefend(args.root, args.syzygy)
    white = serve if args.path == "serve" else Uci(args.root, args.movetime)

    print("=== TB conversion suite: White=%s (%dms), Black=tbdefend (perfect DTZ), %d positions ==="
          % (args.path, args.movetime, len(positions)))
    failures = []
    try:
        for fen, comment in positions:
            if isinstance(white, Uci):
                white.newgame()
            label = comment or fen
            if args.verbose:
                print("--- %s\n    %s" % (label, fen))
            try:
                plies, max_r50 = play(fen, white, serve, tb, args.max_plies, args.verbose)
                print("  PASS  %-52s mate in %3d plies, peak r50 %3d" % (label[:52], plies, max_r50))
            except Failure as f:
                failures.append((label, fen, f))
                print("  FAIL  %-52s %s" % (label[:52], f))
            sys.stdout.flush()
    finally:
        tb.stop()
        if isinstance(white, Uci):
            white.stop()
        serve.stop()

    print("\n%d/%d converted (%s path, %dms)" %
          (len(positions) - len(failures), len(positions), args.path, args.movetime))
    if failures:
        print("failures:")
        for label, fen, f in failures:
            print("  %-24s %-42s %s" % (label.split()[0], fen, f))
    return 1 if failures else 0


if __name__ == "__main__":
    sys.exit(main())
