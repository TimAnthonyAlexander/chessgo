# Opening book port (SF lookup-cache book) — DONE 2026-07-15

**What.** Port gomachine's `data/book.bin` (~594 KB) — a cache of ~30-min
Stockfish answers keyed by position hash — into zugzwang: a loader + a root probe
before search.

## DONE
- **UCI `OwnBook` root probe** landed 2026-07-14 (commit 353024b, `src/book.{h,cpp}`
  + `src/uci.cpp:try_book_move`).
- **Serve/website path now probes the book** (2026-07-15, commit d678c3c):
  `Book::shared()` process-wide singleton, loaded in `serve.cpp` at startup
  (non-fatal), probed in `serve_handlers.cpp:best_move` on the full-strength path
  (mirrors gomachine's `bookHit` gate — no rating/level/worst → book first).
  Functionally verified on coalla: startpos `/bestmove` → `e2e4` with `nodes:0`
  (book hit, no search). `/candidates` intentionally left unprobed (gomachine's
  `handleCandidates` doesn't probe either — it full-searches for the eval bar).

**Why.** Worth ~+160 Elo vs *external* engines (Stockfish/Abitur gauntlet) for
absolute strength; washes in self-play (both sides load it) so it never showed on
the SPRT ladder — parity, not an SPRT lever.

**Follow-up (minor, optional):** `/analyze-game` could also consult the book like
gomachine's `analyzePositionWith` does; left out as out-of-scope.
