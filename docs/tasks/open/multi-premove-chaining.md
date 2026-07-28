# Multi-premove chaining (queue depth, UX polish)

**Gap.** Chess.com queues up to 5 premoves. Lichess supports only one and it's
a long-standing open issue (lila#14699). **We already have unbounded chaining
client-side** — this task is not "build chaining," it's "cap it, make illegal-
head behavior a deliberate decision instead of an accident, and give it a
visible queue UI," none of which exist today.

## What exists today

`frontend/src/lib/useBoardInteraction.ts` already holds premoves as an
**ordered array**, not a single value:

- State: `const [premoves, setPremoves] = useState<Array<Move & { uci: string
  }>>([])` (line 68).
- **Queueing** (`onMove`, lines 103-116): if it's your turn, play now and clear
  the queue; else, if premoves are enabled, append —
  `setPremoves((prev) => [...prev, { from, to, uci }])`. No length check —
  today you can queue 20 moves if you want.
- **Cancel all** (`cancelPremove`, line 120): `() => setPremoves([])` — clears
  the whole chain at once. `Board.tsx` calls this on click-elsewhere. There is
  no cancel-one gesture.
- **Execution** (effect, lines 152-164): on your turn, take the head,
  `const [head, ...rest] = premoves`, match `head.uci` against `legalMoves`
  (from/to only, ignoring promotion piece):
  - Legal → `setPremoves(rest); executeMove(match)` — play it, keep the tail
    queued.
  - **Illegal → `setPremoves([])`** — the *entire remaining chain* is silently
    dropped, no toast, no error. Comment in the code says "the WHOLE chain
    collapses."
- **Visual**: `Board.tsx` (line 698) marks every square that's a premove
  `from`/`to` with a `.premove` CSS class (`--premove` color,
  `rgba(229,116,92,0.5)`, defined in `styles.css`/`siteTheme.ts`); separately,
  `useBoardInteraction`'s `override`/`premoveBoard` state (lines 128-133)
  re-renders pieces sitting on their queued destination squares, folding each
  queued move onto the previous — chess.com-style ghost position — via
  `applyUciVisually`. There's currently **no per-move numbering** — you can
  see where pieces end up, but not "this is premove #2 of 3" if two queued
  moves touch overlapping squares.
- Transport: no premove-specific WS message. `frontend/src/lib/socket.ts`
  sends a plain `{ type: 'move', move: uci }` the instant `executeMove` fires
  — indistinguishable from an instant human move. The hub
  (`gomachine/internal/hub/*.go`) has **zero** premove awareness (`grep -rn
  premove` → no matches) — it only ever sees normal `move` messages timed to
  the player's turn. This means there is no per-premove clock cost today and
  none is needed: a premove executes the instant your turn starts, same as a
  fast human move, so it's charged whatever your normal move-to-move clock
  cost would be — nothing extra, nothing special to build server-side.
- `frontend/src/lib/settings.ts`: `premoves: boolean` in `Prefs` (default
  `true`), a plain on/off toggle wired to a checkbox in `ThemeDialog.tsx`.
  There's no "max queue depth" setting.
- **Crazyhouse**: drops go through a separate hook
  (`frontend/src/lib/useCrazyhouseDrops.ts`), submitted as `"<P>@<sq>"` through
  the same transport, explicitly documented as having no premove support
  ("There is no drag/premove here").
- **Duck**: a fully separate two-phase controller
  (`frontend/src/lib/useDuckInteraction.ts`) — piece move then duck placement,
  neither sharing `useBoardInteraction`'s premove state, explicitly documented
  as having no premove support ("a duck turn has two clicks and no queued
  equivalent"). `LiveGame.tsx`/`BotGame.tsx` already gate the premove UI off
  entirely for duck games.

## Design

**Queue depth cap: 5**, matching chess.com's ceiling (a round number that's
already the competitive reference point, and long enough that a 6th premove is
almost never a real plan rather than idle clicking). Enforce it where premoves
are appended in `onMove` — once `premoves.length === 5`, further premove
attempts are simply ignored (no queue-full error toast; a rejected click
should feel like nothing happened, not like a failure state, since the user's
existing plan is still intact and un-harmed).

**Illegal-head behavior: keep "whole chain drops," but make it visible.**
This needs an explicit decision because it's the one place this feature can
silently confuse a player mid-blitz-game. Two options:

- *Drop only the illegal head, try the next one* — tempting, because it looks
  "smarter," but it's wrong for chained plans: premove #2 in a queue is almost
  always conditioned on premove #1 having happened (e.g. "recapture on the
  square I'm about to trade on"). If #1 turns out illegal because the opponent
  played something else, #2 is very likely aimed at a square/piece
  configuration that no longer exists either. Silently trying #2 anyway risks
  firing a move the player never actually wanted in the resulting position.
- **Drop the whole tail (current behavior) — keep it**, because it's the safe
  default: a bad premove queue disappears entirely rather than executing an
  unintended move for a real reason (chained premoves are dependency chains,
  not independent alternatives). The gap isn't the behavior, it's that it's
  currently silent. Add: a brief, dismiss-on-its-own toast/banner ("premove
  queue cleared — [opponent's move] wasn't expected") the moment the chain
  collapses, so a blitz player knows *why* their planned sequence vanished
  instead of wondering if a click didn't register. This is a pure UI addition
  at the point `setPremoves([])` fires in the execution effect — surface a
  one-shot transient message alongside it.

**Cancel gestures.**
- **Cancel all** already exists (click elsewhere) — keep it.
- **Add cancel-one**: right-click (or long-press on touch) on a specific
  queued move's destination square removes just that move and everything
  queued *after* it in the chain (not before — later premoves may depend on
  earlier ones, per the dependency reasoning above, but not vice versa: moves
  1..k-1 stay valid on their own). Implemented as
  `premoves.slice(0, index)` where `index` is the clicked queue position. Add
  this as a new callback in `useBoardInteraction.ts` alongside `cancelPremove`
  (e.g. `cancelPremoveFrom(index)`), wired to a right-click handler on the
  premove-marked squares in `Board.tsx`.

**Visual queue representation.** Extend the existing per-square `.premove`
marking with a **small numbered badge** (1, 2, 3...) on each queued move's
destination square, reflecting its position in the chain — the existing
"ghost position" (pieces shown at their queued destinations via
`applyUciVisually`) already conveys *where things end up*; the numbering adds
*in what order*, which matters once depth > 1 and two premoves could
plausibly be read either order by eye. Keep the existing ghost-position
rendering as the primary representation — the badge is a small addition to
`Board.tsx`'s existing per-square premove class logic, not a new rendering
system.

**Settings interaction.** `premoves: boolean` stays as the master on/off
switch — a queue depth of 1 (today's behavior) is what you get when… no, that
distinction doesn't apply: with the cap change, `premoves: true` now means
"up to 5," full stop, matching how chess.com and Lichess each ship a single
on/off toggle rather than a depth picker. Don't add a depth *setting* — a
configurable cap is an extra decision surface for a case (5 vs fewer) nobody
has asked for; ship the cap as a fixed constant
(`MAX_PREMOVE_QUEUE = 5` in `useBoardInteraction.ts`) and revisit only if
users actually ask for less.

**Variants.** No change to Crazyhouse or Duck — both explicitly opt out of the
premove system today, and nothing about chaining changes that calculus. A drop
queued as a premove, or a duck-placement queued as a premove, would need real
design work (a drop can become illegal because the piece left your pocket via
an intervening capture-and-drop by the opponent, which has no equivalent in
standard chess) — leave that as a clearly separate follow-on, not bundled into
this task. Note it as an explicit non-goal so nobody assumes it's covered.

## Where (files)

- `frontend/src/lib/useBoardInteraction.ts`: add `MAX_PREMOVE_QUEUE = 5`
  guard in the `onMove` append path (line ~103-116); add `cancelPremoveFrom
  (index: number)`; keep the existing whole-chain-collapse behavior in the
  execution effect (lines 152-164) but add a callback/event so the UI can show
  the "queue cleared" transient message at the moment it fires.
- `frontend/src/components/Board.tsx`: right-click handler on premove-marked
  squares (currently line ~698's `.premove` class logic) calling
  `cancelPremoveFrom`; render the queue-position badge per square.
- `frontend/src/pages/LiveGame.tsx` / `BotGame.tsx`: surface the "queue
  cleared" transient message (a toast-style component if one already exists in
  the codebase, otherwise a small inline banner near the board — check for an
  existing toast/snackbar utility before adding a new one).
- No hub change (`gomachine/internal/hub`) — this stays entirely client-side,
  consistent with how premoves work today.
- `frontend/src/lib/settings.ts`: no schema change — `premoves: boolean` is
  reused as-is.

## Data / schema

None. Entirely client-side React state, no BaseAPI involvement.

## Abuse / failure modes

- **Queue depth as a lag/latency exploit**: a 5-deep queue lets a player fire
  5 moves in the time it'd take the opponent to see one — but this is
  identical in kind to chess.com's existing 5-deep queue (not a new exploit we
  introduce) and is bounded by the same rule as today: every queued move still
  goes through the normal legal-move check against the live board the instant
  it's your turn, so an illegal exploit attempt just collapses the chain, it
  doesn't execute an illegal move.
- **The "whole chain drops silently" confusion** is the one real regression
  risk if the toast isn't added — a player who queued 4 moves and sees the
  board just sitting there with no explanation after the opponent's move will
  reasonably think premoves are broken. The transient message is not
  optional polish, it's the fix for the one legitimate confusion this
  feature could cause.
- **Right-click conflicts** with the existing right-click-to-draw-arrow
  feature (mentioned in `docs/SPEC.md`'s live-game feature list) — the
  cancel-one gesture must only fire on a square that's actually part of the
  current premove queue; everywhere else, right-click must keep drawing
  arrows exactly as today. Scope the new handler tightly to premove-marked
  squares only.

## How we'd know it works

- Queue 5 legal premoves in a row — verify a 6th click on an empty square is
  a no-op (no 6th ghost piece, no error).
- Right-click the 3rd queued move's destination — verify moves 1-2 remain
  queued and 3-5 are gone.
- Opponent plays a move that makes premove #1 illegal — verify the whole
  queue clears (not just #1) and the transient "queue cleared" message
  appears once, briefly, then dismisses itself.
- Confirm Crazyhouse drop games and Duck games show no premove UI at all,
  unchanged from today.
- Confirm the hub receives exactly one `move` WS message per executed
  premove, indistinguishable from a fast manual move (no protocol change).
