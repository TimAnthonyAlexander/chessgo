# Secret Queen — a hidden-information variant for `/bot` and live play

Each player secretly designates one of their eight pawns. It is a queen, and it
plays like one, but to the opponent it looks like a pawn until it moves like a
queen.

Variant id `secretqueen`, label "Secret Queen". Reachable from `/bot` and from
live play (quick pool + challenge links), like Duck/Crazyhouse/Antichess.

We follow the **phantomchess.in "Hidden Queen Chess"** ruleset — the most concrete
published version of this variant (same variant as the `dames-cachees`
implementation announced on the Lichess forum). Sources at the bottom.

## Designation is a board step, not a form field

The first attempt put an a–h dropdown on the setup screen. That is not the
feature. Pressing "Start game" on this variant now drops into a pre-game step
where you **click one of your own pawns on the real board** and confirm:

- the board shows the standard array oriented to your side, your eight home-rank
  pawns lift and carry a halo (`.sq.pickable`), everything else recedes
  (`.sq.dimmed`);
- clicking one rings it and puts the crown badge on it immediately, so you see
  exactly what you are committing to;
- a ribbon over the board tracks the state ("Pick one of your pawns" →
  "c2 is your queen — or pick another"), and the side panel's button becomes
  "Start game with c2". "Surprise me" and "Back" sit under it;
- no eval bar during the step — there is no game to evaluate yet.

The game is not created until you confirm, so the whole step is client-side and
free. `Board` grew `pickTargets`/`onPick`, mirroring `duckTargets`/`onPlaceDuck`
— the player is choosing a SQUARE, not making a move, so it must not touch the
move machinery.

## Two bugs the first pass shipped, both found by playing it

**`null is not an object (evaluating 'rev.square[0]')`.** Every move carries a
`reveal` object, all-false on ordinary moves, so `moves.find(m => m.reveal)`
matched the first move of the game and then read a null `square`. The guard now
tests `moved || captured || promoted`. The same function also read `rev.moved` as
a colour when it is a boolean, so every reveal was attributed to Black; the side
now comes from the move's `by` plus the human's colour — and for a CAPTURE
reveal it is the victim's queen, not the mover's. It also named the pawn by the
reveal square, which is the DESTINATION: a queen sliding e4→h4 was announced as
"the h-pawn". It uses the move's origin now.

**The reveal appeared a move late.** A bot game applies your move and the bot's
reply in one request, so your own queen sat there as a pawn until your opponent
had already moved. The board now flips it the instant you commit, via
`isPawnShapedMove` (display-only, in `lib/variants.ts`) folded into the
optimistic overlay; the server's FEN replaces it when it lands and remains the
authority. The badge disappears in the same frame.

Verified by driving the real page in a headless browser: badge follows a
pawn-shaped move and the piece stays a pawn; a queen-only move shows a queen on
the destination **before** the bot replies; the note reads "White's e-pawn was a
secret queen." and clears itself; no console errors.

## Live play (step 4) — done, with one gap

**Hub.** `internal/variant/secretqueen.go` is the first `State` whose rules live
out of process: it calls zugzwang's `/secretqueen/*` over HTTP rather than
porting the ruleset into Go a second time. That is deliberate and the header
argues it — two implementations of a *hidden-information* ruleset that drift
don't just produce a wrong move, they can produce a right-looking move for the
wrong reason and hand a player information no legal inference should give them.

The cost was measured rather than left as a worry: `/secretqueen/move` and
`/legal-moves` answer in ~0.15ms median / 0.21ms p95 on localhost, so a live move
blocks the hub's mutation goroutine for ~0.3ms — far below the other per-move
work it already does, which is why this stayed synchronous instead of growing a
result channel (that would make every call site reading `g.state` after
`applyMove` wait on one, a real architecture change bought for a third of a
millisecond). The bound that does matter is the HTTP timeout, tightened to 250ms
— still ~1000x the measured p95, so it cannot trip on a healthy engine, and it
caps what other games feel if zugzwang ever answers slowly.

`game.go` gained `snapshotFor` — the per-viewer counterpart of `snapshot()` —
plus `hiddenState()` as the single switch that decides which path a variant
takes. Each player gets only their own `secretSquare`, and `legalMoves` only when
it is their move; spectators get neither; once the game is over everyone gets
both squares.

**The test that was missing.** `internal/hub/secretqueen_test.go` asserts the
split by marshalling each recipient's actual wire message and searching the JSON
for the forbidden square — bytes, not named fields, so it catches a leak through
a field nobody thought of, including one added later. That is the realistic
regression. It was mutation-tested: adding a leaking field to
`secretQueenViewerFields` makes it fail with the offending payload printed, and
removing it makes it pass again.

