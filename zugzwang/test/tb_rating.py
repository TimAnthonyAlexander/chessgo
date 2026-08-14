#!/usr/bin/env python3
"""Does the WEAKENED bot ladder convert a won <=5-man ending, and does RATING matter?

WHY THIS EXISTS SEPARATELY FROM test/tb_conversion.py
-----------------------------------------------------
tb_conversion.py measures the FULL-STRENGTH path. Almost nothing on the site
plays at full strength: the /bot picker, hub matchmaking backfill, Watch
fillers, arena bots and UCI_Elo all go through `limits.rating`, i.e.
Rating::best_move_for_rating -> Rating::root_scores -> Weakening::pick. That
path had its own instance of the same bug and tb_conversion.py could not see it.

The mechanism (measured before the fix): root_scores builds Weakening's
candidate list from the REPORTED score, and on a DTZ-ranked root every certain
win reports the identical VALUE_TB_WIN. So `loss = bestScore - score` was 0 for
every winning move, the severity cap was a no-op, and the softmax sampled
UNIFORMLY across them at every rung of the ladder. Every rating played the same
dice roll; a 2800 bot converted no better than a 700 one.

WHAT THIS ASSERTS — AND WHAT IT DELIBERATELY DOES NOT
-----------------------------------------------------
A weak bot is SUPPOSED to play badly. The goal is not that a 700-rated bot
converts KBNvK by perfect DTZ; it is that the ladder is MEANINGFUL here, the
same way it already is in ordinary positions. So the gate is:

  (1) the top rung converts reliably           (--assert-top, default 0.85)
  (2) the curve is not flat                    (--assert-spread, default 0.30)
  (3) it rises with rating, monotone within a  (--assert-slack, default 0.20)
      slack that absorbs binomial noise

A flat curve fails (2) whether it is flat-at-0 or flat-at-1, which is exactly
the degenerate shape the bug produced.

METHOD
------
White is `zugzwang serve` /bestmove with `limits.rating` set — the same call the
website makes. Black is tools/tbdefend, Fathom's DTZ root probe playing the
DTZ-MAXIMIZING move: perfect 50-move-rule defence, the hardest that exists.
Rules and adjudication come from the engine's own /move endpoint. Selection is
randomized (Weakening::thread_rng is seeded from std::random_device), so every
game of a (position, rating) cell is an independent sample.

Conversion == checkmate delivered by White. A 50-move draw, a stalemate, an
insufficient-material draw or hitting the ply limit all count as not converted.

N AND CONFIDENCE
----------------
Default is 15 games x 8 positions = 120 games per rung, ~3.5 minutes for the
whole suite. At p=0.5 the binomial standard error is 4.6pp per rung, so the
gate's 30pp spread threshold is ~4.6 SE of a paired difference — a spread that
size cannot be sampling noise, which matters because "the curve is flat" is the
assertion this file exists to make. It is NOT enough to rank two rungs 10pp
apart, and it is not meant to be: read the SHAPE, not the individual cells.
--assert-slack exists for exactly that reason.

n=5 was tried first and rejected: at 7.9pp per rung, adjacent rungs inverted by
17pp on a curve that was genuinely monotone, i.e. the gate would have flaked. An
earlier one-position n=3 (24pp) could not distinguish anything at all.

USAGE
-----
  ./test/tb_rating.py                          # the gate
  ./test/tb_rating.py -n 10 -v                 # more samples, per-ply log
  ./test/tb_rating.py --ratings 700,1500,2800
"""

import argparse
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from tb_conversion import ONGOING, Serve, TbDefend, free_port  # noqa: E402

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))

