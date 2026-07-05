# Periodic long-TC (≈1000ms) validation sweep

**Status:** open — recurring, milestone-triggered (not started)
**Owner:** engine
**Created:** 2026-07-05

## The idea

Our SPRT **ship gate is 100ms/move** — nearly every shipped figure is "@ 100ms/move",
and that's deliberate: fast games = many pairs/hour = tight CIs cheaply, and ~100ms is
close to the blitz regime the bots/hub actually play at. Keep that as the primary gate.

**But some patches are time-control dependent** (they flip sign with the depth regime):
depth-scaled terms (LMR base/divisor, RFP/futility margins, null-move R), and per-node-cost
features whose tree benefit only cashes out at depth. So **every once in a while, run a
targeted sweep at ~1000ms** (≈10× the clock, a genuinely different depth regime) to catch:
1. **Rejects that were flat/negative at 100ms but win at long TC** — free Elo we'd otherwise
   never find.
2. **Shipped features that are 100ms-only crutches** — anything that *decays* at depth (like
   the KingProx aggression knob: +43 @ d8 → −44 @ movetime) shouldn't stay default-on if it
   hurts at the TC we get ranked at.

**Why it matters:** CCRL — the leaderboard we want — runs at a much slower TC than 100ms
(Blitz CCRL ≈ 2min+1s/move). We have **never validated at that TC.** 1000ms is a cheap proxy
that will catch most sign-flips; the real thing is the CCRL TC itself.

## What to sweep (targeted — NOT the whole flag space)

1000ms games are ~10× slower → 10× fewer pairs/hour for the same CI, so keep it to the suspects:

### a) The reject pile (candidates to *flip positive* at long TC)
Flat/marginal-or-negative at 100ms, but plausible long-TC wins (per-node cost pays off deeper,
or a prune that's too aggressive at blitz is fine when you'd search it anyway):
`probcut`, `razor`, `iircutnode` (or reworked PV-only IIR), `capthist` (scaled), `conthist2`,
`corrhistminor`, `corrhistcont`, `futhist`, `lmphist`, `lmralpha`, `doubleext`.
(Skip the clearly-broken-even-at-fixed-nodes ones like `lmrimproving` −20.7 [fixed].)

### b) Shipped-stack re-check (confirm nothing is a 100ms-only crutch)
Run `new-defaults vs a known older baseline` at 1000ms; if still clearly positive, the stack is
TC-robust. Spot-check the depth-decay-risk shipped features individually (`--old "feat=off"`):
the LMR terms, RFP/futility, null-move, singular.

### c) SPSA at long TC (the bigger lever — separate, later)
The pruning/reduction *constants* are where TC-sensitivity really lives. The highest-value slow
run isn't flipping flags, it's an eventual **SPSA at ~1000ms (or the real CCRL TC)** on:
LMR base/divisor, history bonus/malus/max, RFP/futility margins, null-move R, singular margin/depth.
See the SPSA target set in the search-efficiency plan.

## How to run (coalla `sweep.sh`, `MOVETIME` env flips the clock)

```sh
# a) reject-pile long-TC sweep (overnight / when coalla is idle)
MOVETIME=1000 K=8 PAIRS=100 SUMMARY=~/sweep_longtc_rejects.txt \
  bash ~/sweep.sh "probcut=on" "razor=on" "iircutnode=on" "capthist=on" \
                  "conthist2=on" "futhist=on" "lmphist=on" "lmralpha=on"

# b) shipped-stack re-check at long TC (new defaults vs the pre-stack baseline)
MOVETIME=1000 K=8 PAIRS=100 SUMMARY=~/sweep_longtc_stack.txt \
  bash ~/sweep.sh "" # define --old baseline per the current shipped-stack A/B in the session notes
```

- `sweep.sh` already sets `TC="--nodes 0 --movetime $MOVETIME"` when `MOVETIME` is set (the
  `--nodes 0` is **mandatory** — movetime is silently ignored otherwise; the corrhist-contamination
  scar).
- Uses the v12 net + prod config (`--lean-int8ft --lean-moveaware`) already.
- Budget: at 1000ms a K=8×PAIRS=100 spec is ~10× the 100ms wall-clock — run few specs, overnight.

## Acceptance / what "done" means for one run

- Any reject that clears an honest movetime SPRT at 1000ms (H1, or a clean trend-accept with
  CI lower-bound > 0) → promote to a **100ms re-test**; if it's TC-specific (wins @1000, loses
  @100) note it and decide per our target TC. Ship only what helps at the TC we care about.
- Shipped-stack re-check positive → stack is TC-robust, record it. Negative on any feature →
  investigate that feature's depth decay.

## Cadence

Milestone-triggered, not calendar:
- After a batch of 100ms winners lands (re-check the new stack at 1000ms).
- **Always right before a CCRL re-anchor** — so the published number is measured under conditions
  the constants were at least *checked* at.

## Related

- `docs/ENGINE_STRENGTH.md` §14.4 (fixed-nodes vs movetime rulers), §27 (time-odds), §28 (re-anchor).
- The SPRT harness: coalla `~/sweep.sh`; `docs/ENGINE_STRENGTH.md` (bench SPRT), the `coalla-sprt-workflow` notes.
