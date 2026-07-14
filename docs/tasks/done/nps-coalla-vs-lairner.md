# Measure zugzwang NPS: coalla vs lairner (is prod's speed a build issue?)

**Status:** DONE (2026-07-14) — root cause found: netcup **host-side CPU frequency cap** on
lairner (~1.74 GHz vs coalla's ~3.64 GHz, same EPYC 9634, same product). Not a build/engine/ISA
issue. Not fixable from the guest (KVM, no cpufreq); ACPI restart did not re-place the host. Evidence
filed with netcup support (customer 255827, 2026-07-14). The only *code*-side lever that helps a
clock-capped prod box lives in [nps-infra-batch.md](nps-infra-batch.md). Full write-up below.
· **Area:** engine / perf

## Observation (2026-07-14, deploy of `44b4728`)
Same source, same net, same build flags (g++ `-march=native -ffp-contract=off`),
single `/bestmove` on the start position:

| Box | CPU | NPS @ 1s | Depth @ 1s |
|---|---|---|---|
| **coalla** | AVX-512, 12 cores | ~286k | 16 |
| **lairner (prod)** | AVX-512, fewer cores + less RAM (same instance family) | ~113k | 15 |

Both are AVX-512 boxes — lairner is a smaller instance of the *same* type. A ~2.5× **single-search**
gap is more than fewer cores explains: a single search is single-threaded per pool `Context`, so
core count shouldn't move per-search NPS much. So either lairner's cores/memory are genuinely
slower, or **the lairner build isn't actually using AVX-512** (or an int8/vector path silently fell
back to scalar).

## What to check
1. **Is AVX-512 really in the lairner binary?**
   - `g++ -march=native -dM -E - </dev/null | grep -i avx512` on lairner — does `-march=native`
     even detect it? (VPS CPUID masking can hide it.)
   - `objdump -d /var/www/chessgo/zugzwang/zugzwang | grep -cE 'zmm|vpdpbusd|vpmaddubsw'` vs the
     same on coalla — are wide-vector / int8-dot instructions emitted at all?
2. **Apples-to-apples at FIXED nodes** (not movetime) on both boxes — same binary, same net — for a
   timing-noise-free NPS number (a `bench`-style fixed-node run).
3. **Memory-bound?** The NNUE eval is latency-bound; `perf stat -e cache-misses,instructions` on
   both. A small instance with fewer RAM channels could show a real bandwidth-limited gap.
4. **Contention:** lairner hosts many vhosts + gomachine engine/hub — measure quiet vs under load.

## Outcome
- If the lairner build is missing AVX-512 (CPUID masking → `-march=native` picks a lower ISA, or a
  flag differs): pin the ISA explicitly (e.g. `-mavx512f -mavx512bw …` or `GOAMD64=v4`-equivalent)
  → **free prod speedup**.
