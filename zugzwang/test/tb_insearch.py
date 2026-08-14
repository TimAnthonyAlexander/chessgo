#!/usr/bin/env python3
"""In-search Syzygy WDL gate: does the engine's WDL-in-search probe tell the truth?

WHY THIS EXISTS SEPARATELY FROM test/tb_conversion.py
-----------------------------------------------------
tb_conversion.py plays out won <=5-man endings. Since the root DTZ ranking landed,
a <=5-man root is ranked, which ZEROES C.tbCardinality and switches the in-search
WDL probe OFF for that entire search (src/search.cpp, Search::start()). So the 24
positions in test/tb_positions.epd, valuable as they are, barely touch the in-search
probe at all — and the in-search probe is the half that runs in the far more common
case: a 6+-man root the tables cannot rank, whose search descends into <=5-man nodes.
Every real game is 6+ men long before it is 5.

This file gates that half, in two parts.

PART A — the score gate (the reported production bug, in isolation)
-------------------------------------------------------------------
Syzygy WDL tables answer "is this won starting from a FRESH halfmove clock". They
know nothing about the clock the game actually carries. zug calls tb_probe_wdl_impl
directly, which skips the `rule50 != 0` refusal Fathom's own wrapper performs
(src/syzygy/tbprobe.h:220-223), so without an explicit gate a win the 50-move counter
has already eaten still reads as a full win. That is what showed a dead-drawn KNPvKB
as +314.96 for 16 consecutive moves in a real game.

Every case is generated and judged at RUNTIME by tools/tbdefend (Fathom's clock-aware
DTZ root probe) — no verdict is hardcoded:

  * probe the position at clock 0 to learn its DTZ distance D;
  * re-probe it at clock 101 - D, where dtz_to_wdl (src/syzygy/tbprobe.cpp:559) must
    now say CURSED_WIN / BLESSED_LOSS: the win exists but the counter has eaten it,
    i.e. the position is a DRAW;
  * assert the engine does NOT claim a forced win or loss there.

The cases run with TBROOTRANK=0, and that is deliberate rather than incidental: with
root ranking ON, a <=5-man root is ranked and the in-search probe never fires, so the
same assertions would pass with the probe left completely broken. TBROOTRANK=0 removes
the root ranking and leaves exactly one thing deciding the score — the in-search
probe. The position from the real game is additionally asserted under the SHIPPED
default config, as a guard that the two fixes stay independent.

One pinned POSITIVE control runs too, because "never claims a win" is also what you
get by deleting the probe. At a fresh clock the game position must still report a
tablebase-band score.

PART B — deep conversion (`--deep`)
-----------------------------------
6- and 7-man won roots from test/tb_positions_deep.epd, played out. White is zugzwang.
Black is zugzwang too while the board is above tablebase cardinality (there is no
oracle up there), and switches to tools/tbdefend — perfect DTZ defence — the moment
the position drops into the tables. A position passes only if:

  (a) White mates, and
  (b) the halfmove clock never reaches 100, and
  (c) the FIRST <=5-man White-to-move position reached is a genuine TB_WIN, i.e.
      Syzygy's clock-aware root WDL (dtz + rule50 <= 100) still says WIN — the win
      survived the simplification, and
  (d) at no <=5-man White-to-move node does an engine-reported tablebase-win score
      coexist with a Syzygy verdict of anything other than WIN. That is defect (1)
      stated as an invariant rather than as a single position.

Rules, legality and adjudication all come from the engine's own /move endpoint.

USAGE
-----
  ./test/tb_insearch.py                 # part A only (fast)
  ./test/tb_insearch.py --deep          # part A + part B
  ./test/tb_insearch.py --deep -v       # ... printing every ply

Starts its OWN `zugzwang serve` on free ports and kills them on exit, so it never
touches a dev instance on :6476. Exit code is nonzero if anything fails.
"""

import argparse
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from tb_conversion import ROOT, Serve, TbDefend, parse_epd, WDL_NAME, TB_WIN, ONGOING

