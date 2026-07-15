# Multi-thread + search wave — 2026-07-15 (overnight)

Autonomous session: movetime-Elo levers + gomachine parity. All builds + SPRTs on
coalla (fastchess, 100 ms/move, `sprt.sh`/`watch_sprt.sh`, `book.epd`, elo0=0/elo1=5).
Pre-session baseline = `0a17979`.

## Shipped (committed to main)

| Change | Commit | Result |
|---|---|---|
| **Lazy SMP** — multi-threaded search, UCI `Threads` 1-256 | 9377628 | **+139.5 ± 32.6 Elo @ 4T vs 1T** (166 games, 69.1%, Ptnml[0,0,33,33,14], 0 losing pairs) |
| **RFP tweak** — fold `opponentWorsening` into RFP margin + `improving\|=staticEval≥beta` | d92d3ad | **+30.5 ± 13.5 Elo @ 1T** (810 games, 54.4%, lb +17, LLR 1.72 climbing; accepted early) |
| **book-serve** — probe opening book on the website `/bestmove` path | d678c3c | parity (gomachine); verified startpos→e2e4 nodes:0 |
| **opening-name/ECO** — port gomachine's classifier to serve | 44ed395 | parity; verified C44 King's Knight / D06 Queen's Gambit |

**Cumulative (final @4T vs pre-session @1T):** **+132.1 ± 28.5 Elo** (249 games,
68.2%, Ptnml[0,4,50,46,24], LLR 1.50 climbing, lb ~+104; stopped early on
overwhelming evidence). Statistically the same as SMP-alone (+139) — SMP dominates
the total; RFP's +30 @1T is partly absorbed at 4T's deeper search. Pure 1-thread
search-only gain over pre-session = RFP ≈ +30.

## Lazy SMP design (headline)
N `Search::Context`s share ONE global TT + one `std::atomic<bool>` stop flag + a
shared time deadline; helpers are `std::thread`s, main runs inline; SF-style
best-thread vote (deepest, tie→score). **Threads=1 is byte-identical** to the prior
single-thread search (smoke-verified: startpos e2e4, kiwipete e2a6 = base). **No
`tt.*` change** — the existing key16 low-bit verification (commit d43d489) makes
concurrent TT races self-correcting (torn read → key miss). `TT.new_search()` called
once by the driver; workers skip it. Serve path left single-thread-per-request
(`// TODO: SMP on serve path`). Wired in `uci.cpp` go handler.
> **Deployment note:** the +139 is 4 threads vs 1 at equal movetime — a real
> fixed-time strength gain for analysis + bot moves when cores are free. In prod the
> serve pool trades threads-per-move against game concurrency (like gomachine's
> 2-thread prod setting); pick the thread count per the core budget. Nothing forces
> 4T; UCI `Threads` is the knob.

## Tried and REJECTED (SPRT'd, reverted — tree is saturated for SF-selectivity adds)
- **Full capture-loop ProbCut** (SF search.cpp:935-981, exact probCutDepth clamp):
  **washed, +4.1 ± 15.2** @ 612 games. Correct impl (0 illegal moves), just no Elo
  on our already-heavily-pruned tree.
- **Eval rule50 + material output scaling** (SF evaluate.cpp:70-90, optimism dropped):
  **−7.6 ± 13.4** @ 732 games — SF's material/rule50 constants don't transfer to our
  net's scale even after proportional rescaling. (rule50-damping ALONE untested —
  possible small win, low priority.)
- **ContHist-magnitude quiet prune** (SF search.cpp:1088, coeff 2000 scaled to our
  ±16k history): **washed, −0.6 ± 14.6** @ 590 games.

Lesson (again): this engine's search tree is saturated for bolt-on SF-selectivity
pruning/ordering — consistent with the closed `sf18-selectivity-gap` campaign. The
wins this pass were the ARCHITECTURAL add (SMP) and one margin that hit (RFP).
Remaining cheap search levers all SPRT flat/negative; next real search Elo needs a
structural change (SF fixed-point LMR rewrite + SPSA) or the data/NNUE track.

## Method notes / gotchas (for next session)
- coalla SPRTs are serial (one 12-core box); movetime SPRTs must NOT run concurrent
  with any build/serve (CPU contention corrupts the measurement).
- Per-change base must ADVANCE as changes commit (rebuild `zugzwang_base` from the new
  main), else you re-measure already-shipped changes. SMP is invisible at Threads=1,
  so 1T search changes can be measured vs a pre-SMP base.
- `pkill -f fastchess` over ssh self-matches the remote shell — use `pkill -x fastchess`.
- SMP SPRT needs asymmetric per-engine `option.Threads` (cand 4 / base 1, concurrency 3
  = 12 cores at peak); `sprt.sh` is symmetric, so use a bespoke fastchess call for it.
