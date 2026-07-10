# SESSION CONTEXT — Full-Threats build (2026-07-10) — READ ON RESUME

This is a recovery doc after a /compact. It captures live state, the two background
jobs, and the ordered next steps. Companion design doc (READ IT):
`docs/open_tasks/threats-richness-build.md` (SF spec, factoriser V1/V2/V3, gotchas,
320sb run spec). Strength/measurement log: `docs/ENGINE_STRENGTH.md`.

## MISSION (why we're here)

Add **input richness** to the NNUE — the measured lever. Evidence: the multilayer
*tail* is NOT the lever (Abitur measured multilayer net vs lean = **−24 ± 27**, a
wash/slightly-worse; both share identical 512 FT + coarse 9,216 threats). SF's history
agrees: threats were the Elo, and SF *shrank* L1 3072→1024 (confirmed at v10 from
`~/sf18-arm`) because threats carried the knowledge. Our threats are ~9× coarser than
SF's (attacker SQUARE not encoded). So: **port SF18 Full-Threats (9,216 → 79,856)**,
which encodes the attacker's geometry via the compact (from→to) edge-rank. Cost is
~0 at movetime (same active-edge count; only index math changes) — the cost is net
size + training a big sparse table (→ needs a factoriser).

## STATE OF THE REPO

- **Branch `feat/full-threats`** (main = deployed prod, do NOT confuse):
  - `a82848c` — SF Full-Threats LUT core (`internal/nnue/threats_sf.go`): `sfThreatIndex`
    + LUTs. VERIFIED: total dim exactly 79,856, injective (73,276 valid edges, 0
    collisions), attack-table sizes match SF (pawn 84/knight 336/bishop 560/rook
    896/queen 1456/king 420). Test `threats_sf_test.go`.
  - `dc0ba99` — wired `sfThreatIndex` into all 4 emission/delta sites
    (`enriched.go` appendEnrichedFeatures/Both, `enriched_delta.go` appendAttackerEdges/
    appendChangedEdges). `ThreatBlock` → `SFThreatDim`=79856; enriched InputDim
    21504→92144. **Feature-index type widened uint16→uint32** (a threat feature reaches
    ~92143 > uint16 max; uint16 would silently wrap AND still pass NNUE_ASSERT since both
    paths wrap identically — a real bug caught by a new bounds test). GATES GREEN: build,
    `go test ./internal/nnue/`, `NNUE_ASSERT=1` bit-exact (TestEnrichedMoveAwareBitExact
    = incremental accumulator == scratch rebuild), perft(5)=4865609. Old-scheme pin tests
    (kb_verify*, TestEnrichedThreatIndices, loadkbnet detect) SKIPPED pending Rust port.
- **main @ `2829a2e`** = DEPLOYED to prod (lairner) + coalla + local. Two commits:
  - `2ca8827` fix(nnue): **move-aware push for multilayer prod net** — THE prod
    regression fix. `loadDefaultKBNet` (cmd/gomachine/bench.go) now calls
    `SetMoveAware(true)` for the multilayer branch (was crippled: move-aware=false →
    eager full-feature accumulator pushes → ~3–4× fewer nodes @ movetime → lost to
    everything incl cold SF). Bit-exact. Also ships **Abitur** (`gomachine bench abitur`,
    internal/bench/abitur.go, scripts/abitur/) — our multi-engine gauntlet ("fishtest").
  - `2829a2e` docs: corrected the WRONG "SF removed the dual net" claim (SF18 + master
    SFNNv13 both STILL run the dual small/big net — the removal claim was from a fork).

## THE INDEX SCHEME (the contract Go and Rust MUST both satisfy)