# A spread of won <=5-man endings from test/tb_positions.epd: the reported
# production game at its real (tight) clock and at a fresh one, two tight-budget
# positions where a sloppy move really does throw the win, and four ordinary
# ones. Deliberately NOT all 24 — this suite plays hundreds of games, and the
# point is the shape of the rating curve, not per-position coverage (that is
# tb_conversion.py's job).
POSITIONS = [
    ("8/6Pb/5K2/4N3/4k3/8/8/8 w - - 71 93", "KNPvKB game position   budget=86/100"),
    ("8/6Pb/5K2/4N3/4k3/8/8/8 w - - 0 93",  "KNPvKB fresh clock     budget=15/100"),
    ("7k/8/8/1Q6/4K3/8/8/4r3 w - - 0 1",    "KQvKR                  budget=17/100"),
    ("1k6/8/6b1/2K5/2R5/8/8/8 w - - 0 1",   "KRvKB                  budget=12/100"),
    ("8/8/5P1k/2K5/5n2/8/6B1/8 w - - 0 1",  "KBPvKN                 budget=19/100"),
    ("3K4/8/8/8/5Q2/kn6/8/8 w - - 0 1",     "KQvKN                  budget=21/100"),
    ("k1N5/8/8/5K2/8/8/8/B7 w - - 0 1",     "KBNvK                  budget=48/100"),
    ("8/8/2kBN3/8/8/8/8/K7 w - - 34 60",    "KBNvK tight            budget=94/100"),
]

DEFAULT_RATINGS = [800, 1200, 1600, 2000, 2400, 2800]


def bestmove_rated(serve, fen, rating, movetime):
    """White's move from the website's own call shape: /bestmove + limits.rating.

    movetime is passed only when nonzero — Rating::resolve_budget treats an
    explicit movetime as a COST CAP on the weakened ranking, so passing one
    silently makes a high rung shallower than its rating asks for. The gate
    wants the rating alone to decide."""
    lim = {"rating": rating}
    if movetime:
        lim["movetime"] = movetime
    r = serve.post("/bestmove", {"fen": fen, "limits": lim})
    if not r.get("bestmove"):
        raise RuntimeError("serve /bestmove returned none: %s" % r.get("reason"))
    return r["bestmove"]


def play_rated(fen, serve, tb, rating, movetime, max_plies, verbose):
    """One game. -> (True, plies, peak_r50) on a White mate, else (False, why, peak)."""
    ply = 0
    peak = int(fen.split()[4])
    while True:
        fields = fen.split()
        stm, rule50 = fields[1], int(fields[4])
        peak = max(peak, rule50)
        if rule50 >= 100:
            return False, "50-move draw", peak
        if ply >= max_plies:
            return False, "no mate in %d plies" % max_plies, peak

        if stm == "w":
            played = bestmove_rated(serve, fen, rating, movetime)
        else:
            played, _wdl, _dtz = tb.probe(fen)
            if played == "none":
                raise RuntimeError("tbdefend cannot probe %s" % fen)

        r = serve.post("/move", {"fen": fen, "move": played})
        if not r.get("legal"):
            raise RuntimeError("illegal move %s in %s" % (played, fen))
        fen = r["newFen"]
        ply += 1
        if verbose:
            print("      %3d %-5s %-6s %s" % (ply, stm, played, fen))
        status = r["status"]
        if status != ONGOING:
            if status == "checkmate" and r.get("result") == "1-0":
                return True, ply, peak
            return False, "%s (%s)" % (status, r.get("result")), peak


