# NNUE Post-Full-Threats Roadmap — Closing the SF Gap

> **Created:** 2026-07-11 · **Owner:** engine · **Status:** OPEN (Phase 1 is next)
> Companion docs: `threats-richness-build.md` (the port), `DATA_RECIPE_SF_2026.md`
> (SF data recipe), `ARCH_DIRECTION.md`, `PLAN.md`, `ENGINE_STRENGTH.md §34` (data lever).
> This doc supersedes the ad-hoc "what next after threats" notes.

## 0. TL;DR — the ordered program

**Data → richer base → dual net (+ small net) → threat PSQT skip → 1024 width.**

Each step is a full retrain → SPRT (FN + MT) + Abitur vs the current prod net →
**keep only if it clears a movetime SPRT.** Do them in this order; the reasons are
in §4 (dependencies + ROI + risk). If we only ever do two: **data + dual net.**

---

## 1. Where we are — the ordeal so far

We ported Stockfish 18's **Full Threats** feature set (our coarse **9,216** threat
block → SF's rich **79,856** from→to edge geometry), trained `chessgo_threats_sf_640`
(640 superbatches, test80-2024 Jan–Apr, ply≥28, ConstantWDL 0.6, LR warmup, int16
threat FT), and **deployed it to prod 2026-07-11**.

**Measured vs the previous prod net (`efs28`/`kb-mirror`), 100 ms, AVX-512 (coalla):**

| Test | Result | Draws |
|---|---:|---:|
| FN (fixed 200k nodes, 250g) | ft_final **+11 ± 20** | 78% |
| MT (100 ms, **1000g**) | ft_final **+9 ± 12** | 66% |
| Anchor (100 ms, 100g) | ft_final **+13 ± 36** | 72% |

A real but **modest ~+10 Elo win**, very drawish. Shipped. The question this doc
answers: *SF made threats load-bearing (they shrank the trunk 3072→1024 for them) —
why did our rich port gain so little, and how do we get the rest?*

---

## 2. Why only +10 — diagnosis (grounded in the SF18 source at `~/sf18-arm`)

**Reason 1 — We measured coarse→rich, not off→rich; the load-bearing Elo was already banked.**
Our previous net already carried a 9,216-dim coarse threat block (attacker-class ×
victim-type × victim-square) — that already encodes the load-bearing facts (hanging
pieces, capture availability, who-attacks-whom). Proof: the factoriser's **V1
victim-marginal *is literally the old coarse feature*** (`chessgo_ml_threats_sf.rs:89`).
The rich 79,856 scheme adds exactly one axis on top — the attacker's **from-square**
(the from→to edge). And SF's famous 3072→1024 cut happened *off→threats*, because
precomputed threats let the trunk stop re-deriving attacks (freeing ~2× width). **We
never paid that re-derivation cost** — our old net already had threats — so coarse→rich
frees nothing and buys only the geometry residual. +10 for that is the right order of
magnitude, not a broken port.

**Reason 2 — The fine per-edge geometry is data-starved; the folded net leans on the coarse marginals.**
73,276 valid edges (a queen alone spans ~17k columns) on *test80 Jan–Apr, single
source* — most edges barely get a gradient. We *needed* the V1+V2+V3 factoriser to
train it at all (`chessgo_ml_threats_sf.rs:546-567`), which means each exported edge ≈
V1(coarse) + V2(attacker-square prior) + V3(pair const) + a small **starved residual** —
and that residual *is* the genuinely-new geometry. The training pathology confirms it:
the run kept collapsing to the mean and needed LR warmup because **the shared coarse
virtuals dominate the early gradient** — the optimizer itself says the signal lives in
the marginals, not the fine edges. See `[[nnue-smoke-bpsb6104]]`.

**Reason 3 — The arch gap vs SF's threats net (three compounding factors).**
- **512 trunk vs SF's 1024** (`nnue_architecture.h:43`). Fine geometry needs accumulator
  capacity to survive the FT bottleneck; at 512 the extra edges average onto directions
  the coarse block already occupies.
- **Single net vs SF's dual.** SF gates threats **only onto the big net**
  (`nnue_feature_transformer.h:84`), running a cheap threatless small net on lopsided
  nodes. We apply the expensive threat block to *every* node, diluting the benefit.
- **Weaker base.** HalfKAv2_hm is **22,528** (32 king-buckets); ours is **12,288** (16).
  Less substrate for threats to correlate against.

> The three levers that unlock more (data, dual-net routing, 1024 width) are precisely
> the three ways our arch differs from SF's *threats* net — and they are strongest
> **combined** (dual-net makes width affordable; data makes both worth training).

---

## 3. The program

### Phase 1 — Data pipeline: a dedicated interleaved multi-source loader  **[DO FIRST]**

