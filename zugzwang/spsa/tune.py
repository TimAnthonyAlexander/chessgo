#!/usr/bin/env python3
"""
SPSA tuning driver for Zugzwang's 8 search-margin UCI options, via fastchess
self-play (paired theta+ / theta- games each iteration).

Standard (Spall) SPSA, maximizing engine-1's (theta+'s) win rate against
engine-2 (theta-). See docs comment blocks below for the exact update rule.

Resumable: writes spsa/state.json after every iteration ({k, theta, rng_state});
--resume continues from it, so a killed run loses at most one in-flight batch.
Logs one line per iteration to ~/spsa_zug.log (tail -f friendly, same convention
as the SPRT harness's ~/sprt_<name>.log).

READING THE LOG (do not misread the `score` column):
  The per-iter `score` = (2*points_plus - games)/games from an 8-GAME match between
  theta+ and theta-. It is ~95% NOISE (8-game score std ~= 0.25; the signal from the
  small perturbation between theta+/theta- is ~0.01), so it oscillates around ~0 for
  the ENTIRE run, iter 1 -> iter N. A near-0 score is NOT a convergence/midpoint
  signal and NEVER was (it's ~0 from iter 1); a score of exactly 0.000 is just a tied
  8-game batch and zeroes that iter's theta update. Convergence = the `theta:` values
  settling + aF/cF decaying toward their end values. The score also says NOTHING about
  the eventual Elo gain -- only the confirmation SPRT does.

Usage:
    python3 spsa/tune.py --iters 20000 --batch 8
    python3 spsa/tune.py --iters 20000 --batch 8 --resume
"""
import argparse
import json
import os
import random
import re
import subprocess
import sys
import time

# ---------------------------------------------------------------------------
# Paths (coalla defaults; override via env for local/other-host testing).
# ---------------------------------------------------------------------------
ZDIR = os.environ.get("ZUGZWANG_DIR", "/home/tim/chessgo/zugzwang")
ENGINE = os.environ.get("ZUGZWANG_ENGINE", "./zugzwang")
FASTCHESS = os.environ.get(
    "FASTCHESS_BIN", os.path.expanduser("~/fastchess/fastchess-linux-x86-64/fastchess")
)
BOOK = os.path.join(ZDIR, "book.epd")
STATE_FILE = os.path.join(ZDIR, "spsa", "state.json")
LOG_FILE = os.environ.get("SPSA_LOG", os.path.expanduser("~/spsa_zug.log"))

