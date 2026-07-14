# Why full-threats gained +10 in self-play but got WORSE vs Stockfish

**Status:** open (2026-07-11). **UPDATE 2026-07-13: H1 (Go↔Rust threat mismatch) REFUTED — Go
threats proven bit-exact vs the Rust trainer, verified ×2. Not a threat bug; look to H2/H3.**
Ground-truth observation, owner-confirmed,
same measurement method throughout (no methodology change between the two nets):

- **efs28** (enriched, coarse **9,216**-input threat block): **~90% vs cold Stockfish**
  (fresh process / empty hash per move).
- **full-threats** (`chessgo_threats_sf_640`, **79,856**-input SF full-threats):
  **draws and loses vs the same cold Stockfish.**
- full-threats is **+10 Elo vs efs28 in self-play SPRT**.
- **Same search, same movetime, same everything — only the net changed.**

This is a genuine **eval-quality regression**, and the self-play gate did not see it.

## What it is NOT — eliminated by direct measurement this session

| Suspect | Verdict | Evidence |
|---|---|---|
| Speed / NPS (fewer nodes at movetime) | **Ruled out** | `bench nps-ft`, same tool/box/session: coalla **461k vs efs28 469.6k (−1.75%)**, M3 **213k vs 212k (+0.6%)**. The 79,856-col threat FT is ~free (only ~70–112 cols touched/push). `docs/PROFILING/{amd,arm}/11Jul2026.md`. |
| Deployment quantization (deployed ≠ trained) | **Ruled out** | `TestEnrichedInt8Closeness`: int8 tail vs float **mean 8.7 cp / max 31 cp** (PASS). int16 threat-FT = **zero** clamp loss (int16 was chosen precisely to avoid the int8-FT 66 cp RMS). Deployed net ≈ trained float net. |
| Gross eval breakage | **Ruled out** | `TestSmokeEvalSanity` PASS — material signed correctly, evals in sane cp ranges. |
| King-bucket / mirror / Finny cache | **Ruled out** | Bit-exact incremental==from-scratch across all boundary types; bucket table pinned identical to the Rust trainer (subagent audit). |
| int16 threat-FT overflow/saturation | **Ruled out** | Real-net accumulator range **[−3016, +2894]** — 9× int16 headroom; SIMD==scalar. |
| Go↔Rust threat-feature inference mismatch (was H1, top suspect) | **Ruled out (2026-07-13)** | Go threat features proven **bit-exact vs the Rust trainer, verified ×2** — cross-check dump green incl. the same-type-edge / mir=0 paths. |

## The core principle (why +10 self-play ≠ stronger)

**Self-play SPRT measures RELATIVE strength — B vs a near-copy of itself (A).** It is
structurally blind to any change that makes B *relatively* better than A while making
B *absolutely* worse against a third party. Chess strength is **non-transitive**:
`B beats A`, `A beats SF-cold`, `SF-cold beats B` is a fully self-consistent cycle.
"Beats the previous gomachine by +10" has **never** meant "stronger against everyone" —
and the +10 gate never once tested the net against Stockfish.

A **~300-Elo swing** vs a third party (90% → loss) while only +10 vs A is *far* more
non-transitivity than benign style-cycling produces. That points to a **systematic
eval distortion introduced by the threat enrichment** that (i) exploits efs28's
*correlated* blind spots (same engine family — shared base/KB weights and training
data) and (ii) is objectively unsound against a perfect defender.

## Ranked hypotheses (H1 REFUTED 2026-07-13 — see below; H2/H3 remain open)

