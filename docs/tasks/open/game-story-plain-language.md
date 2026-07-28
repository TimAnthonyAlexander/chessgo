# Plain-language game story (post-game narrative)

**Gap.** Both chess.com's Game Review and Lichess's analysis board surface
centipawn loss, an accuracy percentage, and per-move classification labels
(blunder/mistake/inaccuracy/brilliant/etc.). Neither turns that into a
sentence a beginner can actually read. There are recurring forum threads on
both sites of people asking what centipawn loss even means or why their
"92% accuracy" game still lost. Nobody ships "here's what actually happened in
your game, in plain words."

## What exists today

Everything needed to generate this is already computed — nothing new to
measure, only to phrase:

- `frontend/src/api/client.ts` types (~lines 461-518):
  `AnalysisJudgment = 'best' | 'good' | 'inaccuracy' | 'mistake' | 'blunder'`,
  `AnalysisMove { uci, san, color, cpLoss, isBest, judgment }`,
  `AnalysisPly { ply, fen, sideToMove, evalWhite, bestUci, bestSan, bestPv,
  bestDepth, move?, duck? }`, `AnalysisSide { best, good, inaccuracy, mistake,
  blunder, acpl, accuracy }`, `GameAnalysis { ..., plies: AnalysisPly[],
  summary: { w: AnalysisSide; b: AnalysisSide } }`.
- All of this is **pre-computed server-side**, not derived in the browser:
  `app/Services/GameAnalysisService.php` — `judge()` (threshold constants for
  blunder/mistake/inaccuracy), `cpLoss()`, `accuracy()` (ACPL → accuracy%
  exponential fit), `summary()` (per-side aggregation). Fetched via
  `getGameAnalysis(id)` → `GET /games/{id}/analysis`
  (`GameAnalysisController::get()`, cached, versioned so a threshold change
  invalidates old cached payloads).
- `frontend/src/pages/Analysis.tsx`: `Header` component (~lines 1221-1276)
  renders `game.summary.w/b.accuracy`, inaccuracy/mistake/blunder counts, side
  by side, colored by severity. This is the natural anchor point for a new
  narrative section — it already has the full `GameAnalysis` in scope.
- `frontend/src/components/BlunderRewind.tsx` +
  `frontend/src/lib/blunderRewind.ts`: `buildBlunderPuzzles(game, onlyColor?)`
  filters `game.plies` for `judgment === 'blunder' && bestUci`, producing
  `BlunderPuzzle { fen, playerColor, playedSan/Uci, bestUci, bestPv,
  bestEvalWhite, afterEvalWhite, cpLoss }` per blunder. `BlunderRewindBanner`
  is how it's currently surfaced from the sidebar (a `rewind` boolean state
  flag in `Analysis.tsx`, not a route, swaps in the full-screen retry board).
- There **is** an existing LLM integration to reuse as a pattern, OpenAI, not
  Anthropic: `app/Controllers/BotChatController.php` uses
  `BaseApi\Modules\OpenAI`, model `gpt-4.1-nano`,
  `(new OpenAI())->model(...)->response($prompt, ['temperature'=>1.0,
  'max_output_tokens'=>60])`, `OpenAI::extractText($resp)`. Config:
  `.env.example` `OPENAI_API_KEY`, `config/app.php` → `App::config('openai.api_key')`.

## Design decision: template-based, not an LLM call

Go with **rule-based generation from the eval swings and judgment counts we
already have**, not an LLM call. Reasoning, stated plainly:

- **Determinism.** The same game should produce the same story every time you
  open it (and it's cached alongside the rest of `GameAnalysis`). An LLM call
  reintroduces non-determinism into a payload that's otherwise stable and
  cache-keyed by a version const — every re-generation would need its own
  cache invalidation story, or you accept the story silently drifting between
  views of the same game.
- **Latency.** The analysis payload is already fetched and cached once,
  cheaply. An LLM call per game view adds a network hop with real latency
  (whole-seconds-class for correctness — you'd want it to reference *this
  specific* game's turning point, not a generic template, which needs the full
  move list in the prompt) for something that a handful of if/else rules over
  numbers we already have can do instantly.
- **Cost.** `BotChatController`'s existing OpenAI usage is small
  (`max_output_tokens=60`, nano model) because it's a single chat line per bot
  move. A game story needs more context (the full ply list, judgments, phase)
  to say something specific rather than generic filler — that's a bigger
  prompt, on every game review, for every user, forever. A template costs
  nothing per request and never produces a hallucinated "you missed mate in 4"
  when the actual swing was a positional squeeze.
- **What we'd lose**: an LLM can phrase *any* game's story fluently, including
  ones a rule set can't cleanly categorize (a long grind with no single
  turning point). Templates need explicit fallback prose for the "no single
  moment" case (see below) — the rules must cover the shape of the game, not
  just the dramatic case.

