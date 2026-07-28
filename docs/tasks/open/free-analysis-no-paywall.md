# Free full-depth analysis (say so, honestly, where it matters)

**Gap.** Chess.com paywalls Game Review — roughly one full-depth review per
day for free accounts, reported repeatedly as the loudest complaint category
on chess.com's own forums and the most-cited reason people name Lichess as an
alternative. We already give full-depth analysis away for every game, every
time, to anyone, logged in or not — and we say so nowhere. This is a
product/UI task: state the fact, make the depth visible and checkable, and do
it without marketing filler or naming competitors disparagingly.

## What we actually give away (the honest baseline)

- `routes/api.php`: `POST /analyze` has `RateLimitMiddleware => ['limit' =>
  '1200/1m']` and the surrounding comment states the real policy in plain
  terms: "`SessionStartMiddleware` is optional-auth here... anonymous callers
  still analyze freely." No daily cap, no login wall, no per-review counter
  anywhere in the route stack (`/duck/analyze`, `/antichess/analyze` are the
  same shape, all `1200/1m`; `/sf-analyze` is tighter at `300/1m` because it
  spawns a Stockfish process per call, an infra cost reason, not a monetization
  one).
- `frontend/src/pages/Analysis.tsx`: `ANALYSIS_LADDER` (lines 82-93) is the
  real, currently-shipped progressive-deepening schedule the eval bar and PV
  climb through as you sit on a position — depth 6 at ~1.2s ceiling, up through
  depth 30 at a ~35s ceiling (`{ depth: 30, ceilingMs: 35000 }` is the deepest
  rung). `docs/SPEC.md`'s Analysis section undersells this at "streaming to
  ~depth 22" — the ladder in code goes to depth 30; the doc is stale, not the
  code, so this task should also correct that line in `docs/SPEC.md`.
  Full-game review (accuracy table, per-move judgments) is the same engine
  path, cached per game (`GameAnalysisService`), available to guests and
  accounts alike — there's no per-day counter gating repeated full reviews.
- No billing/subscription code exists anywhere in this codebase to check
  against — confirmed by search (`grep -ri stripe|subscription|premium|paywall
  app/ frontend/src`), the only two hits are unrelated (`STRIPE` is a CSS
  color constant name in `MoveTree.tsx`; `settings.ts` has an unrelated code
  comment using the word "subscription" in passing about local storage). There
  is genuinely nothing to work around — this is a true claim, not a technicality.

## Design

**Where to say it.** Three places, each doing a different job — don't try to
make one banner do all three:

1. **The analysis page itself, small and factual, not a banner.** Near the
   depth readout that already exists (`Analysis.tsx` ~line 1019-1039, the
   header showing the live `depth` value beside the wordmark) add a one-line,
   low-emphasis caption, not a badge or a callout box: something like "Full
   engine depth, every game, no account needed." This sits where the user is
   already looking at the depth number climbing — the claim and the proof are
   in the same eyeful, which is what makes it verifiable rather than an
   assertion to trust. No icon, no color highlight — the design rule here is
   "state a fact quietly," not "sell a feature."
