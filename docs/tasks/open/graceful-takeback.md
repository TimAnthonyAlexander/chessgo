# Graceful takeback (mouseslip window, casual only)

**Gap.** Chess.com forbids takebacks in rated live play outright and has no
mouseslip grace window at all — a misclick just stands. Lichess only exposes a
static preference (never / casual only / always) that either side can veto for
any reason; there's no "the game auto-corrects an obvious slip within a few
seconds" mode on either site. We already ship consensual takebacks (see below)
— this is a narrower, faster variant of what we have, not a new primitive.

## What exists today

The hub already has a full consensual-takeback flow, so this is an extension,
not new plumbing:

- `gomachine/internal/hub/protocol.go`: message types `takebackOffer`,
  `takebackAccept`, `takebackDecline` alongside the draw-offer trio.
- `gomachine/internal/hub/game.go`: `game` struct carries `takebackPending bool`
  and `takebackBy chess.Color` (same shape as `drawPending`/`drawBy`). Cleared
  by `clearOffers()` on any committed move.
- `gomachine/internal/hub/hub.go:507-592`: `takebackOffer`/`takebackAccept`/
  `takebackDecline` handlers. Accept calls `applyTakeback` (hub.go:594-611),
  which calls `g.rebuildTo(target)` (game.go:296-316) — replays moves from
  `startFen` up to the target ply. Broadcast only to the two seated clients via
  `broadcastPlayers`.
- **Clock gap that must be closed**: `rebuildTo`'s comment at game.go:298 says
  clocks are "intentionally left as-is (takeback is consensual); the turn timer
  restarts." That's wrong for a graceful takeback and arguably wrong for the
  existing one too — a rolled-back move must refund the time it cost. Fix
  needed regardless: snapshot `clockMs[side]` and `turnStart` immediately before
  `applyMove` deducts (game.go:231-256), and on rollback restore the snapshot
  for every ply being undone, not just reset `turnStart`.
- Frontend: `frontend/src/lib/socket.ts` already has `OfferState = 'mine' |
  'theirs' | null`, `takebackOffer` in `LiveGameState`, and
  `offerTakeback()/respondTakeback()/cancelTakeback()`. `LiveGame.tsx:567-636`
  renders the offer as an `OfferBanner` (defined ~line 1138) identical in shape
  to the draw banner.
- `frontend/src/lib/settings.ts`: `Prefs` interface + `DEFAULTS` + `sanitize()`
  is where a new preference goes (pattern: `confirmResign: boolean` at line 56
  is the closest analog — one field, one default, one `bool()` line).

## Design

**Trigger.** A "graceful takeback" is not a manual offer-then-wait-for-response
flow — it auto-resolves. The moving player has a button, "Take back that move"
(or a keyboard shortcut), that's only enabled for **5 seconds after their own
move lands** (server-timestamped from `turnStart`/move-commit time, not client
clock — the client shows a shrinking ring but the hub is the timer authority so
a laggy client can't extend the window). Pressing it:

1. If the opponent has **not yet moved and not yet premoved**: auto-executes
   immediately, no opponent action required, no offer round-trip. This is the
   "mouseslip" case chess.com and Lichess both fail — silently give it back.
2. If the opponent has **already replied**: the button doesn't fire the old
   "offer and hope" flow. Show it as unavailable ("too late — ask instead") and
   fall back to the existing manual `takebackOffer` (needs their consent, no
   time limit). Don't blur the two mechanisms — a 5-second auto-grant window
   that also works retroactively invites abuse (see below).
3. If the opponent has **premoved** (queued a reply but not yet had their
   turn): the premove is for a position that's about to change. Per
   `useBoardInteraction.ts`'s existing rule (whole chain drops on the first
   illegal head), the rolled-back position will very likely make the queued
   premove's `from` square wrong or the move itself illegal, so it silently
   drops — same behavior as any other illegal-premove case, no special code
   needed. Document this as expected, not a bug: the UX message on takeback
   should say "your opponent's queued move was cleared," client-side, driven
   off the existing "chain collapsed" signal.

**Cap.** Hard-capped **once per player per game** for the auto-grant path (the
5-second one). The manual ask-and-consent path (existing `takebackOffer`) keeps
whatever cap it has today if any — check `hub.go` for an existing per-game
counter; if none exists, add one there too, since serial "sorry, again" offers
are the same stalling vector either way. A single per-player counter on the
`game` struct (`graceTakebacksUsed [2]int`, indexed by `chess.Color`) is enough;
no persistence needed since it's scoped to one in-memory game.

**Rated games.** Untouched — gate the whole feature on `g.rated == false` at
the top of the new handler, mirroring the existing `if g.rated { return }`
pattern used elsewhere in the hub for casual-only behavior. Rated play keeps
exactly what it has today (nothing, per chess.com's own stance — this doesn't
change that).

