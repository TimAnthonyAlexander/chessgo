# Cuckoo upcoming-repetition detection (SF #15) — ready-to-execute port

**Status: RESEARCHED + prerequisites verified 2026-07-20. Not yet implemented — a
correctness-sensitive `do_move` change deferred out of a long session to avoid rushing
a wrong-draw-claim bug. This doc has everything needed to implement cleanly.**

## Why this is high-EV

Same mechanism CLASS as the one retrain-free win of 2026-07-20 (RULE50DAMP +7.45):
**draw-awareness**, not search selectivity (which is saturated in zug — every LMR/
pruning/ordering/history port washed or rejected). Backlog est +3–8. SF main
(`search.cpp:629`) + qsearch (`1504`) both short-circuit to a draw score the moment a
forced repetition is one move away.

## Verified zug prerequisites (all present)

- `StateInfo::previous` chained in `do_move` (position.cpp:342 `newSt.previous = st`) —
  and the chain SPANS FULL GAME HISTORY: uci.cpp:86-89 keeps each `position … moves`
  move's `StateInfo` in a `static std::vector<StateInfo*> states` and do_move chains it.
  Search-ply stack StateInfos chain onto the root → game-history chain. So the SF
  `st->previous` walk reaches back through game history + search plies. **CAVEAT to
  verify at impl time:** is the `static states` vector CLEARED on `ucinewgame`? If not,
  the chain can carry stale cross-game states — must reset it (zug's array-based is_draw
  resets via `history_count=0`, but the chain reset needs checking).
- `st->rule50`, `st->pliesFromNull` (position.h:20-21). `st->key` is the RAW key (zug does
  NOT 50-move-fuzz its key the way SF's `Position::key()` does — so `st->key` is directly
  usable, no `adjust_key50` concern).
- `between_bb(s1,s2)` (bitboard.h:89) = "strictly-between **plus b**", i.e. already
  includes s2. SF's check `(between_bb(s1,s2) ^ s2) & pieces()` therefore translates to
  **`between_bb(s1,s2) & pieces()`** in zug (no `^ s2`).
- `attacks<Pt>(s, occ=0)` template (bitboard.h:76) + `KnightAttacks[]`/`KingAttacks[]` +
  `bishop/rook/queen_attacks(s,occ)` for the empty-board reversible-move enumeration.
- `make_move(s1,s2)` (move.h:28) builds a NORMAL move; `MOVE_NONE=0` empty-slot sentinel
  (no collision: stored moves always have s1≠s2 so make_move≠0). `Zobrist::psq`/`side`
  present, independently XOR-composable.
- **MISSING → must add:** `int repetition;` on StateInfo + its `do_move` computation.

## Exact SF18 source to port (verbatim, from ~/sf18-arm/src)

### Cuckoo tables + init (position.cpp:104-161) — put at END of `Zobrist::init()` (BB
attacks already inited before Zobrist in uci.cpp:203-204 / serve.cpp:116-117):
```cpp
inline int H1(Key h) { return h & 0x1fff; }
inline int H2(Key h) { return (h >> 16) & 0x1fff; }
std::array<Key, 8192>  cuckoo;
std::array<Move, 8192> cuckooMove;
// in init(), AFTER psq/side set:
cuckoo.fill(0); cuckooMove.fill(MOVE_NONE);
int count = 0;
for (Piece pc : {non-pawn pieces, both colors})
  for (Square s1 = A1; s1 <= H8; ++s1)
    for (Square s2 = s1+1; s2 <= H8; ++s2)
      if (type_of(pc)!=PAWN && (attacks_on_empty(type_of(pc), s1) & sq_bb(s2))) {
        Move move = make_move(s1, s2);
        Key  key  = Zobrist::psq[pc][s1] ^ Zobrist::psq[pc][s2] ^ Zobrist::side;
        int  i    = H1(key);
        while (true) {
          std::swap(cuckoo[i], key); std::swap(cuckooMove[i], move);
          if (move == MOVE_NONE) break;
          i = (i == H1(key)) ? H2(key) : H1(key);
        }
        count++;
      }
assert(count == 3668);   // board-independent self-check — great port-correctness sentinel
```