**Rules (v1 — extend later, don't front-load every case):**

1. Find the **decisive moment**: the single ply with the largest eval swing
   *in the losing side's favor being lost* — i.e. the biggest jump in
   `evalWhite` (sign-adjusted per mover) among plies judged `mistake` or
   `blunder`. This is already sitting in `AnalysisPly.evalWhite` /
   `AnalysisMove.cpLoss` per ply; no new computation.
2. Classify the game shape from `summary.w/b` counts + the decisive moment's
   size, in priority order:
   - One `blunder` with `cpLoss` above a "game-losing" threshold (e.g. a
     mate-in-N missed, or a swing past ~600cp from roughly balanced) → "One
     move decided this game." Name the ply number and the piece/side.
   - No blunders, but a string of `mistake`/`inaccuracy` on one side and a
     materially better accuracy on the other → "A steady accuracy gap, not one
     mistake." Cite the two accuracy numbers directly (they're already shown
     in the header — the story should agree with the numbers on screen, not
     contradict them).
   - Both sides clean (`accuracy` both high, few/no blunders) → "Both sides
     played accurately; the result came from [opening/endgame] technique," if
     material was traded down to a technical ending (check the phase via
     piece count at the last few plies), else a neutral "a close, accurate
     game" fallback. Don't overclaim narrative where the numbers don't support
     one — this is the case most likely to tempt fabrication and must be
     resisted.
3. Output **3-5 sentences**: (a) the headline classification from step 2, (b)
   the specific ply/move if there is one ("15...Qxb2 walked into a fork"),
   (c) what changed practically (material/attack/king safety — derived from
   which judgment fired and the phase, not invented detail beyond what the
   eval data supports), (d) one sentence pointing at Blunder Rewind if there's
   at least one blunder (see handoff below), (e) optional closing line only if
   it adds information (e.g. "White's accuracy dropped sharply in the last
   10 moves — likely a time scramble" if the blunder cluster is late-game).
4. All sentence templates live in one place, e.g.
   `app/Services/GameStoryService.php` (new), so wording stays reviewable and
   testable without touching the analysis pipeline. Keep judgments and
   thresholds imported from `GameAnalysisService`'s existing constants — don't
   duplicate the blunder/mistake cutoffs.

**Handoff to Blunder Rewind.** If the story names a specific blunder ply, the
sentence becomes a clickable line (or the paragraph ends with a
`BlunderRewindBanner`-style CTA) that sets the existing `rewind` state flag in
`Analysis.tsx` and, ideally, seeds `BlunderRewind` to start at *that specific*
puzzle rather than the first one in `blunderPuzzles` — `buildBlunderPuzzles`
already returns an ordered array keyed by ply, so the CTA just needs to pass
the matching index instead of defaulting to 0. If the story's decisive moment
isn't a `blunder`-judged ply (e.g. it's the "steady accuracy gap" case with no
qualifying blunder), skip the CTA — don't force a Blunder Rewind link onto a
game that has nothing to rewind.

## Where (files)

- New: `app/Services/GameStoryService.php` — pure function of an already-built
  `GameAnalysis` (or the same inputs `GameAnalysisService::build()` produces);
  no new engine calls, no new persistence.
- `app/Services/GameAnalysisService.php` or `GameAnalysisController.php`: add
  the story string to the existing analysis payload (one new field,
  `story: string[]` — an array of sentences, or a single string; bump the
  cache version const since the payload shape changes).
- `frontend/src/api/client.ts`: add `story?: string[]` to `GameAnalysis`.
- `frontend/src/pages/Analysis.tsx`: new section near `Header`
  (~line 1221-1276), rendered once `game` loads, above or below the
  accuracy table — plain paragraph text, not another stat row.
- No change to `BlunderRewind.tsx` itself beyond accepting an optional start
  index, if we want the "jump straight to this blunder" handoff.

## Data / schema

None required for v1 — the story is derived on read from data
`GameAnalysisService` already produces and already caches; it rides in the
same cached payload rather than needing its own table. If we later want to
A/B different phrasing rule sets or track which stories get clicked into
Blunder Rewind, that would be new analytics, out of scope here.

## Abuse / failure modes

- **Overclaiming causality** ("you lost because of one move") in a game that
  was actually close throughout — mitigated by the priority-ordered
  classification in step 2, which only fires the single-blunder headline when
  the swing genuinely dominates; the steady-gap and close-game fallbacks exist
  specifically so the algorithm doesn't force a dramatic story onto an
  undramatic game.
- **Contradicting the numbers already on screen** (e.g. story says "White
  played nearly perfectly" while the header shows 74% accuracy) — avoided by
  deriving the story directly from the same `summary.w/b` fields the header
  reads, not from a separate judgment.
- **Stale story after a judgment-threshold change**: already covered by the
  existing cache version const in `GameAnalysisService` — bump it when the
  story rules change too, same mechanism.

## How we'd know it works

- Run it against a lopsided blunder game, a close accurate draw, and a
  steady-accuracy-gap game (three fixtures) — verify each produces a
  distinct, correct classification and that the cited ply/accuracy numbers
  match what's already shown in the header for that same game.
- Verify the story never references a ply that doesn't exist in `plies` or a
  judgment that isn't actually `blunder`/`mistake` for the ply it names (a
  simple assertion in a backend test: the named ply's `AnalysisMove.judgment`
  must match the class of story generated).
- Click the Blunder Rewind handoff from a story that names a specific blunder
  — verify it opens directly on that puzzle, not puzzle index 0.