# ---------------------------------------------------------------------------
# Param config: (uci name, start = current default, min, max, c_end).
# c_end is the end-of-run perturbation size, ~(max-min)/20 rounded; these are
# the values handed off by the task, tuned by feel to the margin's practical
# scale (e.g. SingularMargin's effective step is /16, so its c_end is small).
# ---------------------------------------------------------------------------
# Selectable param sets (SPSA_SET env picks one; default "capthist"):
#   "capthist" — focused tune of the capture-history read weight only (2026-07-15).
#   "margins"  — the stale-margin re-tune (docs/tasks/open/spsa-margin-polish.md).
CAPTHIST_PARAMS = [
    # name             start min  max  c_end
    # CaptHistWeight is the capture-history read weight /256 (128 = the half-weight we
    # SPRT'd as a modest win). Focused single-param tune to find its true optimum.
    ("CaptHistWeight", 128,  16, 512,  25),
]
MARGIN_PARAMS = [
    # name              start min  max  c_end
    # start = accepted-base value. FutBase (base 0) and CaptSeeCoeff (base 23) are EXCLUDED:
    # their base values sit below the UCI option min (40) and the engine clamps setoption to
    # [min,max], so SPSA could not test the true base for them. They stay pinned at base defaults.
    ("RfpMargin",         75,  40, 130,   5),
    ("RazorMargin",      200, 100, 350,  12),
    ("FutSlope",         100,  40, 150,   6),
    ("SeeQuietCoeff",     25,  10,  45,   2),
    ("NmpEvalDiv",       200,  80, 400,  16),
    ("SingularMargin",    32,  16,  80,   3),
]
LMRCLUSTER_PARAMS = [
    # name              start   min     max    c_end     (SPSA_SET=lmrcluster)
    # The co-tuned LMR fine-term cluster (rootDeltaLmr+allNodeLmr+corrMargin) + extension/LMR
    # constants, exposed 2026-07-16. Run with ZUGZWANG_ENGINE=./cand_lmrcluster.sh so both arms
    # have LMRCLUSTER=1 (the terms active) while SPSA drives the constants. Bundle SPRT at these
    # defaults was +3.9 ±8.7 (positive basin where each term washes solo) — SPSA optimizes upward.
    # LmrBase/LmrDiv are the reduction-table double x LMR_DOUBLE_SCALE (10000).
    ("RootDeltaCoeff",   608,   200,   1200,    50),
    ("CorrMarginDiv",  30370, 10000, 100000,  4500),
    ("AllNodeDiv",         1,     1,      6,     1),
    ("DblExtMargin",      64,    20,    130,     6),
    ("LmrBase",         7844,  3000,  15000,   600),
    ("LmrDiv",         24696, 15000,  40000,  1250),
]
HISTMARGIN_PARAMS = [
    # name              start   min    max    c_end     (SPSA_SET=histmargin)
    # Co-tune HISTMARGIN's own constants WITH the futility/SEE margins it feeds. Run with
    # ZUGZWANG_ENGINE=./cand_histmargin.sh so BOTH arms have HISTMARGIN=1 (the lever active)
    # while SPSA drives the constants. HISTMARGIN-on solo washed ~-3.6; this tests whether
    # co-tuning the interacting margins recovers it into a positive basin (the "works in
    # combination" hypothesis). Confirm the tuned theta vs HISTMARGIN-OFF base with an SPRT.
    ("HistPruneCoeff", 8000, 2000, 40000, 2000),
    ("HistMarginDiv",  8000, 2000, 40000, 2000),
    ("RfpMargin",        75,   40,   130,    5),
    ("FutSlope",        100,   40,   150,    6),
    ("SeeQuietCoeff",    25,   10,    45,    2),
]
NEWPARAMS = [
    # name             start    min     max    c_end     (SPSA_SET=newparams, 2026-07-21)
    # Tune the 3 newly-SHIPPED-but-untuned lever params (all now default-on): LMPHIST's div,
    # RFPTTHIT's coeff, SINGCORRMARGIN's div. These are live in the base engine, so no wrap
    # needed. Confirm tuned theta vs current base defaults with an SPRT before baking.
    ("LmpHistDiv",    4000,   1000,  12000,   700),
    ("RfpTtHitCoeff",   23,      5,     50,     4),
    ("SingCorrDiv", 230673,  80000, 500000, 30000),
]
MARGINS2_PARAMS = [
    # name              start min  max  c_end     (SPSA_SET=margins2, 2026-08-15)
    #
    # RESULT: RAN AND REJECTED — do not re-run this as-is expecting a different answer.
    # 4000 iterations completed; final theta was
    #   RfpMargin=86 RazorMargin=327 FutSlope=108 SeeQuietCoeff=17
    #   NmpEvalDiv=172 SingularMargin=43 FutBase=101 CaptSeeCoeff=7
    # Confirmation SPRT of that vector vs the defaults below, same binary both sides,
    # 100ms, full 1600 games: -3.47 +/- 8.93, LLR -0.61. Not an improvement.
    #
    # Read it as "this tune did not find a better basin", NOT as "the current vector is
    # jointly optimal" — 8 games per iteration is noise-dominated and SPSA can miss. What
    # it does retire is the specific hypothesis that unpinning FutBase/CaptSeeCoeff was
    # leaving Elo on the table: both were free to move (FutBase ran 0->101, CaptSeeCoeff
    # 23->7) and the result still did not beat base. Mid-run wander was large on
    # SingularMargin (35->18->43) and NmpEvalDiv (120->91->172), which suggests the
    # objective is flat in those directions rather than that those endpoints mean much.
    # MARGIN_PARAMS re-run from the CURRENT accepted defaults, with the two margins it had
    # to leave out put back. Its exclusion note ("their base values sit below the UCI option
    # min (40)") is STALE: the engine now reports `FutBase min 0` and `CaptSeeCoeff min 0`,
    # so the clamp that blocked them is gone and they have sat pinned at their defaults
    # through every joint tune since for no remaining reason.
    #
    # The point of re-running is joint-vs-solo, not a fresh start: each of these is
    # individually at a value that won or held its own SPRT, which does NOT make the vector
    # jointly optimal — one-at-a-time optimisation settles on a ridge where every single
    # step is downhill and a correlated one is not. Evidence it matters is already in this
    # file: see lmrcluster ("positive basin where each term washes solo") and histmargin's
    # "works in combination" hypothesis. A direct check of the same idea — RfpMargin 84->60
    # alone — measured -5.9 +/- 9.5 over 1238 games, i.e. the axis is locally downhill,
    # which says nothing about the joint optimum.
    ("RfpMargin",         84,  40, 130,   5),
    ("RazorMargin",      222, 100, 350,  12),
    ("FutSlope",         107,  40, 150,   6),
    ("SeeQuietCoeff",     17,  10,  45,   2),
    ("NmpEvalDiv",       120,  80, 400,  16),
    ("SingularMargin",    35,  16,  80,   3),
    ("FutBase",            0,   0, 220,  11),   # newly unblocked
    ("CaptSeeCoeff",      23,   0, 180,   9),   # newly unblocked
]
_SPSA_SET = os.environ.get("SPSA_SET", "capthist")
PARAMS = {"margins": MARGIN_PARAMS, "lmrcluster": LMRCLUSTER_PARAMS,
          "histmargin": HISTMARGIN_PARAMS, "newparams": NEWPARAMS,
          "margins2": MARGINS2_PARAMS}.get(_SPSA_SET, CAPTHIST_PARAMS)