The foundation SF has and we don't, our named biggest lever (`ENGINE_STRENGTH §34`,
`[[data-pipeline-biggest-lever]]`), and — uniquely — it **re-judges the rich threats we
just built for almost free**: Reason 2 says the fine geometry is data-starved, so more
*unique* data is what finally trains those 73k edge residuals. The first thing this buys
is "were the rich threats under-sold?" — a cheap re-measurement of existing work — and
everything downstream trains and measures more honestly on it.

**What "proper" means here:**
- **Interleaved multi-source.** Not one binpack at a time — a loader that *interleaves*
  multiple sources per batch (T78 / T79 / T80 + more test80 months, later syzygy-rescored
  sets). Mixing sources per batch also **decorrelates batches**, which directly attacks
  the single-source correlation that caused our mean-collapse / shuffle-fragility
  (`[[nnue-smoke-bpsb6104]]`) — a proper interleave is a more principled fix than leaning
  on LR warmup alone.
- **More unique positions, not more epochs.** See §5 — superbatch count scales with
  dataset *size*, not clock time.
- **Recipe levers** (`DATA_RECIPE_SF_2026.md`): early-fen-skip (already ply≥28), lambda /
  WDL anneal (the deferred single-variable run), syzygy-rescore of the labels.

*Effort:* high (loader + data acquisition/rescore infra). *Risk:* low (data almost always
helps, and this feature set needs it more than any net we've trained). *Gate:* retrain the
**current** arch on the new pipeline → SPRT vs prod; this also tells us the rich-threats
data-starvation size.

### Phase 2 — Richer base: 16 → 32 king-buckets

Cheap, low-risk, and it's literally moving toward SF's HalfKAv2_hm (32 buckets,
`half_ka_v2_hm.h:73-88`). A stronger substrate for threats to correlate against, and it
composes with everything after. Do it *before* the big structural bets so the dual net
gets built on the better base (not retrofitted). *Effort:* medium. *Risk:* low-medium.
*Gate:* SPRT vs the Phase-1 net.

### Phase 3 — Dual net  **[the keystone]**

SF's defining move (`nnue_feature_transformer.h:84,241-254,383-393`): a **big net with
threats** on balanced/critical nodes, a **small threatless net** on lopsided nodes,
routed by position balance. It attacks two reasons at once — it *concentrates* the threat
block where geometry pays (killing the single-net dilution of Reason 3), and by running a
cheap net on lopsided nodes it **makes a bigger/richer threat net movetime-affordable**,
which is the wall every richer net has hit for us. Everything expensive downstream (width)
only becomes safe once this exists. *Effort:* high (two nets, routing gate, two accumulator
stacks). *Risk:* medium.

**Implementation caveat that makes-or-breaks it:** the NPS win is only real if we update
**only the accumulator we'll actually query at a node**, not both eagerly — maintaining
two full accumulators per move would eat the savings. Settle this lazy-update detail first
(see §3a scaffold).

#### 3a. The small net (128-wide, threatless)  — sub-plan

**Not HCE.** The killer is the **seam**: a dual eval must be continuous across the routing
boundary or the search oscillates (positions flipping balanced↔lopsided as a move changes
material would see the eval *jump* if the two functions disagree). HCE and NNUE are on
wildly different scales/characters → a big discontinuity → unstable PVs near the threshold.
Also "lopsided ≠ trivial" (fortress/stalemate/conversion still matter, and NNUE beats HCE
there — SF *deleted* HCE for a reason). HCE's only edge is speed, and a 128-net is already
nearly free. Bad trade.

**Not v6-as-shipped, but v6 is a great scaffold.** v6 is genuinely *much* faster than the
current threats net — **but not because of FT width** (both ~512). The cost is **per-move
churn + table scatter**: a quiet move changes ~2 features in v6 vs *dozens* of threat edges
in the current net, each a scatter into a 40 MB threat table (cache-hostile). That churn is
exactly why we needed Plan9 asm / VNNI / int8 to make the current net's movetime survive; v6
needed none of it. So v6 *would* save real NPS as a small net — but at 512-wide it's 4×
wider than the target, and it was trained independently (→ a scale seam). **Use v6 as the
plumbing proof-of-concept**: bolt it on to validate the routing gate + the lazy-accumulator
update *before* training the real 128-net. Just know its measured NPS win understates the
real thing.

**The real small net:** purpose-built **128-wide, threatless** (base features → 128 FT →
lean tail; v6's cheapness *plus* a 4× narrower push).

**Train it on:** the **same data pipeline, same WDL targets, same `eval_scale` as the big
net.** The reason is the seam again — the cleanest way to guarantee the two heads agree at
the boundary is to have both regress *the same target on the same scale*, so their outputs
land on the same cp scale by construction and the routing threshold is easy to place. That's
the SF-standard approach (one pipeline, two archs). Train on the **full distribution**, not
lopsided-only, or the routing edges get ugly.

**Upgrade in the pocket — distillation.** If the boundary seam shows up in testing, train
the small net to *reproduce the big net's eval* (teacher→student) instead of / on top of raw
WDL. Two benefits: exact scale alignment (the student targets the teacher's outputs → the
seam nearly vanishes) and, at 128-wide, it punches above raw-WDL training (learning from a
smarter label than the game result). Cost: plumbing to run the big net over the positions to
generate targets. **Start same-data/same-scale; reach for distillation only if the seam bites.**

### Phase 4 — Threat PSQT skip  **[do *before* width — the cheap bottleneck test]**

SF gives threats a direct FT→output path (`nnue_feature_transformer.h:248-254`, PSQT
buckets), letting the threat signal move the eval *without* passing through the trunk
bottleneck. Ours has NB output buckets but no direct FT→output skip. This relieves the exact
512-trunk bottleneck that width (Phase 5) would fix — but far cheaper. **Test it first: if the
skip captures most of the bottleneck relief, we may not need to pay for 1024 at all.** Slots
naturally alongside the dual-net topology work. *Effort:* medium. *Risk:* medium.

### Phase 5 — 1024 trunk width  **[last, only behind the dual net]**

Our past 1024 tries **washed at movetime** (`ARCH_DIRECTION §6`, CLAUDE.md backlog) — but
those were 1024 *without* rich inputs to fill it *and* without a dual net to make it
affordable. Width should only pay now: rich geometry to fill the capacity (Phases 1-2), the
dual net to cap the movetime cost to big-net nodes (Phase 3), and only if Phase 4 didn't
already capture the gain. Highest risk, so it's gated behind everything. *Effort:* medium-high
(retrain + the real ~1.7× node cost of a wider int16-bound tail). *Risk:* medium-high — attempt
**only behind the dual net** so the cost lands on big-net nodes.

---

## 4. Ordering rationale + dependency graph

```
Phase 1 DATA ──amplifies──▶ every phase below (train + measure on it)
Phase 2 BASE (32 buckets) ──▶ Phase 3 DUAL NET ──▶ Phase 4 PSQT SKIP ──▶ Phase 5 WIDTH
                                    │                    (cheap alt to width;         (only behind
                                 3a SMALL NET             try before paying for it)    the dual net)
```

- **Data first** because it re-judges what we just built *and* lifts every later step; it's
  the longest infra pole, so start it now and run Phase 2 on current data in parallel, then
  converge.
- **Base before dual net** so the keystone is built on the better substrate, not retrofitted.
- **Dual net is the keystone** — it makes width affordable and concentrates threats; nothing
  expensive downstream is safe without it.
- **PSQT skip before width** because it's the *cheap version of the same fix*.
- **Width last** because it has repeatedly eaten its own gain at movetime; only safe once
  data fills it and the dual net pays for it.

---

## 5. On "more superbatches" — the days/weeks question

**Not on the current setup.** "More superbatches" is a *dependent* lever, not a standalone
one — it only pays with (a) **more unique data** and (b) **more capacity**:
- On the *same* 4 months, more superbatches = more epochs = overfit / diminishing returns.
  Superbatch count scales with dataset **size**, not clock time.
- Capacity ceiling, proven in our own history: **v4 (256-wide) floored at loss 0.0317 in
  ~600 sb; v5 took 2400 sb to reach the *same* 0.0317 floor** (`ENGINE_ROADMAP`: "v5 maturity
  net = dud"). More superbatches did **not** beat the capacity ceiling.

So training for days/weeks only becomes justified *after* Phase 1 (more data) + Phase 5 (more
capacity) give a lower floor and more positions to fill it. **The knob is a validation set,
not a clock:** hold a val split, train until val-loss stops improving (early-stop), ship the
annealed final. Within a night, the *anneal schedule* matters more than raw sb count.

---

## 6. Measurement discipline (unchanged, applies to every phase)

- Each change is behind a flag / a separate net; A/B **directly vs the current prod net**
  (not transitive chains — `[[sprt-direct-vs-prod-and-fn-mt]]`).
- **Gate on movetime SPRT** (FN can mislead; an FN win that washes at MT doesn't ship).
- Run FN + MT + a periodic Abitur anchor (SF18 / Stormphrax / Reckless) on the AVX-512 box
  (coalla). Ship only on a clear positive lower bound. Ship the **final annealed** net, never
  a mid checkpoint (`[[nnue-ship-annealed-final]]`).
- Deploy = file-swap `data/nnue/kb-mirror.bin` + `chessgo-deploy` on lairner
  (`[[prod-deploy-lairner]]`); the net is gitignored, so place it **before** the rebuild or
  the new binary falls back to the embedded v6.

---

### One-line answer to "in what order?"
**Data → richer base → dual net (with a purpose-built 128-wide threatless small net,
same-data/same-scale, distillation in reserve) → threat PSQT skip → 1024 width.** Start with
the interleaved multi-source data pipeline.