`sfThreatIndex(atkRel, atkType, vicRel, vicType, from, to)` in threats_sf.go, index =
`attackerBase[rel] + victimSlot*attackTableSize[rel] + offsets[rel][from] +
edgeRank[rel][from][to]`, rel = atkRel*6+atkType (0..11), from/to are perspective-
ORIENTED (`^56` if black, then `^mir`). Exclusions: pawn→{B,Q,K}, {B,R,K}→Q, K→K.
Same-type dedup: drop from<to unless same-color pawn. Emission appends `PsqSize+idx`
only when ok. Both attacker (from) and victim (to) squares get the same orient^mir.

## BACKGROUND JOB 1 — Rust recipe subagent

- **Agent id `af80a15c2491b35c6`** (SendMessage to continue it). Drafting
  `~/nnue-training/bullet/examples/chessgo_ml_threats_sf.rs` (copy of template
  `chessgo_ml_efs28.rs`). Task: (a) new `ThreatInputs` SparseInputType matching
  `sfThreatIndex` byte-for-byte (num_inputs = 12288+79856); (b) factoriser **V1 victim
  marginal `(a*12+v)*64+victimSq`(9216) + V2 attacker marginal `(a*12+v)*64+attackerSq`
  (9216) + V3 pair bias `a*12+v`(144)**, folded at export, mirror-inside-factor,
  dedup-consistent; (c) int8-FT QAT (faux_quantise on threat FT rows); (d) arch
  `(12288+79856)→512x2→pairwise→16→32→1` NB=8, superbatches=**320**, net_id
  `chessgo_threats_sf_320`, all other vars held = template. Gate: `cargo check --example
  chessgo_ml_threats_sf`. Asked it to also print sorted threat feature lists for 2 FENs
  (startpos + `r1bq1rk1/pp2bppp/2n1pn2/2pp4/3P1B2/2NBPN2/PPP2PPP/R2Q1RK1 w - - 0 8`) for
  the bit-exact cross-check.

## WHAT I'LL DO WITH THE SUBAGENT OUTPUT

1. Review the recipe's index formula against `sfThreatIndex` (must match exactly).
2. **Bit-exact cross-check**: get Go's threat feature list for the 2 FENs (write a tiny
   Go test/print using appendEnrichedFeatures) and diff against the Rust recipe's emitted
   lists. Update the `kb_verify` Go replica to the new scheme so it re-pins Go↔Rust.
3. Confirm factoriser folds correctly (V1/V2/V3 coalesced → real 79,856 weights) and
   int8-FT QAT is applied.
4. If issues → SendMessage the same agent (af80a15c2491b35c6) with the diff.

## BACKGROUND JOB 2 — test80 download (vast box)

- **Box:** `ssh -i ~/.ssh/private/devgit -o IdentitiesOnly=yes -o ServerAliveInterval=15
  -p 20448 root@154.64.230.67`. RTX 4090 (~48GB VRAM), **503GB RAM**, **67GB disk**
  (TIGHT), /dev/shm 31GB, CUDA 13.2 (/usr/local/cuda), python3+`hf` CLI installed,
  **HF token already logged in** (`hf auth login` done; token was hf_xGOG…). NO rust yet.
- **Download:** `/root/hfdl.sh` (setsid, log `/root/hfdl.log`) pulling linrock/test80-2024
  **Jan/Feb/Mar/Apr** `*-2tb7p.min-v2.v6.binpack.zst` → `/root/data/`. RUNNING as of
  compact. hf-xet native (NOT aria2 — aria2 hit xet 403s on multi-range).
- **Bullet source already on box** at `/root/nnue-training/bullet` (2.6MB, patched clone
  w/ custom threats SparseInputType + 14 recipes; transferred via tar-over-ssh, NOT rsync
  — rsync failed on the vast login banner).
- **DISK PLAN (67GB tight):** decompress each `.zst` and DELETE the `.zst` (`zstd -d
  --long=31`), symlink `/dev/shm/test80-...` → `/root/data/test80-...` (503GB RAM page-
  caches it). Recipe hardcodes `/dev/shm/test80-...` paths.

## BOX / OPS GOTCHAS (learned the hard way)

