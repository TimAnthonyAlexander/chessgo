# nnue_spsa — retrain-free SPSA tuning of the NNUE output surface

Standalone tool (pure Python 3, stdlib only — no numpy) that reads/writes
zugzwang's `.nnue` file directly and exposes the small **output-side** tail
layers as a flat, SPSA-tunable parameter vector, à la Stockfish's SFNNv9
"no-retrain" output-layer tune. It does NOT touch the feature transformer or
the two tail weight *matrices* — see `nnue_io.py`'s module docstring for the
full byte-layout writeup and the exact rationale for what's excluded.

## Files

- `nnue_io.py` — the reader/writer. `NNUEFile.load(path)`, `.save(path)`,
  `.get_surface_vector()`, `.with_surface_delta(delta)`,
  `.surface_param_names()`. Run directly (`python3 nnue_io.py net.nnue`) to
  print the section table and surface param count.
- `roundtrip_test.py` — the correctness gate. `python3 roundtrip_test.py
  net.nnue` must print `ROUNDTRIP: PASS` and `PERTURB: PASS`. If either
  fails, the byte-layout parse is wrong — do not use the tool until this
  passes on your net.

## The 648-param output surface

Fixed order (see `SURFACE_SECTIONS` in `nnue_io.py`):

| section | source array | count | what it is |
|---|---|---|---|
| `l1b` | `L1B` | 128 | tail-L1 biases, bucket-major `[bk*D2+o]` (NB=8 buckets × D2=16) |
| `l2b` | `L2B` | 256 | tail-L2 biases `[bk*D3+o]` (NB=8 × D3=32) |
| `l3w` | `OW`  | 256 | output weights, input-major `[i*NB+bk]` (D3=32 × NB=8) |
| `l3b` | `OB`  | 8   | output biases `[bk]` (NB=8) |

Total: 128 + 256 + 256 + 8 = **648**.

All 4 arrays are stored as **plain float32 on disk with no requantization on
load** (`nnue_net.cpp` "straight copy" comments) — perturbing them is a
direct float add, no dequant/requant math needed, and no clamping is
required by the format itself.

## Running an SPSA loop (games run on coalla, NOT here)

This tool only edits files; it never plays games. The loop:

1. **Baseline.** `base = NNUEFile.load("net.nnue")`; `theta = base.get_surface_vector()`
   (648 floats — this is `theta_0`, the current shipped net's output surface).

2. **Per-iteration antithetic pair** (standard SPSA):
   - Sample a Bernoulli ±1 perturbation vector `Delta` (648 entries, each
     independently +1 or -1 with prob 0.5).
   - Pick a per-parameter step size `c_k` (see sizing below) and form
     `theta_plus = theta + c_k * Delta`, `theta_minus = theta - c_k * Delta`.
   - `base.with_surface_vector(theta_plus).save("candidate_plus.nnue")` and
     the same for `theta_minus` → two candidate `.nnue` files, both
     byte-identical to `net.nnue` outside the 648-float surface.

3. **Play games (on coalla, separately — not part of this tool).** The
   engine has no `EvalFile`-style UCI option — it always loads `net.nnue`
   from its cwd (`NNUE::load("net.nnue")` in `src/uci.cpp`, hardcoded). So,
   mirroring `../../spsa/tune.py`'s existing `dir=` convention (it runs two
   `fastchess` engine instances with different `dir=` per side, feeding
   different UCI options): stage two working directories, each holding a
   copy/symlink of `./zugzwang` plus its own `net.nnue`:
     - `workdir_plus/net.nnue`  = `candidate_plus.nnue`
     - `workdir_minus/net.nnue` = `candidate_minus.nnue`
   Then run a short fastchess match with `-engine cmd=./zugzwang name=plus
   dir=workdir_plus` vs `-engine cmd=./zugzwang name=minus dir=workdir_minus`
   (same `book.epd`, `st=0.1`, concurrency as `tune.py`'s `run_batch`).
   Record the score differential `y_plus - y_minus` (e.g. game score, or
   `(wins - losses)/games`) exactly like `tune.py`'s `run_batch` does.

4. **Gradient estimate + update** (textbook SPSA):
   `ghat = (y_plus - y_minus) / (2 * c_k) * (1 / Delta)` elementwise
   (since `Delta_i` is ±1, `1/Delta_i == Delta_i`), then
   `theta = theta + a_k * ghat`, with `a_k`, `c_k` decaying per the standard
   `a_k = a / (k+1+A)^alpha`, `c_k = c / (k+1)^gamma` schedule (same shape as
   the existing margin-SPSA harness in `../../spsa/` — reuse its `a`, `A`,
   `alpha`, `gamma` conventions rather than inventing new ones, so the two
   harnesses read the same way).

5. **Persist + iterate.** `base.with_surface_vector(theta).save("net_spsa_iter_k.nnue")`
   each round (or just keep `theta` in memory/JSON between rounds — the
   `.nnue` file only needs to be materialized when a candidate must be
   played). After N iterations, promote the final `theta` net through the
   normal movetime-SPRT gate before shipping (per project convention —
   SPSA `score` is noise-dominated per iteration; judge by theta settling
   over the run, not by any single iteration's game score).

### Sizing the perturbation step `c`

Reasonable starting point, since all 4 surface arrays are already
dequantized floats operating directly in the net's own units:

- `l3b` / `l1b` / `l2b` (biases): these feed forward through ReLU-ish tail
  activations before the `CpScale=400` final descale — start with
  `c ~ 0.01–0.05` (roughly 1-2% of typical bias magnitude; inspect
  `net.get_surface_vector()`'s actual value range for your net before
  picking a number — do not guess blind).
- `l3w` (output weights): these directly scale `L2` activations into the
  final raw score before `CpScale`; start smaller, `c ~ 0.005–0.02`, since
  a weight perturbation compounds across every position instead of adding a
  constant.
- Halve `c` if early rounds show `theta` diverging or games at
  `theta ± c*Delta` blundering (finite-eval sanity: reload the candidate
  net in `./zugzwang` UCI mode and confirm `info depth ... score cp <finite>`
  before spending game budget on it — cheap smoke test, no coalla needed).

### Sanity-check a candidate before spending game budget

```sh
cd /path/to/zugzwang_workdir   # a dir containing ONLY the candidate net
ln -sf /path/to/candidate_plus.nnue net.nnue
printf 'uci\nisready\nposition startpos\ngo movetime 100\nquit\n' | /path/to/zugzwang
# expect: "NNUE: loaded net.nnue" on stderr, and finite "score cp N" lines
```

## Regenerating the layout doc

If `src/nnue_arch.h` or `src/nnue_net.cpp`'s section order/quantization ever
changes, re-derive `nnue_io.py`'s constants from that file first (it is the
single source of truth for the on-disk layout), then re-run
`roundtrip_test.py` — a byte-layout drift will show up immediately as a
`ROUNDTRIP: FAIL`.