# ---- zug's value scale (src/types.h:68-76) --------------------------------------
# VALUE_MATE 32000, MAX_PLY 246, VALUE_MATE_IN_MAX_PLY = VALUE_MATE - 256 = 31744,
# VALUE_TB_WIN = VALUE_MATE_IN_MAX_PLY - MAX_PLY - 1 = 31497. The in-search probe and
# the root ranking both report +-(VALUE_TB_WIN - ply), so ANY |cp| at or above
# VALUE_TB_WIN - MAX_PLY is the engine claiming a tablebase win or loss and nothing
# else: a real evaluation is three orders of magnitude below it (a queen is ~900).
VALUE_TB_WIN = 31497
MAX_PLY = 246
TB_BAND_MIN = VALUE_TB_WIN - MAX_PLY  # 31251

# Fathom WDL codes (src/syzygy/tbprobe.h:98-102), clock-aware when they come out of
# the ROOT probe, which is what tools/tbdefend runs.
TB_LOSS, TB_BLESSED_LOSS, TB_DRAW, TB_CURSED_WIN = 0, 1, 2, 3
FIFTY_MOVE_DRAW = (TB_BLESSED_LOSS, TB_CURSED_WIN)


def claims_forced_result(score):
    """Is this reported score the engine claiming a forced win or loss?

    Deliberately covers ALL THREE ways the engine can make the claim, and
    deliberately asserts on the engine's own claim rather than on the size of the
    number carrying it: a mate claim, a raw tablebase-band score, and an explicit
    `tb` tag are equally wrong about a position that is a 50-move draw.

    `tb` is how the JSON API states it since the wire format stopped printing raw
    VALUE_TB_WIN (src/serve_json.h): a verdict now arrives as a bounded cp plus the
    tag. The band check stays because the UCI path still reports raw, and because a
    raw value reaching the JSON boundary is itself a failure worth catching here.
    """
    if score is None:
        return False, "no score reported"
    kind, value, tb = score
    if tb is not None:
        return True, "tb %s (cp %d)" % (tb, value)
    if kind == "mate":
        return True, "mate %d" % value
    if abs(value) >= TB_BAND_MIN:
        return True, "cp %d (tablebase band, |v| >= %d)" % (value, TB_BAND_MIN)
    return False, "cp %d" % value


def with_clock(fen, halfmove):
    f = fen.split()
    f[4] = str(halfmove)
    return " ".join(f)


# ------------------------------------------------------------------ part A

# The position from the reported production game: KNPvKB, Black to move, halfmove
# clock 98. Black is dead lost with a fresh clock and dead DRAWN here, and the engine
# reported -314.95 for it. Kept verbatim and out of the generated set so the exact
# reported case is always in the gate even if the generator's inputs change.
GAME_FEN = "8/3k1KPb/8/8/8/5N2/8/8 b - - 98 106"


def build_cases(tb, source_epd, want):
    """Generate (label, drawn_fen, fresh_fen) triples, all verdicts from tbdefend.

    A case is kept only if Syzygy calls the fresh-clock position DECISIVE and the
    same position at clock 101-D a 50-move draw. Nothing is asserted about zug here —
    this is the oracle establishing what the truth is.
    """
    cases, seen = [], set()
    for fen, comment in parse_epd(source_epd):
        if len(cases) >= want:
            break
        fresh = with_clock(fen, 0)
        # The source EPD deliberately carries the same position at two different
        # clocks; both normalize to the same fresh-clock position here.
        if fresh in seen:
            continue
        seen.add(fresh)
        mv, wdl, dtz = tb.probe(fresh)
        if mv == "none" or wdl not in (TB_WIN, TB_LOSS) or dtz <= 0 or dtz > 100:
            continue
        drawn = with_clock(fen, 101 - dtz)
        _, wdl2, _ = tb.probe(drawn)
        if wdl2 not in FIFTY_MOVE_DRAW:
            continue
        cases.append((comment.split()[0] if comment else fen, drawn, fresh, dtz))
    return cases