- Box SSH is intermittently flaky ("closed by remote host"). Use `setsid` for ALL
  long jobs (survives drops) + `ServerAliveInterval`. It was STABLE at last check.
- **No gawk on the box** (minimal container). Use awk/stat/plain shell.
- **pkill by `-x <comm>` NOT `-f`** — `pkill -f "bench abitur"`/`-f dl.sh` matches your
  own ssh shell → self-kill / exit 255. (comm truncates to 15 chars.)
- vast prints a login banner every ssh → corrupts rsync/scp protocol; use tar-over-ssh.
- vast containers can stop/start (wipes /dev/shm + non-setsid procs; /root disk survives).

## NEXT STEPS (ordered critical path)

1. **[recipe]** Review subagent's `chessgo_ml_threats_sf.rs`; bit-exact cross-check Go↔Rust
   on the 2 FENs; update kb_verify Go replica; fix via SendMessage if needed.
2. **[box build]** Install rust on the box (`curl rustup … -y`), set `CUDA_PATH=/usr/local/cuda`
   + PATH + LD_LIBRARY_PATH (in a launch script, NOT inline — nested quoting drops env),
   `cargo build -r --features cuda --example chessgo_ml_threats_sf`.
3. **[data]** When download done: verify (`zstd -t --long=31`), decompress-and-delete-.zst,
   symlink into /dev/shm.
4. **[train]** 320sb annealed. Harden: resume-capable + supervisor + /dev/shm symlink
   recreate (see memory `gpu-train-box-recipe`). Ship the FINAL annealed checkpoint
   (`quantised.bin`, 21504-shaped for the base but larger now — CHECK the new byte size).
   Kill trainers by `pkill -9 -x <comm truncated to 15>`.
5. **[verify]** Fold virtual→real at export; run kb_verify on the FOLDED net (a wrong fold
   is silent). Import into Go (need loadDefaultKBNet to handle the new 92144 InputDim +
   the much larger net file — ~135MB; the auto-detect / loader may need a size update).
6. **[measure]** Abitur: new net vs `ml640.bin` DIRECTLY (movetime 100ms, ≥250 pairs, no
   chaining — §35.3). Run on coalla (SIMD). Expected: FN wash-to-positive, MT positive.
   If MT flat + FN negative → tail starving / V2 dead → check the FOLD, don't add factors.
   Ship (file-swap kb-mirror.bin + deploy) only on a clear positive lower bound.

## KEY MEASUREMENT FACTS (don't relitigate)

- multilayer tail ≈ lean (−24 ± 27) — tail/width is NOT the lever; INPUTS are.
- Abitur 3-engine calib (100ms, coalla): SF18 ≳ Reckless (+32) ≫ Stormphrax; triangle
  closes to 6 Elo (harness validated). gomachine ~8% vs warm SF18 @150-vs-100 (6 games).
- SF18 arch (from ~/sf18-arm): big net L1=1024, L2=15(+1), L3=32; dual net RETAINED;
  Full_Threats=79,856; master SFNNv13 doubled L2→31(+1). Threats cost SF ~20-25% NPS
  (0→threats); OURS is ~1-2% (coarse→rich, same edges).
- After the 320sb read: consider trunk 512 may be too WIDE for a geometry-threats net.

## ABITUR (our measurement tool — built this session)

`gomachine bench abitur --config <json>` (internal/bench/abitur.go). Round-robin/gauntlet
of UCI engines (gomachine = `KB_NET_PATH=<net> gomachine uci`; externals in
~/abitur/engines/ on coalla: stockfish18/stormphrax/reckless, provisioned by
scripts/abitur/setup-engines.sh). Per-participant movetime = time odds. Pentanomial Elo +
anchored crosstable. KNOWN BUG: multi-match run crashes under plain nohup (ssh-session
teardown) — launch with `setsid`. Configs on coalla: ~/abitur/{rr3,abitur5,ml_vs_lean}.json.