### H1 — Go threat-feature inference vs the Rust trainer. **REFUTED (bit-exact ×2)**
**Resolved 2026-07-13:** the Go threat features are **bit-exact vs the Rust trainer**, verified twice
(cross-check dump green across the same-type-edge and mir=0 paths described below). This is **not** the
cause of the vs-SF result. Retained for the record:
`internal/nnue/threats_sf.go:175` — the same-type-edge dedup survivor rule
(`at==vt && … && from<to → drop`) and the **mir=0 (queenside-king) path** are **not
pinned against the Rust trainer**. The two green cross-check FENs contain **zero
same-type non-pawn attack edges**, so the branch that indexes rook↔rook / knight↔knight
/ Q↔Q edges is **never exercised by any passing test**. If Go keeps the opposite
directed edge (or applies victim-exclusion asymmetrically) vs the trainer, every such
feature indexes the **wrong trained weight** → systematic eval bias.

Why it fits the symptom exactly:
- **Self-play-invisible** — both gomachines use the same Go inference, so they agree
  with *each other*.
- **SF-punished** — a biased eval = objectively bad moves a strong engine refutes.
- **8.7× more load-bearing in full-threats** than in efs28's coarse block — so efs28
  (whose coarse threats were train/play-consistent) stayed strong vs SF, while
  full-threats' rich threats broke. This is the cleanest single explanation.

**Decisive test:** run the Rust `cross_check_dump` (bullet repo) against the Go dump
`crosscheck_dump_test.go` writes to `/tmp/go_threat_dump.txt` (1500 positions incl.
the rook-standoff `4r1k1/8/…/4R1K1`). Green ⇒ no feature bug. Mismatch ⇒ smoking gun.
Cheap partial: add a same-type-standoff FEN with **Rust-captured** indices to
`sfCrossCheckWant`.

### H2 — threat-overvaluation / eval-noise reshaping the tree. **Likely contributor**
Even with correct features, richer threat inputs can (a) make the net overvalue
initiative → overpress vs SF (refuted) while beating the tamer efs28, and/or (b)
flatten the eval landscape (many active threat features → more moves score alike) →
worse move ordering → bushier trees.
- **Evidence:** nodes-to-depth-16 on the test FEN: full-threats **2.01M** vs efs28
  **0.995M (2×)**. Chaotic on one FEN, but if it holds on a suite, full-threats reaches
  **~1 ply shallower at equal movetime** → weaker vs SF, self-play-invisible.
- **Decisive test:** mean depth-reached-at-100ms + effective branching factor over a
  suite, both nets.

### H3 — self-play is the wrong gate (meta). **Certainly true regardless of H1/H2**
Every strength change since the v6 CCRL anchor was gated **only** on self-play SPRT,
which cannot detect an absolute regression that preserves the B>A edge. The cold-SF
result is the first real external signal, and it says the gate has been misleading.
- **Fix:** gate net changes on a **cold-SF (or neutral third-engine) match**, not only
  self-play SPRT. Run vs-SF before shipping any net.

## Recommended next actions (ordered by value)

1. **Localize net vs deployment (deployment already ruled out — confirm):** play
   efs28, full-threats, and the **float** full-threats net vs cold SF in one harness.
   Float also losing ⇒ it's the net/features (H1/H2).
2. ~~**H1 decisive:** Rust `cross_check_dump` vs the Go dump on same-type edges.~~ **DONE (2026-07-13)
   — green: threats bit-exact vs the trainer ×2, no bug. H1 refuted.**
3. **H2 decisive:** depth-at-movetime + EBF suite, full-threats vs efs28.
4. **Eval-vs-SF probe:** on threat-heavy/tactical positions compare full-threats cp,
   efs28 cp, SF cp; systematic full-threats deviation (esp. overvaluing the
   threatening side) where efs28 tracked SF localizes the bias.
5. **Change the gate:** vs-SF becomes a ship gate for nets.

## Bonus: the profiling detail that corroborates H1

`docs/PROFILING/amd/11Jul2026.md` shows the threat block is genuinely load-bearing at
runtime — `sfThreatIndex` 4.46% flat, int16 FT column add/sub (`addColSIMD`+`subColSIMD`)
~23% flat, `applyDiff` 32.8% cum. The eval spends a large fraction of its time in the
threat features, so a correctness bug there is **maximally** damaging — consistent with
"efs28 (tiny threat block) fine, full-threats (huge threat block) broken."