def part_a(args, tb):
    """Returns a list of failure strings (empty == pass)."""
    fails = []

    def check(engine, label, fen, expect_forced):
        _mv, info, score = engine.bestmove_score(fen)
        forced, how = claims_forced_result(score)
        ok = (forced == expect_forced)
        print("  %-4s %-38s %-46s %s" % ("PASS" if ok else "FAIL", label, fen, how))
        if not ok:
            fails.append("%s: %s -> %s (expected %s a forced win/loss)"
                         % (label, fen, how, "" if expect_forced else "NOT"))

    # ---- the reported game position, both configurations ----------------------
    print("=== A. in-search WDL score gate ===")
    print("  the reported game position, SHIPPED default config:")
    shipped = Serve(args.root, args.movetime, quiet=not args.verbose)
    try:
        check(shipped, "game KNPvKB, clock 98 (DRAWN)", GAME_FEN, False)
    finally:
        shipped.stop()

    # TBROOTRANK=0 strips the root DTZ ranking, which is the only thing that would
    # otherwise switch the in-search probe off at a <=5-man root. What is left
    # deciding these scores is the in-search probe alone.
    print("  ... and with TBROOTRANK=0, which isolates the in-search probe:")
    iso = Serve(args.root, args.movetime, quiet=not args.verbose, env={"TBROOTRANK": "0"})
    try:
        check(iso, "game KNPvKB, clock 98 (DRAWN)", GAME_FEN, False)
        # Pinned positive control. "Never claims a win" is also what deleting the
        # probe buys, so one case must still claim one. This position reaches a
        # rule50==0 node through the g7 pawn push, which is why the probe can still
        # fire from a fresh-clock root here (a root whose only moves are quiet ones
        # legitimately has no rule50==0 descendant to probe until one zeroes).
        check(iso, "game KNPvKB, clock 0 (LOST for Black)", with_clock(GAME_FEN, 0), True)

        cases = build_cases(tb, args.positions, args.cases)
        if not cases:
            fails.append("generator produced no cases from %s" % args.positions)
        print("  generated 50-move-draw cases (clock = 101 - dtz, verdict from tbdefend):")
        for label, drawn, _fresh, dtz in cases:
            check(iso, "%s dtz=%d, clock=%d (DRAWN)" % (label, dtz, 101 - dtz), drawn, False)
    finally:
        iso.stop()
    return fails


# ------------------------------------------------------------------ part B

def play_deep(fen, serve, tb, cardinality, max_plies, verbose):
    """Play out one 6/7-man root. Returns (plies, max_r50, simplified_at) or raises."""
    from tb_conversion import Failure

    ply, simplified = 0, None
    max_r50 = int(fen.split()[4])

    while True:
        fields = fen.split()
        stm, rule50 = fields[1], int(fields[4])
        men = sum(1 for c in fields[0] if c.isalpha())
        max_r50 = max(max_r50, rule50)

        if rule50 >= 100:
            raise Failure("50-move draw", "halfmove clock hit %d at ply %d" % (rule50, ply))
        if ply >= max_plies:
            raise Failure("no mate", "still playing after %d plies (r50=%d)" % (ply, rule50))

        inTables = men <= cardinality
        wdl, dtz, tbBest = None, None, None
        if inTables:
            tbBest, wdl, dtz = tb.probe(fen)
            if tbBest == "none":
                raise Failure("probe failed", "tbdefend cannot probe %s" % fen)

        if stm == "w":
            played, info, score = serve.bestmove_score(fen)
            if inTables:
                # (d) the invariant: a Syzygy verdict of anything but WIN and an
                # engine-reported forced win for White must never coexist. This is
                # defect (1) written as a property of every node rather than of one
                # position. The score is from the side to move, which is White here, so
                # a POSITIVE forced claim is the one that contradicts a cursed/drawn
                # verdict — the engine reporting that it is itself lost does not.
                # A positive mate claim contradicts CURSED_WIN too: dtz counts to the
                # next zeroing move, which is never further away than mate, so a mate
                # that fits the halfmove clock would have made the verdict WIN.
                forced, how = claims_forced_result(score)
                if wdl != TB_WIN and forced and score[1] > 0:
                    raise Failure("phantom TB win",
                                  "Syzygy says %s at ply %d (r50=%d) but the engine reports %s"
                                  % (WDL_NAME[wdl], ply, rule50, how))
                # (c) the win must have SURVIVED the descent into the tables.
                if simplified is None:
                    simplified = ply
                    if wdl != TB_WIN:
                        raise Failure("win lost in simplification",
                                      "first <=%d-man node at ply %d is %s, not WIN (r50=%d)"
                                      % (cardinality, ply, WDL_NAME[wdl], rule50))
                elif wdl != TB_WIN:
                    raise Failure("win thrown away",
                                  "ply %d is %s, not WIN (r50=%d)" % (ply, WDL_NAME[wdl], rule50))
            tag = "zug   %-6s %-24s%s" % (played, info,
                                          "" if not inTables else "  tb=%s dtz=%d budget=%d/100"
                                          % (WDL_NAME[wdl], dtz, rule50 + dtz))
        elif inTables:
            # Perfect DTZ defence — the hardest 50-move-rule defence that exists.
            played = tbBest
            tag = "tbdef %-6s %-24s wdl=%s dtz=%d" % (played, "", WDL_NAME[wdl], dtz)
        else:
            # Above cardinality there is no oracle, so Black is the engine playing for
            # itself. It is not perfect defence, but it is a real one: it will avoid
            # simplifying into a lost ending whenever it has a choice.
            played, info, _ = serve.bestmove_score(fen)
            tag = "zugB  %-6s %-24s" % (played, info)

        r = serve.post("/move", {"fen": fen, "move": played})
        if not r.get("legal"):
            raise Failure("illegal move", "%s in %s" % (played, fen))
        fen = r["newFen"]
        ply += 1
        if verbose:
            print("   %3d %s -> %s" % (ply, tag, fen))

        status = r["status"]
        if status != ONGOING:
            # (a) only a White checkmate counts.
            if status == "checkmate" and r.get("result") == "1-0":
                return ply, max_r50, simplified
            raise Failure("no mate", "game ended '%s' (%s) at ply %d" % (status, r.get("result"), ply))


