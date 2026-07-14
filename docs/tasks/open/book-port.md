# Opening book port (SF lookup-cache book)

**What.** Port gomachine's `data/book.bin` (~594 KB) — a cache of ~30-min
Stockfish answers keyed by position hash — into zugzwang: a loader + a root probe
before search.

**Status (2026-07-14):** loader + GMBK parser + `book_key()` (gomachine-Zobrist)
+ **UCI `OwnBook` root probe LANDED** (commit 353024b, `src/book.{h,cpp}` +
`src/uci.cpp:try_book_move`). **STILL OPEN: the serve/website path does NOT probe
the book** (`serve_handlers.cpp:424` "No book"), so the +Elo only reaches UCI/EvE,
not prod games — the value-delivering half remains.

**Why.** Worth ~+160 Elo vs *external* engines (Stockfish / Abitur gauntlet) for
absolute strength. It washes in self-play vs gomachine (both would load it), so it
won't show in the SPRT ladder — it's the Stockfish-parity end-goal lever.

**Where (remaining).** Add a root book-probe to the serve `/bestmove` path
(`src/serve_handlers.cpp`), loading `book.bin` at serve startup like `uci.cpp`
does. The asset, loader, and SF compute already exist — this is the serve wiring.