NAMES = [p[0] for p in PARAMS]
START = {p[0]: float(p[1]) for p in PARAMS}
LO = {p[0]: p[2] for p in PARAMS}
HI = {p[0]: p[3] for p in PARAMS}
CEND = {p[0]: p[4] for p in PARAMS}

# ---------------------------------------------------------------------------
# SPSA hyperparameters (Spall's standard choices).
# ---------------------------------------------------------------------------
ALPHA = 0.602
GAMMA = 0.101


def clamp(v, lo, hi):
    return max(lo, min(hi, v))


def rng_state_to_json(state):
    """random.getstate() -> (version, 625-int internal tuple, gauss_next);
    JSON has no tuple type, so unpack to plain lists/scalars explicitly
    (round-tripped by rng_state_from_json)."""
    version, internal_state, gauss_next = state
    return {"version": version, "internal_state": list(internal_state), "gauss_next": gauss_next}


def rng_state_from_json(obj):
    return (obj["version"], tuple(obj["internal_state"]), obj["gauss_next"])


def load_state():
    if not os.path.exists(STATE_FILE):
        return None
    with open(STATE_FILE) as f:
        return json.load(f)


def save_state(k, theta, rng):
    os.makedirs(os.path.dirname(STATE_FILE), exist_ok=True)
    data = {"k": k, "theta": theta, "rng_state": rng_state_to_json(rng.getstate())}
    tmp = STATE_FILE + ".tmp"
    with open(tmp, "w") as f:
        json.dump(data, f, indent=2)
    os.replace(tmp, STATE_FILE)  # atomic — a kill mid-write never corrupts state.json


# ---------------------------------------------------------------------------
# fastchess: play a paired batch, theta+ as engine 1 ("plus"), theta- as
# engine 2 ("minus"). Same book/movetime/concurrency as our SPRT harness
# (sprt.sh) — st=0.1 (100ms/move), timemargin=1000, Hash=64, book.epd random.
# ---------------------------------------------------------------------------
RESULT_RE = re.compile(
    r"Games:\s*(\d+),\s*Wins:\s*(\d+),\s*Losses:\s*(\d+),\s*Draws:\s*(\d+),\s*Points:\s*([\d.]+)"
)


def engine_args(name, theta):
    args = ["-engine", f"cmd={ENGINE}", f"name={name}", f"dir={ZDIR}"]
    for n in NAMES:
        args.append(f"option.{n}={int(theta[n])}")
    return args