def part_b(args, tb, serve):
    from tb_conversion import Failure

    positions = parse_epd(args.deep_positions)
    print("\n=== B. deep conversion: %d 6/7-man roots, White=serve (%dms), "
          "Black=serve above %d men / tbdefend at or below ===\n"
          % (len(positions), args.movetime, args.cardinality))
    fails = []
    for fen, comment in positions:
        label = comment or fen
        if args.verbose:
            print("--- %s\n    %s" % (label, fen))
        try:
            plies, max_r50, simplified = play_deep(fen, serve, tb, args.cardinality,
                                                   args.max_plies, args.verbose)
            print("  PASS  %-52s mate in %3d plies, peak r50 %3d, into tables at ply %s"
                  % (label[:52], plies, max_r50, "-" if simplified is None else simplified))
        except Failure as f:
            fails.append("%s (%s): %s" % (label.split()[0], fen, f))
            print("  FAIL  %-52s %s" % (label[:52], f))
        sys.stdout.flush()
    return fails


# ------------------------------------------------------------------ main

def main():
    ap = argparse.ArgumentParser(description=__doc__.split("\n")[0])
    ap.add_argument("--deep", action="store_true", help="also run part B (slow)")
    ap.add_argument("--movetime", type=int, default=200, help="ms per engine move (default 200)")
    ap.add_argument("--max-plies", type=int, default=400, help="give up after this many plies")
    ap.add_argument("--cases", type=int, default=8, help="part A: how many generated cases")
    ap.add_argument("--cardinality", type=int, default=5, help="largest tablebase on disk")
    ap.add_argument("--positions", default=os.path.join(ROOT, "test", "tb_positions.epd"))
    ap.add_argument("--deep-positions", default=os.path.join(ROOT, "test", "tb_positions_deep.epd"))
    ap.add_argument("--syzygy", default="syzygy", help="Syzygy dir, cwd-relative to the engine root")
    ap.add_argument("--root", default=ROOT, help="zugzwang root (where ./zugzwang lives)")
    ap.add_argument("-v", "--verbose", action="store_true", help="print every ply")
    args = ap.parse_args()

    for need in (os.path.join(args.root, "zugzwang"), os.path.join(args.root, "tools", "tbdefend")):
        if not os.path.exists(need):
            sys.exit("missing %s — run `make && make tbdefend`" % need)

    tb = TbDefend(args.root, args.syzygy)
    fails = []
    try:
        fails += part_a(args, tb)
        if args.deep:
            serve = Serve(args.root, args.movetime, quiet=not args.verbose)
            try:
                fails += part_b(args, tb, serve)
            finally:
                serve.stop()
    finally:
        tb.stop()

    print("\n%s" % ("ALL PASS" if not fails else "%d FAILURE(S):" % len(fails)))
    for f in fails:
        print("  %s" % f)
    return 1 if fails else 0


if __name__ == "__main__":
    sys.exit(main())