- If it's a genuinely weaker/contended box: document the expected prod NPS and fold the speed win
  into [nps-infra-batch.md](nps-infra-batch.md) (hand-written SIMD kernels — zugzwang currently
  relies on compiler auto-vec, unlike gomachine's AVX-512 kernels, which is the bigger lever).

Note: strength is NOT the concern here — the +24.6 vs gomachine was measured at equal *movetime* at
zugzwang's real (lower) NPS, so it out-searches per node. This is purely about making prod analysis
reach a given depth faster.

---

## RESOLVED (2026-07-14) — lairner's netcup HOST is frequency-capping the core (regression, not a build/engine issue)

Investigated on both boxes directly (both on commit `44b4728`, each built locally with
`-march=native -ffp-contract=off`). coalla and lairner are the **same netcup product** (both KVM
guests, `systemd-detect-virt=kvm`, same AMD EPYC 9634, same disk image); coalla just has more
cores/RAM. This is a **regression** — lairner previously ran at full boost (gomachine there used to
out-run the M3 Mac).

**Measurement discipline (learned the hard way):** short benches from an idle core are
turbo-ramp-confounded (saw 1000↔363 ms swings on the *same* box). Use a **sustained** search
(≥6–8 s, `taskset -c 0`) and read achieved GHz from `perf` cycles ÷ task-clock. `/proc/cpuinfo`'s
`cpu MHz` (2246) is a **static nominal constant** on these KVM guests — it never reflects real
frequency (no `cpufreq` driver exists in the guest), so ignore it.

Findings, in order:

1. **AVX-512 is present and used.** `-march=native` → `znver4`; 12 `__AVX512*` macros; shipped binary
   emits **1474** `zmm`/`vpdpbusd`/`vpmaddubsw` instructions. Missing-ISA hypothesis is **false**.
2. **Sustained, warm, single-thread, pinned — reproducible:** identical deterministic node counts,
   **identical IPC (~1.57)**. Only clock differs: **coalla 3.58 GHz / ~300k NPS vs lairner 1.76 GHz /
   ~145k NPS = 2.03×**. Same work, same efficiency-per-cycle; the entire gap is clock.
3. **The cap hits *every* workload on lairner, not just zugzwang** (this kills the "zugzwang
   auto-vec / heavy-AVX-512-license downclock" theory). Same core 0, sustained: scalar integer loop
   **1.776 GHz**, gomachine (AVX-512 VNNI int8) **1.763 GHz**, zugzwang **1.76 GHz**. On coalla all
   three run **~3.6 GHz**. So gomachine is throttled *identically* — prod's old gomachine speed
   advantage is gone for the same reason.
4. **Host-side power cap, not contention, not thermal, not burstable:**
   - burst 0.25 s = **1.754 GHz**, sustained 6 s = **1.765 GHz** → never boosts, ever (not thermal,
     not burstable-credits).
   - **`%steal = 0.00`** even under full 4-core load → not tenant oversubscription.
   - no throttle/thermal/MCE events in `dmesg`; stable (non-oscillating) clock.
   - both boxes are KVM guests with **no `cpufreq`/governor/`amd_pstate`** exposed → frequency is
     100% host-controlled; **nothing in the guest can change it.**
   - lairner sustains **below the EPYC 9634's own 2.25 GHz base** → the physical host is
     power/frequency-limiting the socket (BIOS eco/cTDP profile, or a degraded/power-capped host).

**Conclusion:** prod is ~2× slower purely because lairner's **netcup host** runs the core at ~1.76
GHz vs coalla's 3.58 GHz. The build, ISA, engine, and NNUE are all fine and identical. The
"weaker EvE / slower analysis on prod" is the same cause: half the clock → half the NPS → ~1 ply
shallower at equal movetime. **This is an infra/netcup problem, not a code problem.**

**This is a known netcup Root Server behaviour, not a fault on this box.** netcup explicitly does
not guarantee boost clock (only "between min & max"); Root Server cores are shared/oversubscribed,
and there have been G11/G12 incidents of overpacked "dedicated" nodes halving performance. Below-base
1.66–1.76 GHz sustained with 0% steal is the packed-host end of that. Refs: LowEndTalk
"Netcup pauses all G11 Root Server orders and reduces performance by 50%", LowEndBox "Netcup Faces
User Riot Over Throttling Supposedly Dedicated Cores".

**Action (all netcup-side — no code or build change helps):**
1. ~~Cold stop→start via the SCP panel to re-place the guest on another host.~~ **TRIED
   2026-07-14 (ACPI shutdown → start): did NOT move hosts — post-reboot still ~1.63–1.66 GHz.**
   netcup Root Server disks are node-local, so power-cycling returns you to the same physical node.
2. **→ netcup support ticket (the remaining lever):** same product as coalla runs 3.58 GHz, lairner
   1.66 GHz (below the 9634's 2.25 base), 0% steal, no thermal events → ask them to migrate the VM to
   a less-loaded/healthy node or check the host's CPU power profile. It's a regression (prod used to
   boost). Escalation if unresolved: re-provision (fresh order lands on a new node) or move prod off
   shared Root Servers to genuinely dedicated cores / bare metal.

**Engine-side note (does NOT fix this):** the only code lever that helps a clock-capped box is fewer
cycles per node — hand-written SIMD NNUE kernels vs today's compiler auto-vec
([nps-infra-batch.md](nps-infra-batch.md)) — but that's a general speedup, not a remedy for the host
cap. Fixing the host restores ~2× for free.