2. **First-time full game review (post-game, from a live/bot game → "Analyze
   this game" flow).** A single dismissible line the first time someone opens
   a review, not every time: "This full review is free — dig as deep as you
   want." Store a `hasSeenAnalysisNotice` flag the same way other one-time UI
   states are handled in this codebase (check `settingsStore`/localStorage
   patterns already in `frontend/src/lib/settings.ts` for the convention —
   e.g. a boolean default `false`, flipped `true` on first dismissal,
   persisted in the same `chessgo.prefs` blob or a dedicated key if it
   shouldn't live inside `Prefs`'s sanitize/reset semantics). Never re-show it
   once dismissed.
3. **Nowhere else.** No homepage marketing banner, no signup-flow claim, no
   comparison table. The brief for this task is specifically to state a fact
   where a user is already looking at the thing being described, not to build
   a marketing surface that didn't exist before. If a homepage/marketing pass
   ever happens, this fact can feed it — but that's a different task and a
   different set of writing rules (this one is scoped to in-product UI only).

**Making depth verifiable, not just claimed.** The existing depth readout
(`Analysis.tsx` line ~1039, `{depth}`) already proves the claim live — no new
mechanism needed, just don't hide it. If a "how deep can I go" question is
worth answering explicitly, a hover tooltip on the depth number stating the
ladder's ceiling ("streams up to depth 30, further with a longer look") is
enough; don't build a separate depth-comparison chart against anyone else's
product — that tips into the "no fabricated comparison claims" ban even if
factually true, since we don't have their current numbers and they change
without notice.

**What to avoid, explicitly per the brief:**
- No fake urgency ("only 1 free review left" — we have no such limit, and
  even hinting at scarcity that doesn't exist is a lie by implication).
- No naming chess.com or Lichess by name in-product. The gap is real and the
  evidence is their own forums, but the shipped copy states our own fact
  ("free, full depth, every game") and lets the user's own prior experience
  supply the contrast. Naming a competitor to disparage their pricing model
  in our UI reads as marketing filler dressed as information, which is
  exactly what the writing rules ban.
- No invented numbers ("10x deeper than X" — we don't have their live specs
  and depth isn't even a comparable unit across different engines/hardware).
- No modal that blocks the analysis board to make the announcement — the
  entire point is that nothing is gated, so gating the *announcement itself*
  behind a click-through would be self-defeating.

## Copy (what I'd ship)

Analysis page caption (small, near the depth readout):

> Full engine depth. Every game. No account needed.

First-time review notice (dismissible, one-time):

> This review runs at full engine strength — no daily limit, no account
> required. Dig as deep as you want.

Depth tooltip (hover on the live depth number, optional):

> Streams deeper the longer you look — up to depth 30 on this board.

That's it — three short lines, no exclamation points, no "unlock" language,
nothing that needs a follow-up sentence to justify itself.

## Where (files)

- `frontend/src/pages/Analysis.tsx`: caption near the depth readout
  (~lines 993-1039, the header block); one-time notice component gated on a
  persisted flag, shown near the `Header`/accuracy area (~line 1221 onward,
  where review mode already renders).
- `frontend/src/lib/settings.ts`: if the one-time-notice flag belongs in the
  main `Prefs` blob, add `hasSeenAnalysisNotice: boolean` (default `false`)
  following the exact existing pattern (one `Prefs` field, one `DEFAULTS`
  entry, one `bool()` line in `sanitize()`) — or, if it shouldn't participate
  in `reset()` (a user resetting board prefs shouldn't re-trigger a notice
  they already dismissed), use a separate plain localStorage key instead,
  matching the precedent already set by the sound-enabled migration comment
  in this same file (a key can live outside the `Prefs` blob when it
  shouldn't be swept by `reset()`).
- `docs/SPEC.md`: correct the "streaming to ~depth 22" line (line ~76-77) to
  match the actual `ANALYSIS_LADDER` ceiling (depth 30) — a documentation fix
  riding along with this task since it's directly relevant to the claim being
  made in-product and the doc is simply out of date relative to code.
- No backend change. No new route, no new rate-limit tier, no new model — the
  free depth already exists; this task only makes it visible.

## Data / schema

None beyond the possible one-boolean UI-dismissal flag described above, which
is either a `Prefs` field (no migration, it's a frontend localStorage blob)
or a separate localStorage key — either way, no BaseAPI model, no migration.

## Abuse / failure modes

- **The claim becoming false later without the copy being updated** — if a
  future infra-cost decision adds a daily cap or an account requirement to
  `/analyze`, this in-product copy would then be a lie. Whoever makes that
  future change owns updating or removing this copy at the same time; note it
  here so it isn't missed silently (there's no automated check that can verify
  "this UI claim matches this rate-limit config" without deliberately building
  one, which is out of scope for a copy task).
- **Copy creep** — the temptation, once shipping "we're free," is to keep
  adding comparison lines or urgency language over time. The three lines above
  are the whole scope; resist expanding this into a marketing section without
  a separate, deliberate design pass under the site's actual design rules
  (one dominant idea, no stacked claims).

## How we'd know it works

- Load `/analysis` logged out — verify the depth caption renders and the live
  depth readout actually climbs to at least the ladder's stated ceiling on a
  quiet position (confirms the claim is true at the moment it's shown, not
  just written down).
- Open a full game review for the first time (fresh browser profile / cleared
  localStorage) — verify the one-time notice shows once, dismiss it, reload —
  verify it does not reappear.
- Confirm no copy anywhere names a competitor or implies a countdown/limit
  that doesn't exist in the route config.
- Confirm `docs/SPEC.md`'s analysis section now states depth 30, matching
  `ANALYSIS_LADDER` in code, not the stale ~22 figure.
