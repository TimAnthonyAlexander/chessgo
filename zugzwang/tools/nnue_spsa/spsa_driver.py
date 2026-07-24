#!/usr/bin/env python3
"""
spsa_driver.py — long-running, unattended SPSA tuner for zugzwang's NNUE
output surface (648 params: l1b, l2b, l3w, l3b — see nnue_io.py).

Standard (Spall) SPSA, maximizing plus-net's win rate against minus-net,
same conceptual shape as ../../spsa/tune.py (search-margin SPSA) but tuning
NNUE FLOAT params living inside net.nnue itself (no UCI option involved), so
each iteration writes two whole candidate .nnue files and plays them against
each other via fastchess, mirroring tune.py's `dir=` per-side-net convention
(here: TWO dirs, each with its own candidate net.nnue, since the engine has
no EvalFile option and always loads "net.nnue" from its cwd).

THE UPDATE RULE (exact, elementwise, 648-dim vectors):

  theta_plus  = theta + c_k * Delta
  theta_minus = theta - c_k * Delta
    Delta_i in {-1, +1} i.i.d. Bernoulli (antithetic pair, same Delta for +/-)

  Play theta_plus vs theta_minus (fastchess match). A single head-to-head
  match is zero-sum, so its differential score IS (s_plus - s_minus):
    score = (points_plus - points_minus) / games   in [-1, 1]
    s_plus := score, s_minus := -score  (explicit, for readability — these
    are not independently measured, they're definitionally opposite in a
    2-engine match, exactly like tune.py's `run_batch` return value)

  ghat_k[i] = (s_plus - s_minus) / (2 * c_k[i]) * (1 / Delta_i)
            = score / c_k[i] * Delta_i          (1/Delta_i == Delta_i, +-1)

  theta[i] += a_k[i] * ghat_k[i]                 (MAXIMIZE win rate)

  c_k[i] = c_end[i] / k**GAMMA        (per-parameter probe size, decaying)
  a_k[i] = a_end[i] / (A + k)**ALPHA  (per-parameter gain, decaying)
  GAMMA = 0.101, ALPHA = 0.602 (Spall defaults). A = 0.1 * total_iters.

See the "HYPERPARAMETERS" section below for how c_end[i]/a_end[i] are chosen
per-parameter from the base net's own measured magnitudes — that is the
main thing to retune if a real run behaves badly.

MOCK MODE (--mock): replaces the fastchess match with a synthetic objective
(negative squared distance, in per-parameter c_end-normalized units, from a
random target theta_star) so the whole loop/IO/checkpoint/resume/snapshot
machinery can be validated on a laptop with zero games played. Same exact
a_k/c_k schedule runs in both modes — only `play_batch()` differs.

Resumable: writes <scratch>/state.json after every iteration ({k, theta,
theta_0, rng_state, best, mock state if any}); --resume continues from it
(atomic tmp+rename, same as tune.py, so a kill mid-write never corrupts it).
Snapshots a full candidate .nnue every --snapshot-every iterations (default
10) into <scratch>/snapshots/, named by iteration, so mid-run nets can be
SPRT'd without waiting for the full run to finish (SF-style: ship snapshots,
don't wait for "done").

Logs one line per iteration to --log-file (tail -f friendly, same convention
as tune.py's ~/spsa_zug.log).

Usage (coalla, full run):
    python3 tools/nnue_spsa/spsa_driver.py --iters 3000 --wall-hours 7 \\
        --scratch-dir ~/nnue_spsa_run1 --snapshot-every 10

    # resume after a crash/kill (same --iters, same --scratch-dir):
    python3 tools/nnue_spsa/spsa_driver.py --iters 3000 --wall-hours 7 \\
        --scratch-dir ~/nnue_spsa_run1 --resume

Usage (Mac, mechanics validation, no games played):
    python3 tools/nnue_spsa/spsa_driver.py --mock --iters 50 \\
        --base-net /path/to/kb-mirror.bin --scratch-dir /tmp/nnue_spsa_mock
"""
from __future__ import annotations

