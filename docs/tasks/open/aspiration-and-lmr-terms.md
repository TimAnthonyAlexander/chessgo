# Adaptive aspiration delta + missing SF LMR terms

Small SF-formula ports around aspiration windows and the LMR reduction. Related (both shape the
depth/window schedule) — one task, SPRT each independently.

## 1. Adaptive aspiration delta

**What.** Zug uses a fixed initial delta `aspInitDelta=25` and widens `delta += delta/2`
(`search.cpp:1485-1497`). SF makes the initial delta **score-volatility-adaptive**:
`delta = 5 + threadIdx%8 + |meanSquaredScore|/9000`, and widens more slowly (`delta += delta/3`).

**Why.** A volatile position opens a wider window (fewer costly re-searches); a stable one stays
tight (more cutoffs). **small**, but interacts with time management — isolate the SPRT.

## 2. Missing SF LMR reduction terms

**What.** Zug's LMR (`search.cpp:980-1010`) already has most SF terms (ttPv, cutoffCnt, hindsight,
improving, cutNode, history). Still missing vs SF:
- **aspiration-window-relative term**: `delta * 608 / rootDelta` — zug computes `delta` in its
  aspiration loop but never threads `rootDelta` into the LMR formula (no `rootDelta` symbol exists).
- **allNode self-scaling**: `r += r / (depth + 1)` at expected-fail-low nodes (no `allNode` in zug).

**Why.** Two more of SF's reduction refinements; each **small** but they compound with the stack
already shipped.

**Gate.** Movetime SPRT each. Effort: small (formula ports; #2's `rootDelta` needs threading the root
aspiration delta down into negamax).
