# Secret Queen — a hidden-information variant for `/bot` and live play

Each player secretly designates one of their eight pawns. It is a queen, and it
plays like one, but to the opponent it looks like a pawn until it moves like a
queen.

Variant id `secretqueen`, label "Secret Queen". Reachable from `/bot` and from
live play (quick pool + challenge links), like Duck/Crazyhouse/Antichess.

We follow the **phantomchess.in "Hidden Queen Chess"** ruleset — the most concrete
published version of this variant (same variant as the `dames-cachees`
implementation announced on the Lichess forum). Sources at the bottom.

## Rules

1. **Designation.** Before the first move, each player picks one of their own
   pawns. It appears as an ordinary pawn to the opponent. Selection is
   **simultaneous** — neither player learns anything from the order. In live play
   it runs on a 15s timer; on timeout the server picks a uniformly random pawn (a
   fixed default like "the e-pawn" would be readable by the opponent, random is
   not).
2. **It moves as a pawn or as a queen.** Playing pawn moves is how it stays
   hidden.
3. **Any non-pawn move permanently reveals it** — it flips to queen artwork for
   both players and is an ordinary queen from then on. The test is clean because
   the overlap set is exactly the pawn moves: `e2e3`, `e2e4`, `e2xd3` stay hidden;
   `e2a6` reveals. UCI disambiguates promotion naturally — `e7e8q` is a pawn-shaped
   move, `e7e8` is a queen move.
4. **En passant does not exist**, for anyone, in this variant. Double pushes still
   happen; they just can't be answered en passant. This is phantomchess's rule, and
   it exists to kill the edge case where en passant interacts with a disguised
   piece.
5. **You win by capturing the enemy king.** There is no check, no checkmate, no
   pins, no castling-through-check restriction. The king is an ordinary capturable
   piece.
6. **Your own secret queen always carries a queen badge** on the piece, from
   designation until reveal, so you never have to remember which pawn it is. Only
   ever on your own — the opponent's renders as a plain pawn.
7. **Captured while hidden** → revealed as it comes off, and the capturer is told
   what they took. (Our call — phantomchess doesn't specify, and `dames-cachees`
   not telling you is listed as a known rough edge on its own forum thread.)
8. **Reaching the last rank** reveals it — a pawn on rank 8 has to promote, and
   this one is already a queen.

Draws: threefold and the fifty-move rule apply as normal. A player with no legal
move at all is a draw (our call; it is close to unreachable when king capture is
legal).

**Rule 5 is the one that shapes the build.** Removing check removes pins, legality
filtering, and every question about what a player is allowed to see — a king can
walk into a hidden queen and simply be taken. That is the variant's whole thrill,
and it's also why the hidden information stays perfectly hidden: nobody's move list
is ever trimmed by something they can't see, so nothing leaks through legality.

We already run exactly this shape — king capture as the win condition, no check
concept, `variantHasCheck` false — in **Duck**. The hub, both clients and the
status plumbing have handled it before.

## Why this is a different kind of build from the other four

Duck, Crazyhouse, Antichess and Chess960 are all **public-information** games, and
both play paths lean on that in the same specific way: the hub builds **one** state
payload and fans it out unchanged.

```go
// hub/hub.go:1267
func (h *Hub) broadcast(g *game, data []byte) {
    g.white.send(data); g.black.send(data)
    for c := range g.spectators { c.trySend(data) }
}
```

That payload (`game.go:408 snapshot()`) carries both `fen` **and** `legalMoves` —
the side-to-move's move list, sent to the opponent and to every spectator. In
standard chess that leaks nothing (they could compute it themselves). Here it hands
over the secret outright: the list contains queen moves from e2.

BaseAPI has the same shape on the bot path — `BotGameService::present()` returns
`$game->jsonSerialize()`, i.e. the whole stored FEN, to whoever asks.