import argparse
import json
import math
import os
import random
import re
import statistics
import subprocess
import sys
import time

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import nnue_io  # noqa: E402

# ---------------------------------------------------------------------------
# Coalla defaults (override via argv or env; mirrors ../../spsa/tune.py's
# ZUGZWANG_DIR / ZUGZWANG_ENGINE / FASTCHESS_BIN convention).
# ---------------------------------------------------------------------------
ZDIR = os.environ.get("ZUGZWANG_DIR", "/home/tim/chessgo/zugzwang")
DEFAULT_ENGINE = os.environ.get("ZUGZWANG_ENGINE", os.path.join(ZDIR, "zugzwang"))
DEFAULT_FASTCHESS = os.environ.get(
    "FASTCHESS_BIN", os.path.expanduser("~/fastchess/fastchess-linux-x86-64/fastchess")
)
DEFAULT_BASE_NET = os.environ.get(
    "NNUE_BASE_NET", os.path.expanduser("~/chessgo/gomachine/data/nnue/kb-mirror.bin")
)
DEFAULT_BOOK = os.environ.get("NNUE_SPSA_BOOK", os.path.join(ZDIR, "book.epd"))
DEFAULT_SCRATCH = os.environ.get("NNUE_SPSA_SCRATCH", os.path.join(ZDIR, "spsa_nnue"))
DEFAULT_LOG = os.environ.get("NNUE_SPSA_LOG", os.path.expanduser("~/spsa_nnue.log"))

ALPHA = 0.602
GAMMA = 0.101

RESULT_RE = re.compile(
    r"Games:\s*(\d+),\s*Wins:\s*(\d+),\s*Losses:\s*(\d+),\s*Draws:\s*(\d+),\s*Points:\s*([\d.]+)"
)


# ---------------------------------------------------------------------------
# Hyperparameter sizing from the base net's own measured magnitudes.
#
#   c_end[i] = C_FRAC * std(section containing i)
#     C_FRAC_BIAS  = 0.04  for l1b, l2b, l3b (bias-like sections)
#     C_FRAC_WEIGHT = 0.015 for l3w (output weights — README's guidance:
#       weights compound across every position, so probe smaller than biases)
#   a_end[i] = STEP_FRAC * c_end[i]**2
#     STEP_FRAC = 0.3
#
# Why a_end ~ c_end**2, not c_end: a[i] must be chosen INDEPENDENTLY of the
# 1/c_k[i] division baked into ghat (dividing by a per-param probe size is
# what makes the estimator correctly scaled per parameter in the first
# place). If a_end[i] were instead proportional to c_end[i] (as it would be
# if we mimicked tune.py's simplified update, which omits the c_k division
# entirely), the c_end[i] terms cancel algebraically and every parameter
# gets an IDENTICAL absolute update regardless of its own natural scale —
# defeating the point of a per-parameter probe size. Squaring keeps the
# *first-iteration, score=+-1* update magnitude equal to STEP_FRAC*c_end[i]
# (i.e. "at most STEP_FRAC of one probe-width per iteration, if the batch
# were a wipeout") and any real update scales down from there by the
# observed |score| (usually 0.1-0.3 for a 40-game batch).
# ---------------------------------------------------------------------------
C_FRAC_BIAS = 0.04
C_FRAC_WEIGHT = 0.015
STEP_FRAC = 0.3
MIN_STD_FLOOR = 1e-6