def run_batch(theta_plus, theta_minus, batch):
    rounds = max(1, (batch + 1) // 2)  # -games 2 * rounds >= batch
    cmd = [FASTCHESS]
    cmd += engine_args("plus", theta_plus)
    cmd += engine_args("minus", theta_minus)
    cmd += ["-each", "st=0.1", "timemargin=1000", "option.Hash=64"]
    cmd += ["-openings", f"file={BOOK}", "format=epd", "order=random"]
    cmd += ["-rounds", str(rounds), "-games", "2", "-repeat", "-concurrency", "8"]

    proc = subprocess.run(cmd, cwd=ZDIR, capture_output=True, text=True)
    output = proc.stdout + "\n" + proc.stderr
    m = RESULT_RE.search(output)
    if not m:
        raise RuntimeError(
            f"could not parse fastchess result (rc={proc.returncode}):\n" + output[-3000:]
        )
    games = int(m.group(1))
    points_plus = float(m.group(5))
    if games <= 0:
        raise RuntimeError("fastchess reported 0 games:\n" + output[-3000:])
    # score in [-1, 1]: (points_plus - points_minus) / games, points_minus = games - points_plus
    score = (2.0 * points_plus - games) / games
    return score, games


# ---------------------------------------------------------------------------
# SPSA loop
# ---------------------------------------------------------------------------
def main():
    ap = argparse.ArgumentParser(description="SPSA tuner for Zugzwang search margins")
    ap.add_argument("--iters", type=int, required=True, help="total planned iterations (fixes the a/c decay schedule; pass the SAME value across --resume runs)")
    ap.add_argument("--batch", type=int, default=8, help="games per iteration (theta+ vs theta-)")
    ap.add_argument("--resume", action="store_true", help="resume from spsa/state.json")
    args = ap.parse_args()

    total_iters = args.iters
    if total_iters < 1:
        sys.exit("--iters must be >= 1")

    if os.path.exists(STATE_FILE) and not args.resume:
        sys.exit(
            f"error: {STATE_FILE} already exists — pass --resume to continue it, "
            f"or remove it to start a fresh run"
        )

    # A = 0.1 * total_iters (Spall's standard choice: ~10% of the run length).
    A = 0.1 * total_iters
    # Per-param gain a_i, chosen so the FIRST step (k=1) has magnitude c_end_i —
    # i.e. a_k(i) = a_i / (A+k)^alpha, and at k=1: a_1(i) = a_i / (A+1)^alpha.
    # Setting a_i = c_end_i * (A+1)^alpha makes a_1(i) == c_end_i exactly, a
    # "sensible first step ~ c_end magnitude" per the task's guidance, then
    # decaying as k grows like the standard SPSA gain schedule.
    a = {n: CEND[n] * (A + 1) ** ALPHA for n in NAMES}

    rng = random.Random()
    theta = dict(START)
    start_k = 1

    if args.resume:
        st = load_state()
        if st is None:
            print(f"[spsa] --resume given but {STATE_FILE} not found; starting fresh", file=sys.stderr)
        else:
            start_k = st["k"] + 1
            theta = {n: float(st["theta"][n]) for n in NAMES}
            rng.setstate(rng_state_from_json(st["rng_state"]))
            print(f"[spsa] resumed from k={st['k']} -> starting at k={start_k}", file=sys.stderr)

    if start_k > total_iters:
        print(f"[spsa] already complete: k={start_k - 1} >= --iters {total_iters}", file=sys.stderr)
        return

    with open(LOG_FILE, "a") as logf:
        header = f"=== spsa run start {time.strftime('%Y-%m-%d %H:%M:%S')} | iters={total_iters} batch={args.batch} start_k={start_k} ==="
        print(header)
        logf.write(header + "\n")
        logf.flush()

        for k in range(start_k, total_iters + 1):
            a_k = {n: a[n] / (A + k) ** ALPHA for n in NAMES}
            c_k = {n: CEND[n] / (k ** GAMMA) for n in NAMES}
            delta = {n: rng.choice([-1, 1]) for n in NAMES}

            theta_plus = {}
            theta_minus = {}
            for n in NAMES:
                tp = round_clamp(theta[n] + c_k[n] * delta[n], LO[n], HI[n])
                tm = round_clamp(theta[n] - c_k[n] * delta[n], LO[n], HI[n])
                theta_plus[n] = tp
                theta_minus[n] = tm

            t0 = time.time()
            score, games = run_batch(theta_plus, theta_minus, args.batch)
            dt = time.time() - t0

            # Update: maximize theta+'s win rate. If theta+_i = theta_i + c_k*delta_i
            # and it scored better (score>0), nudge theta_i toward theta+_i, i.e. in
            # the direction of delta_i — theta_i += a_k*score*delta_i does exactly
            # that (and the symmetric case for delta_i=-1 nudges the other way).
            for n in NAMES:
                theta[n] = clamp(theta[n] + a_k[n] * score * delta[n], LO[n], HI[n])

            save_state(k, theta, rng)

            theta_str = " ".join(f"{n}={round(theta[n])}" for n in NAMES)
            a_factor = ((A + 1) / (A + k)) ** ALPHA  # shared decay multiplier on every a_i
            c_factor = 1.0 / (k ** GAMMA)            # shared decay multiplier on every c_end_i
            line = (
                f"iter {k}/{total_iters} | score {score:+.3f} | games={games} dt={dt:.1f}s "
                f"| theta: {theta_str} | aF={a_factor:.4f} cF={c_factor:.4f}"
            )
            print(line)
            logf.write(line + "\n")
            logf.flush()

    print(f"[spsa] done: k={total_iters}, final theta written to {STATE_FILE}")


def round_clamp(v, lo, hi):
    return int(clamp(round(v), lo, hi))


if __name__ == "__main__":
    main()