**Web.** `lib/socket.ts` carries the per-viewer fields (`secretSquare`,
`needsDesignation`, `designationDeadline`, `secretSquares`, `reveal`) and a
`designate(square)` sender. `LiveGame.tsx` reuses the same board-based
designation as `/bot` — the two pages share
`components/SecretQueenDesignation.tsx` rather than owning a copy each; live play
passes a deadline and omits "Back" (once paired there is nothing to go back to).
Lobby quick pool (3+0, its own cell with the `rating_secretqueen` range), the
friend-challenge allowlist, reveal narration, and the analysis/admin-probe
exclusions are all wired.

**The gap:** live play has not been exercised end to end with two real clients.
That needs a hub restart on the owner's machine, so the verification here is the
payload-level unit tests plus a clean typecheck/build — not a played game.

## Build status

**Steps 1 and 2 are done** (see Order at the bottom). The engine owns the rules
and can play the variant end to end:

- `zugzwang/src/secretqueen.{h,cpp}` — rules, movegen, apply, status, SAN, perft.
  Deliberately net-free (no Position/Search/NNUE), which is what lets the gate
  below run without a net file.
- `zugzwang/test/secretqueen_test.cpp` (+ `_stubs.cpp`) — `make secretqueen_test`.
  Green. Cross-checks generator AND apply against Duck's independent
  implementation of the same no-check/king-capture ruleset out to perft(4), then
  asserts the hidden-queen rules Duck cannot see.
- `zugzwang/src/secretqueen_bot.{h,cpp}` — the bot, reusing the real NNUE search
  (see that header for why the substitution is sound), plus a **concealment
  veto**: the evaluation cannot see that hiding is worth anything, so a move that
  would unmask the queen has to beat the best concealing move by 150cp. Without
  it the bot revealed as early as ply 1 and the variant evaporated; with it the
  earliest reveal is ply 7, the typical one moved from ~ply 15 to ply 26, and
  games regularly end with a side still hidden. It needed `Rating::rank_root_moves`
  (the ladder's own MultiPV ranking pass, previously file-private) — exposed
  rather than reimplemented, because a second copy of the selection maths is
  exactly how one defect ends up living in four places.
- `POST /secretqueen/{designate,legal-moves,move,bestmove}` in
  `serve_handlers.cpp` + `serve.cpp`. Every response carries the canonical FEN
  plus the three redacted views.

Smoke-tested over HTTP: redaction produces the right three views, a pawn-shaped
move keeps the disguise, a queen-only move reveals and puts a real queen on the
board, an illegal move 400s, the bot takes an exposed king at every rating, and
each side's eval reflects its own information set (it sees its own hidden queen,
not the opponent's).

**Self-play harness** (bot vs bot over the live endpoints, ~8 full games) asserts
on every ply that the returned move is in that position's own legal list, that a
secret never comes back once spent, that a reveal really puts a queen on the
board, and that no view ever names the other side's secret. All green.

One assertion in it was worth the trouble twice over: "the bot must never lose
its king to a piece it can SEE". It fired five times, and every one was a false
alarm — a chess-checkmated position, which in this variant means the king falls
next move whatever you play (the extra moves chess forbids are exactly the ones
that leave your own king attacked, so none of them help). The check now has to
prove counterfactually that some alternative move would actually have saved the
king. Worth recording so nobody "fixes" the bot over it later.

Perft note: perft(4) from the start is **197742**, not chess's 197281. The first
check is reachable at ply 3 and this variant has no check, so continuations that
are illegal in chess are legal here. The number is cross-checked against Duck's
generator rather than blessed from our own output.

Next: step 3, the BaseAPI `/bot` path.

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

## iOS (step 5) — done

`Chess/SecretQueen.swift` carries the Swift counterparts of the web helpers
(`homeRankSquares`, `isPawnShaped`, `revealMessage`), and the same three
behaviours are ported: designation is a board step (`BoardView` gained
`pickTargets`/`onPick`, kept entirely separate from move submission), the badge
rides on the piece, and the reveal is optimistic so your own queen appears the
frame you commit rather than after the bot answers. `RevealInfo.didReveal` guards
the all-false-reveal trap that crashed the web client, and `moved` is typed as
the `Bool` it actually is.

Verified by whole-module `swiftc -typecheck` over all 117 files: the only errors
are 4 pre-existing actor-isolation ones in `BoardView.swift`, confirmed identical
on clean HEAD (an artifact of typechecking outside Xcode's project settings, not
of this work). **Not verified without a device build:** on-screen layout and
contrast of the ribbon, halo and picked-ring across the 16 palettes.

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