So the load-bearing work is not the ruleset. **It is per-viewer redaction**, and it
has to be right, because a leak makes the variant pointless rather than
buggy-looking.

## Representation

**Movegen runs in the information set of the side to move**: your own hidden queen
is a queen, the enemy's hidden queen is a pawn, king capture is a legal generated
move, and nothing is filtered for king safety. One rule, and every behaviour above
falls out of it. It's also exactly what the bot needs to search, so the rules
module and the engine share one function rather than two that have to agree.

Because there's no check machinery to satisfy, **the board can hold a plain `P` on
the secret square** and the queen-ness lives entirely in a side field. So:

```
rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1 [e2|h7]
                                                          ^^ ^^  W hidden | B hidden, "-" once revealed
```

**Redaction is then subtractive — drop the field.** No piece substitution, so it
cannot leak by someone forgetting to swap a square. Once revealed, a real `Q` is on
the board and there is no hidden state left at all.

Trailing-field encoding follows the Crazyhouse precedent, and it keeps replay
correct for free: the hub reconstructs by `variant.New(g.variant, g.startFen)` and
replays moves — `fenHistory()` (game.go:351) and `rebuildTo()` (game.go:372, the
takeback path). Designations in `startFen` means takeback and repetition detection
need no extra plumbing. `BoardFEN()` strips the field, as it already does for the
Crazyhouse pocket.

| Viewer | Board FEN | `legalMoves` |
|---|---|---|
| White | `[e2\|-]` — own secret kept, Black's stripped | own list, only when White is to move |
| Black | `[-\|h7]` | own list, only when Black is to move |
| Spectators | `[-\|-]` | none — they don't need it |
| Server: `refreshLive`, anti-cheat, persistence | full | — |

At game end, send the full state to everyone.

## Work, by component

### zugzwang (`src/secretqueen.{h,cpp}`) — the ruleset

With no check, no pins and no legality filter, `Position`'s machinery would be
fighting us rather than saving work — the same reasoning `duck.h` and `antichess.h`
give for not touching it. So: a **standalone mailbox module** in that mould
(reusing the board primitives from `types.h` / `BB::attacks` read-only), not the
`crazyhouse.h` Position-embedding.

- movegen = pseudo-legal moves in the mover's information set, plus queen moves
  from a hidden queen's square, plus king capture. No own-king-safety filter, no en
  passant.
- castling stays, minus the through-check condition (there is no check) — matching
  Duck.
- reveal = a post-move check: was that a non-pawn move from a hidden queen's
  square?
- terminal = king captured (mover wins), threefold, fifty-move, no legal moves.

Endpoints mirroring the existing variants (`serve.cpp:221+`):
`/secretqueen/legal-moves`, `/move`, `/bestmove`, later `/analyze-game`. Each takes
the extended FEN, so they stay stateless.

Perft is the gate — positions with a known secret, node counts against a
brute-force reference, same as movegen is guarded today.

### The bot

Its own iterative-deepening alpha-beta in the module (the `antichess.cpp` pattern),
searching **in the bot's own information set**: its secret queen is a queen, the
opponent's secret pawn is a pawn, king capture is terminal.

Unlike Duck and Antichess, this variant's board is standard-shaped, so **the NNUE
net is usable for leaf eval** rather than needing a hand eval — that's the cheap
route to a bot that actually plays well. The eval is blind to the opponent's hidden
queen, which is correct: the bot gets ambushed the same way a human does, with no
belief model and no peeking. Worth a code comment, because "the bot cheats" is the
first thing a player will suspect when it finds their queen.

Bot designation: weight the pick rather than picking uniformly (a central pawn and
a rook pawn play very differently), so bot games don't feel samey.

### BaseAPI (`/bot` path — ship this first)

- `BotGame`: add `secret_w`, `secret_b` (nullable, 2-char squares), or fold into the
  stored `fen`. Model change → `migrate:generate` → `migrate:apply -y`.
