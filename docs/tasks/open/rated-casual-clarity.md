# Rated/casual clarity (UI only, no rules change)

**Gap.** "Accidentally played a rated game" is a real support-ticket category
on chess.com, where the rated flag is a persistent global toggle that's easy
to misread or forget you set. This task is explicitly **UI/clarity, not a
rules change** — nothing about matchmaking eligibility, Elo, or when a game is
rated-eligible changes. The problem is purely: does the player know, at every
point from lobby to game end, whether this game counts?

## What exists today

Research finding, stated plainly: **quick pairing (the main lobby "play now"
flow) has no rated/casual affordance or preview at all before you're in a
game.** The only place a player makes an explicit rated/casual choice is the
friend-challenge dialog.

- `frontend/src/pages/Home.tsx` / `HomeMobile.tsx` are thin layout wrappers
  around `useHome()` / `QuickPairingPanel` / `PlayBar` / `PlayPanel` in
  `frontend/src/pages/home/parts.tsx`. `QuickPairingPanel`'s `onQueue(label,
  pool, variant?)` and `useHome`'s `queue = (label, pool, variant) =>
  gameSocket.queue(pool, variant)` never pass or show a `rated` value —
  there's no switch, chip, or even static label anywhere in quick pairing.
  `gameSocket.queue(pool, variant)` sends `{ type: 'queue', pool, variant }`
  over the socket — no `rated` field in the request at all. Rated-ness is
  decided entirely server-side and is invisible until the game itself starts.
- Backend: `routes/api.php`'s `/ws-ticket` route runs
  `SessionStartMiddleware → OptionalAuthMiddleware → RateLimitMiddleware →
  WsTicketController`. `app/Middleware/OptionalAuthMiddleware.php` never
  rejects — it attaches `$request->user` if session/bearer auth succeeds,
  otherwise leaves the request anonymous (its docblock: "a logged-in bearer
  client gets a rated ticket, an anonymous client gets a casual one").
  `WsTicketController::get()` builds an `$identity` with `'anon' => false`
  (logged in, per-category ratings attached) or `'anon' => true` (guest,
  rating 0, synthetic `anon-<hex>` subject). There's no literal `rated`
  boolean minted at this layer — **the real rule is: guest → casual-only,
  logged in → rated-eligible for quick pairing**, decided purely by whether
  you're signed in, with zero user choice or preview involved.
- `frontend/src/components/ChallengeDialog.tsx` is the only place with a real
  toggle: `const [rated, setRated] = useState(true)` (line 40),
  `effectiveRated = loggedIn && rated` (line 65). UI: two `Chip`s ("Casual" /
  "Rated", lines 265-279) — the Rated chip is `disabled={!loggedIn}` with
  helper text "Log in to play rated" when logged out. This state is local to
  the dialog (resets every time it's opened) and not persisted anywhere.
  `create()` sends `{ type: 'createChallenge', pool, color, rated, variant }`.
- `frontend/src/components/LiveModeCard.tsx` takes `rated: boolean` as a
  required prop and renders a small label, "Rated" or "Casual" (line 45) —
  purely a display component, correctly reflects whatever it's told, but it's
  only ever shown once you're already in a game (`LiveGame.tsx` renders it in
  the sidebar, hidden in zen mode).
- **In-game**: `LiveGame.tsx` does show a persistent badge — line ~467-484, a
  header-row chip reading "Rated"/"Casual", accent-colored when rated, dimmed
  when casual, and this one is **not** hidden by zen mode (only the
  `LiveModeCard` copy in the sidebar is). So once a game exists, the state is
  visible and doesn't disappear — the gap is entirely pre-game.
- **Game end**: also handled correctly today — `LiveGame.tsx` (lines
  ~651-687) shows the result text plus, only `if (g.rated && ratingDelta...)`,
  the new rating and signed delta (green/red). Casual games show only the
  result, no rating line. This is already unambiguous; no change needed here.

## Design

Ground rule: **never widen or narrow who is actually rated-eligible as part
of this task** — that's the guest/logged-in split already enforced server-side
and it stays exactly as is. Everything below is making the *existing* state
legible, not changing it.

**1. Lobby — before queueing.** Quick pairing currently shows nothing. Add a
static, always-visible line near the queue button reflecting the real rule
rather than a fake choice: logged-in users see "Rated" (since that's what
quick pairing gives them) with a small note that guests always play casual;
guests see "Casual — log in for rated games." This is not a toggle — quick
pairing has never offered a choice, and adding a fake one that quietly gets
overridden server-side (like the challenge dialog's `disabled` Rated chip
already avoids) would recreate exactly the "misread a toggle" failure this
task exists to fix. If quick pairing ever wants to offer real rated/casual
choice for logged-in users, that's a separate feature decision — flag it as an
open question here rather than deciding it as a side effect of a clarity pass.
- Files: `frontend/src/pages/home/parts.tsx` (`QuickPairingPanel`), read
  `useAuth()`'s logged-in state (already used elsewhere in the app, e.g.
  `ChallengeDialog.tsx`'s `loggedIn` check) to pick the static label.

**2. Challenge dialog — at the moment of choice.** This one already has a real
toggle and already disables Rated for guests with helper text — keep the
mechanism, tighten the visual weight: the two-chip layout
(`ChallengeDialog.tsx` lines 265-279) should make the selected state louder
than the alternative (stronger contrast/fill on the active chip, not just a
subtle style difference) since this is the one moment a genuine choice is
being made and a color-blind-adjacent easy misread here is exactly the bug
class chess.com's support tickets describe. No structural change — a styling
pass on the existing chips plus, right above the "Create" button, one line of
confirmation text that restates the choice in words ("Creating a **rated**
challenge" / "Creating a **casual** challenge") so the last thing the user
reads before committing is unambiguous prose, not just a chip's fill color.

**3. Matchmaking pending state.** Between clicking "play" and the game
starting, if there's any visible "searching for opponent..." state (check
`PlayBar`/`PlayPanel` in `parts.tsx`), it should carry the same static
rated/casual label from step 1 forward, so there's no gap between "what I
was told before queueing" and "what I'm told once matched."

**4. In-game.** Already correct (the header badge). No change beyond
confirming it stays visible in every layout including mobile — check
`HomeMobile.tsx`'s live-game equivalent renders the same badge, not a
mobile-trimmed variant that drops it for space.

**5. Game end.** Already correct. No change.

**6. Mobile specifically.** Since `HomeMobile.tsx` is a distinct layout (not
just a responsive breakpoint of `Home.tsx`), verify steps 1-3 are applied to
both files, not just the desktop one — this is exactly the kind of thing that
silently regresses on mobile if only one file gets touched. Both files must be
edited together or the gap just moves from "guests are unaware" to "mobile
users are unaware."

## Where (files)

- `frontend/src/pages/home/parts.tsx` (`QuickPairingPanel`,
  `PlayBar`/`PlayPanel`): add the static rated/casual label near the queue
  action, sourced from `useAuth()`.
- `frontend/src/pages/Home.tsx`, `frontend/src/pages/HomeMobile.tsx`: confirm
  both render the updated `parts.tsx` components (no separate duplicated
  markup to update twice, if they already share the same underlying
  components — verify this rather than assume it).
- `frontend/src/components/ChallengeDialog.tsx`: chip contrast pass (lines
  ~265-279) + confirmation line above the "Create" button (near line 92's
  `create()`).
- `frontend/src/components/LiveModeCard.tsx`: no functional change — already
  correct, just confirm it's not dropped from the mobile in-game layout.
- No backend change — `app/Middleware/OptionalAuthMiddleware.php` and the
  `/ws-ticket` route logic are correct and untouched; this task is UI-only per
  the brief.

## Data / schema

None. No new model, no migration — this is copy and layout only, reading
state (`useAuth()`, `game.rated`) that already exists.

## Abuse / failure modes

Not really an abuse surface since nothing about eligibility changes — the
failure mode this task targets is entirely "a real person is surprised by a
game's rated status," which is a support-cost problem, not a security one. The
one thing to get right defensively: **never let the new lobby-level label
imply a choice that doesn't exist.** If the wording is sloppy ("Rated
matchmaking" with a toggle-looking chip that isn't actually wired to anything)
it recreates the exact confusion it's meant to fix — worse, actually, since it
would look interactive without being interactive. Keep the quick-pairing
label plainly informational (no chip, no switch styling) and reserve
chip/toggle affordances for the one place a real choice exists
(`ChallengeDialog`).

## How we'd know it works

- Log out, visit the lobby — verify the quick-pairing area states "Casual"
  plainly, with no interactive control implying otherwise.
- Log in, visit the lobby — verify it states "Rated," and queueing produces a
  game whose in-game badge and eventual rating delta match that expectation.
- Open the challenge dialog logged out — verify Rated is visibly disabled
  (not just grayed 5%) with the existing helper text, and the confirmation
  line above Create reads "Creating a casual challenge."
- Open the challenge dialog logged in, toggle to Rated, verify the
  confirmation line updates before you click Create (not after).
- Repeat all of the above on `HomeMobile.tsx`'s layout, not just desktop.
- Play a casual game to completion — verify no rating-change line appears
  (already correct today; regression-guard it).
