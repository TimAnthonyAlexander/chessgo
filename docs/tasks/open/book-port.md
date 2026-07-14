# Opening book port (SF lookup-cache book)

**What.** Port gomachine's `data/book.bin` (~594 KB) — a cache of ~30-min
Stockfish answers keyed by position hash — into zugzwang: a loader + a root probe
before search.

**Why.** Worth ~+160 Elo vs *external* engines (Stockfish / Abitur gauntlet) for
absolute strength. It washes in self-play vs gomachine (both would load it), so it
won't show in the SPRT ladder — it's the Stockfish-parity end-goal lever.

**Where.** New self-contained TU parsing gomachine's `internal/book` format + a
root probe in `search.cpp`/serve. The asset and the SF compute already exist —
this is just a loader.