def main():
    ap = argparse.ArgumentParser(description=__doc__.split("\n")[0])
    ap.add_argument("-n", "--games", type=int, default=15,
                    help="games per (position, rating) cell (default 15 -> 120 per rung)")
    ap.add_argument("--ratings", default=",".join(str(r) for r in DEFAULT_RATINGS))
    ap.add_argument("--movetime", type=int, default=0,
                    help="cost cap in ms for White's ranking pass (0 = none, the default)")
    ap.add_argument("--max-plies", type=int, default=300)
    ap.add_argument("--syzygy", default="syzygy")
    ap.add_argument("--root", default=ROOT)
    ap.add_argument("--assert-top", type=float, default=0.85,
                    help="minimum conversion rate for the strongest rung")
    ap.add_argument("--assert-spread", type=float, default=0.30,
                    help="minimum (top rung - bottom rung) conversion rate")
    ap.add_argument("--assert-slack", type=float, default=0.20,
                    help="how far a rung may fall below the one beneath it (binomial noise)")
    ap.add_argument("--no-assert", action="store_true", help="measure only, always exit 0")
    ap.add_argument("-v", "--verbose", action="store_true")
    args = ap.parse_args()

    for need in (os.path.join(args.root, "zugzwang"), os.path.join(args.root, "tools", "tbdefend")):
        if not os.path.exists(need):
            sys.exit("missing %s — run `make && make tbdefend`" % need)

    ratings = [int(x) for x in args.ratings.split(",") if x.strip()]
    total = len(ratings) * len(POSITIONS) * args.games
    print("=== TB conversion BY RATING: White=/bestmove+limits.rating, Black=tbdefend (perfect DTZ) ===")
    print("    %d ratings x %d positions x %d games = %d games\n" %
          (len(ratings), len(POSITIONS), args.games, total))

    serve = Serve(args.root, 0, quiet=not args.verbose)
    tb = TbDefend(args.root, args.syzygy)
    # rate[rating] = [wins, games]; cell[(rating, pos)] = wins
    rate = {r: [0, 0] for r in ratings}
    cell = {}
    why = {}  # rating -> {reason: count}, so a failing curve names its own draw mechanism
    try:
        for pi, (fen, label) in enumerate(POSITIONS):
            for rating in ratings:
                wins, plies, lost = 0, [], []
                for _ in range(args.games):
                    ok, detail, _peak = play_rated(fen, serve, tb, rating, args.movetime,
                                                   args.max_plies, args.verbose)
                    if ok:
                        wins += 1
                        plies.append(detail)
                    else:
                        lost.append(detail)
                        why.setdefault(rating, {})
                        why[rating][detail] = why[rating].get(detail, 0) + 1
                rate[rating][0] += wins
                rate[rating][1] += args.games
                cell[(rating, pi)] = wins
                print("  %-38s r%-5d %d/%d  %s" %
                      (label, rating, wins, args.games,
                       ("mate in %s plies" % ",".join(str(p) for p in plies) if plies else "") +
                       ("  | " + ", ".join(sorted(set(lost))) if lost else "")))
                sys.stdout.flush()
            print()
    finally:
        tb.stop()
        serve.stop()

    print("=== conversion by rating (%d games per rung) ===" % (len(POSITIONS) * args.games))
    hdr = "  %-10s" % "position"
    for r in ratings:
        hdr += "%7d" % r
    print(hdr)
    for pi, (_fen, label) in enumerate(POSITIONS):
        row = "  %-10s" % label.split()[0][:10]
        for r in ratings:
            row += "%7s" % ("%d/%d" % (cell[(r, pi)], args.games))
        print(row)
    row = "  %-10s" % "ALL"
    for r in ratings:
        w, g = rate[r]
        row += "%7s" % ("%.2f" % (w / g))
    print(row)

    print("\n=== how the un-converted games ended ===")
    for r in ratings:
        d = why.get(r, {})
        print("  r%-5d %s" % (r, ", ".join("%s x%d" % (k, v) for k, v in sorted(d.items())) or "-"))

    pct = [rate[r][0] / rate[r][1] for r in ratings]
    n = len(POSITIONS) * args.games
    se = (0.25 / n) ** 0.5
    print("\n  binomial SE at p=0.5 with n=%d: %.3f (+-%.1fpp)" % (n, se, se * 100))

    if args.no_assert:
        return 0

    fails = []
    if pct[-1] < args.assert_top:
        fails.append("top rung %d converted %.2f, below --assert-top %.2f"
                     % (ratings[-1], pct[-1], args.assert_top))
    spread = pct[-1] - pct[0]
    if spread < args.assert_spread:
        fails.append("spread %.2f (r%d %.2f -> r%d %.2f) below --assert-spread %.2f — "
                     "a FLAT ladder is the bug this gate exists for"
                     % (spread, ratings[0], pct[0], ratings[-1], pct[-1], args.assert_spread))
    for i in range(1, len(ratings)):
        if pct[i] < pct[i - 1] - args.assert_slack:
            fails.append("r%d (%.2f) is more than %.2f below r%d (%.2f) — ladder inverted"
                         % (ratings[i], pct[i], args.assert_slack, ratings[i - 1], pct[i - 1]))

    if fails:
        print("\nFAIL")
        for f in fails:
            print("  %s" % f)
        return 1
    print("\nPASS  top %.2f, spread %.2f, monotone within %.2f"
          % (pct[-1], spread, args.assert_slack))
    return 0


if __name__ == "__main__":
    sys.exit(main())