- `BotGameService::present()` **must redact the bot's secret** and keep the human's.
  One redaction point on this path, easy to test.
- Route the variant to `/secretqueen/*` in `humanMove()` / `present()`, alongside
  the existing duck/crazyhouse/antichess arms.
- Undo: refuse once either secret has been revealed — un-revealing information the
  human already saw is incoherent. Precedent exists (undo is already refused on
  timed games and Duck).

### Hub (live path)

- `variant.State` implementation + cases in `New` / `SelfSearches` /
  `SelfSearchMove`, and `normalizeVariant` in `protocol.go`. `Status()` reports the
  king-capture win, like Duck's.
- **Split `snapshot()` per viewer** and replace `broadcast` with a per-side send for
  this variant, per the table above. Premoves are unaffected: the client matches a
  queued premove against the `legalMoves` on the message where it becomes its turn
  (`useBoardInteraction.ts:156`), and that message is its own.
- A designation phase before the clocks start; the 30s `firstMoveTimeout` abort is
  the pattern to copy.
- `refreshLive` keeps the **full** FEN — server-side only.
- `History()` returns real repetition keys (unlike Duck, which has none).
- Own rating pool, consistent with the other three: `rating_secretqueen` on `User`,
  an arm in `GameResultController::categoryFor`, leaderboard entry, iOS
  `RatingCategory`.

### Frontend + iOS (both — the app is full parity)

- Designation screen: your eight pawns, click one, confirm. Simultaneous, timed in
  live play.
- **The badge (rule 6).** A queen mark on your own secret pawn, from designation
  until reveal. It has to read on all 16 board palettes × 7 piece sets
  (`lib/boardTheme.ts`, `Theme/BoardTheme.swift`) and at phone board sizes, which is
  the real constraint — it wants to be part of the piece rendering, not a floating
  overlay, so it scales and flips with the board.
- **The reveal is the variant's moment**: the pawn becomes queen artwork for both
  players, with its own sound and a one-shot animation, a line in the move list, and
  a plain-words toast for the opponent — "Black's e-pawn was a secret queen". The
  ambush (queen takes king) is the loudest version of that and deserves its own
  end-screen line.
- `variantHasCheck` → **false**, like Duck. No check glow, ever.
- Lobby: quick pool (3+0, matching Crazyhouse/Antichess) in `pages/home/parts.tsx`,
  entries in `lib/variants.ts` + `Models/Variant.swift`, `/bot` setup card.

### Out of scope for v1

Analysis, `/analyze-game`, PGN import, Tutor. A reveal move is not a legal standard
move, so the standard analyzer chokes on it; Duck and Antichess each needed their
own analyze controller and this one can wait. PGN **export** is cheap and worth
doing: `[Variant "Secret Queen"]` + `[SecretQueens "e2,h7"]` headers, normal SAN
throughout (once revealed it's a queen, so queen SAN with ordinary disambiguation is
correct).

## Order

1. zugzwang rules module + perft. Nothing else is trustworthy until this is.
2. `/secretqueen/*` endpoints + the bot.
3. BaseAPI `/bot` path end to end, web UI only. **Shippable on its own** — the whole
   variant minus the multi-viewer problem, and where the rules get playtested.
4. Hub: per-viewer snapshot + designation phase, with tests asserting a spectator's
   and the opponent's payloads never contain a hidden square or a queen move from
   it.
5. iOS.

## Sources

- Hidden Queen Chess rules — <https://www.phantomchess.in/hqchessgame>
- Lichess forum, variant announcement + `dames-cachees` —
  <https://lichess.org/forum/general-chess-discussion/new-online-chess-variant--hidden-queen->
- <https://github.com/orieuxe/dames-cachees>
- Lichess team "Secret Queen chess to be implemented as a variant" —
  <https://lichess.org/team/secret-queen-chess-to-be-implemented-as-a-variant-in-liches>