def compute_param_scales(base_net: "nnue_io.NNUEFile", c_frac_bias: float, c_frac_weight: float):
    """Per-parameter (c_end, a_end) arrays + a stats dict for reporting,
    built from the ACTUAL base net's section magnitudes (not guessed)."""
    c_end = [0.0] * nnue_io.SURFACE_PARAM_COUNT
    stats = {}
    offset = 0
    for name, count in nnue_io.SURFACE_SECTIONS:
        vals = list(base_net.sections[name])
        std = statistics.pstdev(vals) if len(vals) > 1 else abs(vals[0])
        std = max(std, MIN_STD_FLOOR)
        frac = c_frac_weight if name == "l3w" else c_frac_bias
        cval = max(frac * std, MIN_STD_FLOOR)
        for i in range(count):
            c_end[offset + i] = cval
        stats[name] = {
            "count": count,
            "min": min(vals),
            "max": max(vals),
            "mean": statistics.mean(vals),
            "std": std,
            "c_frac": frac,
            "c_end": cval,
        }
        offset += count
    a_end = [STEP_FRAC * c * c for c in c_end]
    return c_end, a_end, stats


def print_param_stats(stats: dict) -> None:
    print("[spsa] base-net output-surface magnitudes (per section):")
    for name, count in nnue_io.SURFACE_SECTIONS:
        s = stats[name]
        print(
            f"  {name:5s} n={s['count']:4d}  min={s['min']:+.5f}  max={s['max']:+.5f}  "
            f"mean={s['mean']:+.5f}  std={s['std']:.5f}  ->  c_end={s['c_end']:.6f} "
            f"(c_frac={s['c_frac']})"
        )


# ---------------------------------------------------------------------------
# State / checkpoint (atomic tmp+rename, same pattern as tune.py).
# ---------------------------------------------------------------------------
def rng_state_to_json(state):
    version, internal_state, gauss_next = state
    return {"version": version, "internal_state": list(internal_state), "gauss_next": gauss_next}


def rng_state_from_json(obj):
    return (obj["version"], tuple(obj["internal_state"]), obj["gauss_next"])


def load_checkpoint(path):
    if not os.path.exists(path):
        return None
    with open(path) as f:
        return json.load(f)


def save_checkpoint(path, data):
    os.makedirs(os.path.dirname(os.path.abspath(path)) or ".", exist_ok=True)
    tmp = path + ".tmp"
    with open(tmp, "w") as f:
        json.dump(data, f)
    os.replace(tmp, path)


def save_snapshot(base_net, theta, snapshot_dir, k):
    os.makedirs(snapshot_dir, exist_ok=True)
    out = base_net.with_surface_vector(theta)
    path = os.path.join(snapshot_dir, f"iter_{k:06d}.nnue")
    out.save(path)
    return path