### `st->repetition` calc in do_move (SF position.cpp:967-984), gated `cuckoo_enabled()`,
inserted AFTER `newSt.key = k` is finalized (position.cpp ~468) — newSt is SF's `st`:
```cpp
newSt.repetition = 0;
int rend = std::min(newSt.rule50, newSt.pliesFromNull);
if (rend >= 4) {
    StateInfo* stp = newSt.previous->previous;
    for (int i = 4; i <= rend; i += 2) {
        stp = stp->previous->previous;
        if (stp->key == newSt.key) { newSt.repetition = stp->repetition ? -i : i; break; }
    }
}
```
Reset `newSt.repetition = 0` in do_null_move + do_drop. rend=min(rule50,pliesFromNull)
bounds the walk to ≤ chain length (fresh set() has pliesFromNull=0 → no walk → no null
deref). Byte-neutral to perft/TT (separate field). Gate the whole calc behind
`cuckoo_enabled()` so base pays zero cost / stays byte-identical.

### `Position::upcoming_repetition(int ply)` (SF position.cpp:1431-1474), already declared
position.h:133 — implement using st->previous walk; zug `between_bb` already includes s2:
```cpp
int end = std::min(st->rule50, st->pliesFromNull);
if (end < 3) return false;
U64 originalKey = st->key;
StateInfo* stp = st->previous;
U64 other = originalKey ^ stp->key ^ Zobrist::side;
for (int i = 3; i <= end; i += 2) {
    stp = stp->previous;
    other ^= stp->key ^ stp->previous->key ^ Zobrist::side;
    stp = stp->previous;
    if (other != 0) continue;
    U64 moveKey = originalKey ^ stp->key;
    int j;
    if ((j = H1(moveKey), cuckoo[j] == moveKey) || (j = H2(moveKey), cuckoo[j] == moveKey)) {
        Square s1 = from_sq(cuckooMove[j]), s2 = to_sq(cuckooMove[j]);
        if (!(between_bb(s1, s2) & pieces())) {       // zug between_bb already includes s2
            if (ply > i) return true;
            if (stp->repetition) return true;
        }
    }
}
return false;
```
(cuckoo[]/cuckooMove[]/H1/H2 need to be reachable from position.cpp — declare in a shared
header, e.g. zobrist.h, or `extern` them.)

### Two search call sites (search.cpp), gated `cuckoo_enabled()`:
```cpp
// main negamax, before the move loop (after is_draw / TT probe area):
if (cuckoo_enabled() && !rootNode && alpha < VALUE_DRAW && pos.upcoming_repetition(ss->ply)) {
    alpha = VALUE_DRAW;              // or draw_value(nodes) if DRAWJITTER ever ships
    if (alpha >= beta) return alpha;
}
// qsearch: same minus !rootNode.
```

## Implementation order + gates

1. `cuckoo_enabled()` global getenv-once (`CUCKOO=1`), like the acc flags. Default OFF.
2. Cuckoo tables + init (assert count==3668 — if this fires, the attack/enum step is wrong).
3. `int repetition` on StateInfo + do_move calc (+ null/drop reset), gated.
4. `upcoming_repetition` impl.
5. 2 call sites, gated.
6. **VERIFY:** `make perft` unchanged (repetition is perft-neutral); build ASSERT=1 clean;
   add a tiny repetition unit-test (a known 3-fold line → upcoming_repetition true one move
   before). THEN SPRT `CUCKOO=1` vs base on coalla (movetime, elo1=3 so a small win can
   accept — see [[zug-movetime-noise-floor]]).

## Risks to respect

- **Wrong draw claims** if the walk/marker is off → tactical blunders in real games. This is
  why it's gated + needs the perft + repetition unit-test before trusting an SPRT number.
- Stale `static states` chain across `ucinewgame` (see prereq caveat) — verify reset.
- If the st->previous chain proves NOT clean across games, fall back to computing a parallel
  `game_repetition_history[]` alongside zug's existing `game_key_history[1024]` array and
  walk THAT instead of st->previous (zug's is_draw already uses the array — same infra).
