# Opening name / ECO port — DONE 2026-07-15

**What.** zugzwang returned a hardcoded `opening: null` in `/bestmove` /
`/candidates`. Ported gomachine's Zobrist-keyed opening-name/ECO table so serve
emits `{name, eco}`.

## DONE (2026-07-15, commit 44ed395)
- New `src/openings.{cpp,h}` + `openings.bin` (3733-entry Lichess table), keyed by
  **gomachine's native `book_key` Zobrist** (NOT zugzwang's own zobrist — that key
  differs; the ported data matches gomachine's scheme byte-for-byte). `classify()`
  takes an ordered key line (root→current) and returns the **deepest** match
  (Lichess "longer variation wins").
- Loaded in `serve.cpp` (non-fatal); wired into `serve_handlers.cpp` `best_move`
  (all 3 return paths) + `candidates` (top-level + per-candidate, replaying each
  move to append the child key).
- Functionally verified on coalla: `1.e4 e5 2.Nf3` → `C44 King's Knight: Normal
  Variation`; `1.d4 d5 2.c4` → `D06 Queen's Gambit`.

Completes gomachine parity (book-everywhere + opening names). Parity — no SPRT.