# ---------------------------------------------------------------------------
# Real objective: fastchess plus-net vs minus-net.
# ---------------------------------------------------------------------------
def play_batch_real(args, base_net, theta_plus, theta_minus):
    net_plus = base_net.with_surface_vector(theta_plus)
    net_minus = base_net.with_surface_vector(theta_minus)
    os.makedirs(args.dir_plus, exist_ok=True)
    os.makedirs(args.dir_minus, exist_ok=True)
    net_plus.save(os.path.join(args.dir_plus, "net.nnue"))
    net_minus.save(os.path.join(args.dir_minus, "net.nnue"))

    rounds = max(1, (args.games_per_iter + 1) // 2)  # -games 2 * rounds >= games_per_iter
    cmd = [
        args.fastchess,
        "-engine", f"cmd={args.engine}", "name=plus", f"dir={args.dir_plus}",
        "-engine", f"cmd={args.engine}", "name=minus", f"dir={args.dir_minus}",
        "-each", f"st={args.st}", "timemargin=1000", "option.Hash=64",
        "-rounds", str(rounds), "-games", "2", "-repeat",
        "-concurrency", str(args.concurrency),
        "-openings", f"file={args.book}", "format=epd", "order=random",
    ]
    proc = subprocess.run(cmd, capture_output=True, text=True, timeout=args.batch_timeout)
    output = proc.stdout + "\n" + proc.stderr
    m = RESULT_RE.search(output)
    if not m:
        raise RuntimeError(f"fastchess parse failure (rc={proc.returncode}):\n{output[-3000:]}")
    games = int(m.group(1))
    points_plus = float(m.group(5))
    if games <= 0:
        raise RuntimeError(f"fastchess reported 0 games:\n{output[-3000:]}")
    score = (2.0 * points_plus - games) / games
    return score, games


def play_batch_with_retry(fn, *fn_args, **fn_kwargs):
    """Retry once on any failure (non-zero exit, empty/unparseable output,
    timeout); else return (None, 0) so the caller can skip the iteration
    (no theta update, but k still advances and gets checkpointed)."""
    last_err = None
    for attempt in (1, 2):
        try:
            return fn(*fn_args, **fn_kwargs)
        except Exception as e:  # noqa: BLE001 — deliberately broad, this is the robustness gate
            last_err = e
            print(f"[spsa] batch attempt {attempt} failed: {e}", file=sys.stderr)
    print(f"[spsa] both attempts failed, skipping this iteration: {last_err}", file=sys.stderr)
    return None, 0


# ---------------------------------------------------------------------------
# Mock objective: negative squared distance (in per-param c_end units) from
# a random target theta_star. Validates the loop/IO/checkpoint mechanics
# with zero games played. Same a_k/c_k schedule as the real run.
# ---------------------------------------------------------------------------
MOCK_SCALE = 0.02  # tanh squash factor on the raw objective difference


def mock_negf(theta, theta_star, c_end):
    return -sum(((t - s) / c) ** 2 for t, s, c in zip(theta, theta_star, c_end))


def play_batch_mock(theta_plus, theta_minus, theta_star, c_end, rng, noise_std, games_per_iter):
    fd = mock_negf(theta_plus, theta_star, c_end) - mock_negf(theta_minus, theta_star, c_end)
    raw = math.tanh(fd * MOCK_SCALE)
    noisy = raw + rng.gauss(0.0, noise_std)
    score = max(-1.0, min(1.0, noisy))
    return score, games_per_iter


# ---------------------------------------------------------------------------
# Misc helpers
# ---------------------------------------------------------------------------
def l2norm(vec):
    return math.sqrt(sum(x * x for x in vec))


def clamp_drift(theta, theta_0, c_end, max_drift_mult):
    """Safety rail for an 8-hour unattended run: never let a param wander
    more than max_drift_mult probe-widths from its starting value. Set
    --max-drift-mult 0 to disable. This does not fight normal SPSA movement
    (probe widths are tiny; max_drift_mult defaults to 25x, generous) — it
    only stops true runaway divergence from a pathological noise streak."""
    if max_drift_mult <= 0:
        return theta
    out = list(theta)
    for i in range(len(out)):
        lo = theta_0[i] - max_drift_mult * c_end[i]
        hi = theta_0[i] + max_drift_mult * c_end[i]
        if out[i] < lo:
            out[i] = lo
        elif out[i] > hi:
            out[i] = hi
    return out


# ---------------------------------------------------------------------------
# Main
# ---------------------------------------------------------------------------
def build_argparser():
    ap = argparse.ArgumentParser(
        description="SPSA tuner for zugzwang's 648-param NNUE output surface",
        formatter_class=argparse.RawDescriptionHelpFormatter,
    )
    ap.add_argument("--iters", type=int, required=True,
                     help="total planned iterations (fixes the a/c decay schedule via A=0.1*iters; "
                          "pass the SAME value across --resume runs)")
    ap.add_argument("--resume", action="store_true", help="resume from <scratch-dir>/state.json")

    ap.add_argument("--base-net", default=DEFAULT_BASE_NET,
                     help=f"path to the base .nnue net to tune (default: {DEFAULT_BASE_NET})")
    ap.add_argument("--engine", default=DEFAULT_ENGINE,
                     help=f"absolute path to the zugzwang binary (default: {DEFAULT_ENGINE})")
    ap.add_argument("--fastchess", default=DEFAULT_FASTCHESS,
                     help=f"absolute path to the fastchess binary (default: {DEFAULT_FASTCHESS})")
    ap.add_argument("--book", default=DEFAULT_BOOK,
                     help=f"opening book EPD (default: {DEFAULT_BOOK})")
    ap.add_argument("--scratch-dir", default=DEFAULT_SCRATCH,
                     help=f"scratch dir for candidates/checkpoint/snapshots — REAL net.nnue is "
                          f"NEVER written to (default: {DEFAULT_SCRATCH})")
    ap.add_argument("--log-file", default=DEFAULT_LOG, help=f"append-only log (default: {DEFAULT_LOG})")
    ap.add_argument("--snapshot-every", type=int, default=10,
                     help="write a full candidate .nnue snapshot every N iterations (default: 10)")

    ap.add_argument("--rounds", type=int, default=20, help="fastchess -rounds per iteration (default: 20)")
    ap.add_argument("--games", type=int, default=2, help="fastchess -games per round (default: 2)")
    ap.add_argument("--concurrency", type=int, default=6, help="fastchess -concurrency (default: 6)")
    ap.add_argument("--st", default="0.1", help="fastchess -each st= movetime seconds (default: 0.1)")
    ap.add_argument("--batch-timeout", type=float, default=600.0,
                     help="subprocess timeout (seconds) for one fastchess batch (default: 600)")

    ap.add_argument("--c-frac-bias", type=float, default=C_FRAC_BIAS,
                     help=f"probe size as a fraction of each bias section's std (default: {C_FRAC_BIAS})")
    ap.add_argument("--c-frac-weight", type=float, default=C_FRAC_WEIGHT,
                     help=f"probe size as a fraction of l3w's std (default: {C_FRAC_WEIGHT})")
    ap.add_argument("--step-frac", type=float, default=STEP_FRAC,
                     help=f"a_end[i] = step_frac * c_end[i]**2 (default: {STEP_FRAC})")
    ap.add_argument("--max-drift-mult", type=float, default=25.0,
                     help="safety clamp: max |theta-theta_0| in probe-widths (c_end units); "
                          "0 disables (default: 25)")

    ap.add_argument("--wall-hours", type=float, default=None,
                     help="stop cleanly (final checkpoint+snapshot) after this many wall-clock hours")

    ap.add_argument("--mock", action="store_true",
                     help="validate mechanics with a synthetic objective; NO games are played")
    ap.add_argument("--mock-noise-std", type=float, default=0.15,
                     help="gaussian noise added to the mock score, simulating game-batch noise (default: 0.15)")
    ap.add_argument("--mock-target-sigma", type=float, default=3.0,
                     help="mock theta_star offset from theta_0, in probe-widths per param (default: 3.0)")
    ap.add_argument("--mock-games-per-iter", type=int, default=40,
                     help="fake 'games' value logged in mock mode, for log-format parity (default: 40)")

    ap.add_argument("--seed", type=int, default=None, help="RNG seed (fresh runs only; default: random)")
    ap.add_argument("--die-after-iter", type=int, default=None,
                     help="TESTING ONLY: hard-exit right after checkpointing this iteration, "
                          "to deterministically validate --resume without a wall-clock race")
    return ap


def main():
    args = build_argparser().parse_args()
    if args.iters < 1:
        sys.exit("--iters must be >= 1")

    args.games_per_iter = args.rounds * args.games
    args.dir_plus = os.path.join(args.scratch_dir, "dir_plus")
    args.dir_minus = os.path.join(args.scratch_dir, "dir_minus")
    args.snapshot_dir = os.path.join(args.scratch_dir, "snapshots")
    checkpoint_path = os.path.join(args.scratch_dir, "state.json")

    os.makedirs(args.scratch_dir, exist_ok=True)

    if not args.mock:
        for p, label in [(args.base_net, "--base-net"), (args.engine, "--engine"),
                          (args.fastchess, "--fastchess"), (args.book, "--book")]:
            if not os.path.exists(p):
                sys.exit(f"error: {label} path does not exist: {p}")

    print(f"[spsa] loading base net: {args.base_net}")
    base_net = nnue_io.NNUEFile.load(args.base_net)
    theta_0 = base_net.get_surface_vector()
    assert len(theta_0) == nnue_io.SURFACE_PARAM_COUNT

    c_end, a_end, stats = compute_param_scales(base_net, args.c_frac_bias, args.c_frac_weight)
    print_param_stats(stats)

    if os.path.exists(checkpoint_path) and not args.resume:
        sys.exit(
            f"error: {checkpoint_path} already exists — pass --resume to continue it, "
            f"or remove/pick a different --scratch-dir to start fresh"
        )

    rng = random.Random(args.seed) if args.seed is not None else random.Random()
    theta = list(theta_0)
    start_k = 1
    best = {"k": 0, "score": float("-inf"), "theta": list(theta_0), "side": "none"}
    mock_theta_star = None
    wall_seconds_prior = 0.0

    if args.resume:
        ck = load_checkpoint(checkpoint_path)
        if ck is None:
            print(f"[spsa] --resume given but {checkpoint_path} not found; starting fresh", file=sys.stderr)
        else:
            start_k = ck["k"] + 1
            theta = list(ck["theta"])
            theta_0 = list(ck["theta_0"])  # keep the ORIGINAL baseline, not a re-derived one
            rng.setstate(rng_state_from_json(ck["rng_state"]))
            best = ck["best"]
            wall_seconds_prior = ck.get("wall_seconds", 0.0)
            if ck.get("mock") is not None:
                mock_theta_star = ck["mock"]["theta_star"]
            print(f"[spsa] resumed from k={ck['k']} -> starting at k={start_k} "
                  f"(prior wall time {wall_seconds_prior/3600:.2f}h)", file=sys.stderr)

    if args.mock and mock_theta_star is None:
        mock_theta_star = [
            theta_0[i] + rng.gauss(0.0, args.mock_target_sigma * c_end[i])
            for i in range(len(theta_0))
        ]

    if start_k > args.iters:
        print(f"[spsa] already complete: k={start_k - 1} >= --iters {args.iters}", file=sys.stderr)
        return

    A = 0.1 * args.iters
    t_start = time.time()

    with open(args.log_file, "a") as logf:
        header = (
            f"=== spsa_driver run start {time.strftime('%Y-%m-%d %H:%M:%S')} | "
            f"iters={args.iters} start_k={start_k} mock={args.mock} "
            f"games/iter={args.games_per_iter if not args.mock else args.mock_games_per_iter} "
            f"A={A:.2f} alpha={ALPHA} gamma={GAMMA} step_frac={args.step_frac} "
            f"c_frac_bias={args.c_frac_bias} c_frac_weight={args.c_frac_weight} ==="
        )
        print(header)
        logf.write(header + "\n")
        logf.flush()

        for k in range(start_k, args.iters + 1):
            c_k = [c_end[i] / (k ** GAMMA) for i in range(len(theta))]
            a_k = [a_end[i] / ((A + k) ** ALPHA) for i in range(len(theta))]
            delta = [rng.choice((-1, 1)) for _ in range(len(theta))]

            theta_plus = [theta[i] + c_k[i] * delta[i] for i in range(len(theta))]
            theta_minus = [theta[i] - c_k[i] * delta[i] for i in range(len(theta))]

            t0 = time.time()
            if args.mock:
                score, games = play_batch_mock(
                    theta_plus, theta_minus, mock_theta_star, c_end, rng,
                    args.mock_noise_std, args.mock_games_per_iter,
                )
            else:
                score, games = play_batch_with_retry(
                    play_batch_real, args, base_net, theta_plus, theta_minus
                )
            dt = time.time() - t0
            skipped = games == 0

            if not skipped:
                ghat = [score / c_k[i] * delta[i] for i in range(len(theta))]
                theta = [theta[i] + a_k[i] * ghat[i] for i in range(len(theta))]
                theta = clamp_drift(theta, theta_0, c_end, args.max_drift_mult)
                gnorm = l2norm(ghat)

                # Running "best single candidate" — a coarse proxy (one noisy
                # batch's differential, NOT a real evaluation of theta itself;
                # SPSA never directly measures the current theta's absolute
                # strength, only pairwise theta+/theta- differentials, same
                # caveat as tune.py's log-reading header comment).
                if score >= best["score"]:
                    best = {"k": k, "score": score, "theta": list(theta_plus), "side": "plus"}
                if -score >= best["score"]:
                    best = {"k": k, "score": -score, "theta": list(theta_minus), "side": "minus"}
            else:
                ghat = None
                gnorm = float("nan")

            drift = l2norm([theta[i] - theta_0[i] for i in range(len(theta))])
            wall_seconds = wall_seconds_prior + (time.time() - t_start)

            c_bias_repr = c_end[0] / (k ** GAMMA)  # representative: any bias index shares the k-decay
            c_weight_repr = stats["l3w"]["c_end"] / (k ** GAMMA)
            a_bias_repr = stats["l1b"]["c_end"] ** 2 * args.step_frac / ((A + k) ** ALPHA)
            a_weight_repr = stats["l3w"]["c_end"] ** 2 * args.step_frac / ((A + k) ** ALPHA)

            s_plus = score if not skipped else float("nan")
            s_minus = -score if not skipped else float("nan")
            line = (
                f"iter {k}/{args.iters} | {'SKIPPED' if skipped else 'ok'} | "
                f"c_k[bias/weight]={c_bias_repr:.6f}/{c_weight_repr:.6f} "
                f"a_k[bias/weight]={a_bias_repr:.3e}/{a_weight_repr:.3e} | "
                f"s_plus={s_plus:+.3f} s_minus={s_minus:+.3f} games={games} dt={dt:.1f}s | "
                f"|ghat|={gnorm:.4f} drift={drift:.5f} | wall={wall_seconds/3600:.3f}h"
            )
            print(line)
            logf.write(line + "\n")
            logf.flush()

            ck_data = {
                "k": k,
                "theta": theta,
                "theta_0": theta_0,
                "rng_state": rng_state_to_json(rng.getstate()),
                "best": best,
                "wall_seconds": wall_seconds,
                "args": {
                    "iters": args.iters, "c_frac_bias": args.c_frac_bias,
                    "c_frac_weight": args.c_frac_weight, "step_frac": args.step_frac,
                    "rounds": args.rounds, "games": args.games,
                },
            }
            if args.mock:
                ck_data["mock"] = {
                    "theta_star": mock_theta_star,
                    "noise_std": args.mock_noise_std,
                }
            save_checkpoint(checkpoint_path, ck_data)

            if k % args.snapshot_every == 0 or k == args.iters:
                snap_path = save_snapshot(base_net, theta, args.snapshot_dir, k)
                snap_line = f"[spsa] snapshot written: {snap_path}"
                print(snap_line)
                logf.write(snap_line + "\n")
                logf.flush()

            if args.die_after_iter is not None and k == args.die_after_iter:
                logf.write(f"[spsa] --die-after-iter {k} hit — hard exit (testing)\n")
                logf.flush()
                os._exit(7)  # noqa: SLF001 — deliberate hard exit, bypasses cleanup, simulates a crash

            if args.wall_hours is not None and wall_seconds / 3600.0 >= args.wall_hours:
                stop_line = f"[spsa] wall-hours budget ({args.wall_hours}h) reached at iter {k} — stopping cleanly"
                print(stop_line)
                logf.write(stop_line + "\n")
                logf.flush()
                break

        else:
            done_line = f"[spsa] done: k={args.iters} iterations complete"
            print(done_line)
            logf.write(done_line + "\n")
            logf.flush()

    print(f"[spsa] final checkpoint: {checkpoint_path}")
    print(f"[spsa] final theta snapshot dir: {args.snapshot_dir}")


if __name__ == "__main__":
    main()