**Clock.** The refund is the same fix the existing manual takeback needs: the
moving player gets back the time their reverted move cost (elapsed since
`turnStart`, minus any increment already credited); the opponent's clock is
untouched since they never got a turn in the auto-grant case. Because the
auto-grant path only ever unwinds exactly one ply, this is simpler than the
general `rebuildTo` case — no loop, just "undo the last `applyMove`'s clock
delta and restore `turnStart` to its prior value."

## Where (files)

- `gomachine/internal/hub/protocol.go` — new message type, e.g.
  `graceTakeback` (single-shot, no offer/accept split since it doesn't need
  consent when the window condition holds).
- `gomachine/internal/hub/game.go` — `graceTakebacksUsed [2]int` on `game`;
  extend the clock-snapshot fix described above; a `canGraceTakeback(color)
  bool` helper checking rated==false, cap not spent, within 5s of `turnStart`,
  and opponent hasn't moved.
- `gomachine/internal/hub/hub.go` — new handler near the existing takeback
  trio (~line 507-592); reject with a clear reason code if the window has
  closed or the opponent already replied, so the frontend can fall back to the
  manual-offer UI without a special round trip.
- `frontend/src/lib/socket.ts` — new outgoing message + `graceTakebackWindow`
  (countdown deadline, or null) in `LiveGameState`; server-timestamped so a
  clock-skewed client can't fake extra time.
- `frontend/src/pages/LiveGame.tsx` — a small always-visible "Take back"
  control (not a banner needing opponent response) shown for 5 seconds after
  your own move, replaced by nothing once expired or once the opponent moves.
- `frontend/src/lib/settings.ts` — one new preference,
  `gracefulTakeback: boolean` (default `true`), following the exact
  `confirmResign` pattern: one `Prefs` field, one `DEFAULTS` entry, one
  `bool('gracefulTakeback')` line in `sanitize()`. This only gates whether the
  UI *offers* the button — the hub still enforces cap/window/rated
  server-side regardless of what the client sends.

## Data / schema

None. This is entirely in-memory hub state (`game` struct fields), same as
existing draw/takeback offers — no BaseAPI model or migration involved. If a
future task wants to log graceful-takeback usage for abuse monitoring, that
would be a new BaseAPI table (e.g. `graceful_takeback_log`, singular
snake_case per house convention) written from the hub's persistence webhook
(`POST /internal/games`) — out of scope here; note it as an open question
rather than build it speculatively.

## Abuse / failure modes

- **Serial takeback pestering**: closed by the one-per-player-per-game cap on
  the auto-grant path. The manual ask-and-consent path is opponent-gated by
  definition (they can just decline), so no additional cap is strictly needed
  there, but check if one already exists and note it if so.
- **Stalling via the 5-second window**: the window is tied to server
  `turnStart`, not "time since I clicked a button," so a player can't hold the
  window open by refusing to act — either they use it within 5s of their move
  or it's gone. Doesn't add clock time back to the opponent, so it can't be
  used to burn their clock either.
- **Sniping a winning premove**: if a player takes back specifically because
  the opponent premoved a strong reply, the premove drops (see design above) —
  this is a real incentive to "peek and un-move," but it's symmetric (either
  side can do it once) and bounded to one use, so the ceiling on the exploit is
  low. Worth a note in release copy ("your opponent may take back once early
  in a casual game — this also clears any premove you queued") so it isn't a
  surprise.
- **Race with the opponent's move landing**: the hub must treat "opponent's
  move commit" and "my grace-takeback request" as ordered by arrival at the
  hub (whichever message the single-threaded game loop processes first wins) —
  no special locking needed beyond the existing per-game message serialization,
  but call this out in the PR since it's the one place a timing bug would be
  visible to users (a takeback that "succeeds" after the opponent already
  moved would be a real bug, not a race that's fine to lose).

## How we'd know it works

- Manual test: two casual clients, White moves, immediately clicks take-back —
  move reverts, White's clock shows the pre-move remaining time, side-to-move
  flips back to White, cap counter shows 1 used.
- Manual test: White moves, waits 6 seconds, take-back control is gone/disabled.
- Manual test: White moves, Black premoves a reply, White takes back within the
  window — Black's queued premove is cleared and the UI explains why.
- Manual test: rated game — no take-back control renders at all; a raw WS
  message (`graceTakeback`) sent to a rated game is rejected server-side, not
  just hidden client-side (defense in depth — never trust the client to gate a
  rules distinction).
- Manual test: use the cap twice in one game — second attempt is rejected with
  a clear reason, first one already having succeeded.
