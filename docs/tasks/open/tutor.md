# Tutor — a report card on your chess

**Status:** built. Backend (schema, metric engine, baselines, build pipeline,
API), frontend pages, and the drill handoff are in. Peer baselines are imported
from the public Lichess database. Remaining: iOS, and the follow-ups listed at
the end.

**One line:** you press one button, we read your last few months of games, and
we tell you the single thing costing you the most rating — then hand you the
drill that fixes it.

---

## Why build this

Every chess site can tell you what went wrong in *one* game. Almost nobody tells
you what keeps going wrong across *all* of them. That is the actual question a
1400 player has: not "was 23.Rd1 an inaccuracy" but "why am I stuck at 1400."

Lichess shipped a beta answer to this (Tutor). Chess.com has a deeper stats
dashboard (Insights) behind a $20/mo tier. Aimchess sells the diagnose-then-drill
loop as a product. All three leave the same hole open, and the Lichess users
complain about it in writing: **the report tells you what is wrong and then
stops.** The top-voted open request on their tracker, filed in February 2026 and
still unassigned in June, is literally "unsure how to move forward after
reviewing the results" — asking for weaknesses to link to puzzles and lessons.

That hole is the reason to build this. We already own the engine and the puzzle
corpus, which means the handoff from "your tactical awareness is weak" to "here
are 20 puzzles on the exact themes you're missing" is a link, not a partnership
deal. Ship the diagnosis *and* the prescription in the same click, and we have
the thing three bigger sites are still missing.

---

## What Lichess Tutor actually is

Mapped from their source (`lichess-org/lila`, `modules/tutor/`), their forums,
and their tracker. This is the reference we are matching feature-for-feature and
then going one step past.

### How you get one

A report is a **discrete artifact you request**, not a live dashboard. There's a
button. You press it, a job queues, and a notification arrives when it's done —
"Tutor report ready / N games analyzed". Old reports stay browsable with their
dates, so you accumulate a shelf of them.

It lives at `/tutor`, off the profile page (an octopus icon above Insights). It
is login-only, **rated games only** (a user with zero rated games sees nothing
and isn't told why), and rolled out partially — even eligible accounts don't all
have the link. It is still beta as of mid-2026, three and a half years after the
August 2022 preview post.

### What it costs them to make one

This is the part that shapes the whole design. Building a report:

1. Backfills the user's game index (finished, rated, longer than 10 ply).
2. Kicks off **up to 100 fresh Stockfish analyses** of games that were never
   analyzed, split proportionally across the user's time controls, and waits up
   to **5 minutes** for the results.
3. Reuses whatever analysis already existed for the rest.
4. Runs the aggregation, compares against peers, writes the report.

Guardrails they needed: **3 reports per user per 24h**, a queue with a scheduler
polling every 2 seconds, at most 20 builds running at once, and a commit from
July 2026 titled "poll the tutor queue less often." Treat those numbers as
evidence of what this feature costs when it works.

### The report structure

One report covers a **date range** (default: the past 6 months) and splits into
**one sub-report per rating category** — bullet, blitz, rapid, and so on. A
category needs **at least 30 games** in the window or it's dropped with an
"insufficient games" state. Mixing bullet and classical into one accuracy number
would be meaningless, and they don't.

Inside a category, the report breaks into tabs they call **angles**:
`skills`, `opening`, `time`, `phases`, `pieces`, plus a drilldown into any
single opening family, per color.

### The metrics

Eight named skills, each defined precisely enough to be reimplemented:

| Metric | What it measures |
|---|---|
| **Accuracy** | Mean accuracy % across your moves. |
| **Tactical Awareness** | How often you take advantage of your opponent's mistakes. |
| **Resourcefulness** | Of the games where your win probability fell below 33%, how many you saved. |
| **Conversion** | Of the games where your win probability rose above 66%, how many you won. |
| **Performance** | Rating performance against the opposition you faced. |
| **Global clock** | Clock usage across the game. |
| **Clock usage** | How much clock you had left when you lost. |
| **Flagging** | How often games end on the clock, for and against. |

Plus the breakdowns: accuracy by **phase** (opening / middlegame / endgame),
accuracy by **piece** (which piece you move when you go wrong), and score and
accuracy by **opening family**, separately for White and Black.

### The peer comparison — the actual idea

Nothing here is an absolute score. Every number is **you versus players at your
exact level**. They slice ratings into bands at least 30 points wide, positioned
by percentile using a Gaussian fitted to their whole database (mean 1804, sd 368,
their words: calibrated on a 50-million-document sample), then query the same
aggregation across every other player in the band. If someone within ±2 rating
already has a fresh report, they reuse it wholesale rather than recomputing.

That is what makes it a *tutor* rather than a stats page. "Your endgame accuracy
is 78%" means nothing. "Your endgame accuracy is well below other 1500s, and it's
the biggest single gap you have" is an instruction.

### The grading scale

Each comparison becomes a **grade in [-1, +1]**: a percentage difference divided
by 25, or a rating difference divided by 150. Grades bucket into seven words —
*much better, better, slightly better, similar, slightly worse, worse, much
worse* — at thresholds 1, 0.4, 0.2 and 0.07. Weak areas render red.

Ranking is the clever bit. A metric's **importance = grade × √(sample × weight)**,
where game-level metrics get weight **35** and move-level metrics get weight
**1**. So one bad game outcome outranks a pile of noisy per-move wobble, and a
huge gap measured over 12 games loses to a moderate gap measured over 400. The
top-level strengths and weaknesses are picked by that score, with more slots
given to the time controls you actually play.

### What their users say

Praise is real but narrow. People single out **Resourcefulness** and
**Conversion** as things nobody had ever shown them — one user changed their
behaviour on the spot ("I had Resourcefulness in the red, and it made me realize
I resign too early in blitz"). The recurring comparison isn't to Chess.com, it's
to Aimchess: "provides much what aimchess does in neater package and over far
bigger sample of games." "It's completely free" and "a coach cannot analyze
hundreds of games instantly" come up again and again as the value.

The complaints, which are our build list:

- **No next step.** The single loudest one. Diagnosis with no prescription.
- **No trend over time.** Every report is a snapshot with nothing to compare to,
  even though old reports are sitting right there.
- **Selection bias**, conceded by the lead dev in the thread: the pre-existing
  analyses in the pool are the games users *chose* to analyze — the interesting
  ones, the losses — so the sample is skewed before you start. The 100 fresh
  random analyses only partly wash it out.
- **Vague metrics.** "Flagging skills" in particular: users couldn't work out
  what it meant or what to do about it.
- **Confusing rerun rules.** People hit a cooldown with no explanation of why
  the button was dead or what a second run would even add.
- **Wrong games in the pool.** Variant games analyzed as if they were standard.
  In-progress correspondence games included.
- **Gating with no explanation.** Casual-only players get nothing and aren't
  told the threshold; nobody in the thread could get a straight answer on how
  many rated games it takes.
- Cosmetics: red text on a dark image, and a light-mode click that errored and
  force-switched the whole UI to dark.

It is HTML-only. No API, no mobile, no way for anything else to read it.

---

## What we build

### The shape

Same core idea — a requested, dated, per-category report built on peer
comparison — with four deliberate differences:

1. **Every weakness ends in a button.** Non-negotiable; it's the whole reason.
2. **The trend view ships in v1.** Reports are stored anyway. Reading two of them
   is not a feature, it's a `SELECT`.
3. **The game sample is ours, not the user's.** We pick the games to analyze, by
   rule, so nobody can bias their own report by choosing what to analyze.
4. **The payload is JSON before it is a page.** The web report and the iOS report
   read the same endpoint. Building this HTML-first would repeat their mistake
   and cost us the app.

### The pages

```
/tutor                          your reports — a list, plus the request button
/tutor/:reportId                the report: category tabs, headline strengths + weaknesses
/tutor/:reportId/:category      one time control or variant
/tutor/:reportId/:category/:angle   skills | openings | phases | pieces | time | puzzles
/tutor/:reportId/:category/opening/:color/:family   one opening, from one side
/tutor/trend                    one metric across all your reports, over time
```

The opening drilldown exists because the handoff table below has a "drill this
opening" row that otherwise has nothing to fire from — and because the opening
breakdown is the single most-cited concrete output in Lichess's own user
threads. It is served from the stored report payload (every measured game is
recorded with its opening and colour), so it re-analyzes nothing.

The **puzzles** angle is the theme profile: your solve rate per tactical theme,
weakest first, from your puzzle history. It carries **no peer comparison and
says so** — the imported puzzle set has puzzle ratings but not other players'
per-theme results, so a peer number there would be invented rather than
measured. It is the second, independent source of tactical evidence: `awareness`
says whether you punish mistakes, this says which patterns you miss, by name.

Reachable from the profile page and from the main nav. Yours only in v1 (plus
admin). Sharing someone else's report is a v2 question with a privacy answer
attached, and we don't need it to launch.

### The report object

One report = **one user + one date range**, containing one sub-report per rating
category that clears the bar.

- **Date range:** last 6 months by default; picker offers 1 / 3 / 6 / 12 months.
- **Minimum games:** **20 per category** in the window. Below that the category
  is shown greyed with the real number — "Blitz: 12 of 20 games. Play 8 more."
  Never a silent omission, and never an unexplained empty page. This is the
  cheapest complaint on their list to avoid and they didn't avoid it.
- **Categories:** every rating category we run — bullet, blitz, rapid,
  classical, and the isolated variant pools. Variants get their own sub-report or
  none; they never get folded into standard numbers.
- **Excluded from the sample:** unfinished games, games under 10 ply, bot-fill
  games, and anything from a variant other than the one being reported on.
- **Rated only?** No. Casual games count, and we say so on the page. Their
  rated-only gate produces a dead feature for the exact beginner who needs it
  most. The one place ratedness matters is the Performance metric, which is
  simply skipped for a casual-heavy sample rather than blocking the report.

### Exact definitions

Everything below is a real rule, not a description. Where an earlier draft of
this document said something vague or self-contradictory, the resolution is
recorded with it.

**Centipawn loss.** The eval delta across your own move: the position before
versus the position after, from your point of view, floored at zero and capped
per move. Not "best move versus played move" — a delta needs only per-position
evals, which both corpora have, whereas a best-move comparison needs a
principal variation, which the Lichess dump does not carry. This deliberately
differs from `GameAnalysisService::cpLoss()`, which drives the analysis board
where naming the specific better move is the point.

**Eval scale.** zugzwang's centipawns are not Stockfish's. Measured on 6,300
paired positions from identical games (`scripts/calibrate_tutor_evals.php`):
zugzwang ≈ **2.81×** Stockfish, Pearson **0.969**. Corpus evals are multiplied
onto zugzwang's scale on the way in, so everything Tutor stores is native and a
Tutor accuracy figure never disagrees with the analysis board's for the same
game. Re-fit when the engine's eval scale moves.

**Accuracy.** `103.1668 · e^(−0.04354 · ACPL/10) − 3.1669`, clamped to [0,100] —
the same exponential fit `GameAnalysisService` already uses. *Resolution:*
Lichess derives accuracy from win probability per move, which is arguably
better. We keep our existing fit anyway, because two different accuracy numbers
for the same game on two pages of the same site is a worse failure than an
imperfect curve. One formula, site-wide.

**Winning and losing positions.** Win probability ≥ **66%** and ≤ **34%**,
where win probability is the standard logistic on the Stockfish-scale eval:
`50 + 50·(2/(1+e^(−0.00368208·cp)) − 1)`. *Resolution:* an earlier draft said
"eval passed +2.0 (or win prob > 66%)" — those are different sets of games.
Win probability wins, for two reasons: it is Lichess's definition, and it is
invariant to the engine's eval scale, so conversion and resourcefulness cannot
be silently re-broken by an engine change. In zugzwang's scale 66% is about
+507cp, so the old "+200" would have counted ~57%-win positions as winning.

**Conversion** — of the games where your win probability passed 66% at or after
ply 12, the share you won. **Resourcefulness** — of the games where it fell
below 34% at or after ply 12, the share you did not lose. The ply-12 floor
stops an opening line the engine briefly likes from counting as a squandered
win.

**Tactical awareness** — of the opponent moves that cost them ≥150cp and that
you had a reply to, the share where your reply cost you ≤50cp.

**Phase.** Material first, then move number: **endgame** when ≤7 non-pawn
non-king pieces stand on the board; otherwise **opening** before ply 20 and
**middlegame** from ply 20. One rule, applied identically to both corpora, so a
queenless position on move 8 is correctly an endgame.

**Clock.** Two metrics, as Lichess has. **Clock remaining** is the mean
percentage of your initial clock left across all your moves. **Clock left when
you lost** is the percentage left at your last move, in games you lost — they
answer different questions and a player can be fine on one and bad on the
other. Ours adds **moves in time trouble**: the share of your moves played with
under 10% of the clock left.

**The first move is free.** The start position is treated as carrying no eval
in every corpus, so White's opening move is never scored. The Lichess dump
annotates after each move and so has nothing for the initial position, while
`/analyze-game` does; without this rule White's ACPL would differ between the
corpora for a reason that has nothing to do with chess.

**Which rating picks the peer band.** The mean of the ratings you actually
played the sampled games at, not your rating today. A player who gained 200
points across the window has no single current band that describes those games.

### The metrics we compute

Everything Lichess has, in their categories, plus two of ours.

**Game-level** — one number per game, weighted heavily because it's the real
outcome:

| Metric | Definition | Reads well as |
|---|---|---|
| **Conversion** | Games where your eval passed +2.0 (or win prob > 66%), and you won them. | "You reach winning positions as often as your peers. You win 61% of them. They win 79%." |
| **Resourcefulness** | Games where your eval fell past −2.0, and you drew or won anyway. | "You resign or collapse in positions your peers save." |
| **Flagging** | Share of games ending on time, split into for-you and against-you. | "One in five of your blitz losses is the clock, not the board." |
| **Clock left when you lost** | Clock remaining at the moment you lost. | Pairs with flagging; on its own it's the metric their users found meaningless, so it never appears as a standalone card. |
| **Clock remaining** | Mean % of your clock left across all your moves. | Lichess's "global clock". How you spend time in general, as opposed to how it ended. |
| **Performance** | Rating performance against the field you played. | Only for a sample with enough rated games. |

**Move-level** — needs the full engine pass:

| Metric | Definition |
|---|---|
| **Accuracy** | Mean per-move accuracy across the sample. |
| **Tactical awareness** | Of the positions where your opponent just blundered, how often your reply was the punishing move. This is the one that separates "I don't blunder much" from "I don't win." |
| **Phase accuracy** | Accuracy split opening / middlegame / endgame, by a fixed rule (move number plus material), same rule everywhere so numbers are comparable. |
| **Piece accuracy** | Loss split by which piece moved. Surfaces things like "your rook moves cost you twice what your knight moves do." |
| **Opening performance** | Score and accuracy per opening family, **split by colour**. The same opening is a different problem from each side — you choose it as White and you are answering it as Black — so merging them hides the thing a repertoire fix depends on. |

**Ours, and the reason to build this here:**

| Metric | Definition |
|---|---|
| **Theme profile** | Your solve rate per puzzle theme against your peers' — fork, pin, back-rank, mateIn2, endgame, and so on. We already store puzzle attempts and a denormalized theme index, so this is aggregation, not engine time. |
| **Leak map** | The specific positions from your own games where you lost the most eval, clustered by theme. Not a stat — the raw material for the drills below. |

The theme profile is the bridge. Everyone else measures tactical weakness from
game analysis and then has nowhere to send you. We measure it from *two*
independent sources — your games and your puzzle history — and the second one is
already indexed by exactly the tag we need to build the drill.

### The peer comparison, honestly

Their peer system is fitted on 50 million of their own documents. We have no
meaningful game corpus of our own — so the baselines are built from the
**public Lichess database dump** (CC0), which publishes real games at every
rating with engine evals attached. Around 11% of games carry `%eval`
annotations; one month yields about a million analyzed games, measured by the
same `TutorMetrics` that measures a real user.

Two problems with that, both measured rather than assumed:

**Selection bias.** A Lichess game has evals because a human requested analysis
— exactly the bias their lead dev conceded. `scripts/tutor/bias_check.py`
streams the *unfiltered* dump and compares annotated against unannotated games
at matched rating bands, on statistics that need no engine. Across 30 matched
cells the two agree on white-win rate (1.60pp mean absolute difference) and
draw rate (1.28pp) — representative. They do **not** agree on losses to the
clock: annotated games flag about **3pp less often**, consistently, at every
rating. Nobody requests analysis of a game they lost on time.
That is not a caveat, it is a bug, because `flagging_loss` is graded on a 15pp
scale and a 3pp-low baseline would tip ordinary players over the "slightly
worse" threshold on a metric they are average at. So the outcome metrics
(`win_rate`, `flagging_loss`) are imported from the **entire population**
instead — they need no engine, so streaming every game is cheap. Engine-derived
metrics come from the annotated corpus, outcome metrics from all of it, into
the same source.
*Known residual:* the clock-usage metrics still come from the annotated corpus,
because reconstructing per-move clocks for the whole population is a much
bigger job. Their bias is likely in the same direction as flagging's.

**Engine mismatch.** Their evals come from fishnet, ours from zugzwang. See
"Eval scale" above — measured, corrected at the source.

Band width is **50 points**, wider than their 30, because a thin band is a noisy
band. A cell below 50 games is not served at all; the reader widens to
neighbouring bands and, failing that, reports `tier: 'none'` and the page drops
the comparison UI rather than inventing one. The tier is carried to the screen
in every case.

Baselines are precomputed on a schedule, never per request. A report reads one
row per (category, rating bucket, metric).

Say the sample size on screen, next to the number. Their own users asked for this
on the puzzle dashboard and never got it, and it's the difference between a
number you can act on and a number you argue with.

### Grading and ranking

Take their scale — it's well designed and there's no reason to invent another.

- Grade in **[-1, +1]**: percentage gap / 25, rating gap / 150.
- Seven words at thresholds 1 / 0.4 / 0.2 / 0.07: *much better* through *much
  worse*, with *similar* in the middle.
- **Importance = grade × √(sample × weight)**, weight 35 for game-level metrics
  and 1 for move-level. Sort by importance; show the top three strengths and top
  three weaknesses per category, more slots to the categories you play most.

Two rules on presentation. Never show a grade without its sample size. And red
is for the ranked weaknesses only — not for every below-average cell, or the page
becomes a wall of red and stops meaning anything.

### The handoff — the point of the feature

Every weakness card carries exactly **one** primary button. One. A card with four
links is a card with no recommendation.

| Weakness | Button | What it opens |
|---|---|---|
| Tactical awareness | **Drill these** | A puzzle set filtered to your worst themes, at your puzzle rating. |
| A weak theme | **Drill these** | Same, one theme. |
| An opening | **Drill this opening** | The opening drill against the bot — see `opening-drill-vs-bot.md`, which this gives a reason to exist. |
| Conversion | **Replay your wins that got away** | Positions from *your own games* where you were winning and stopped being winning. Play them out against the bot from that exact position. |
| Resourcefulness | **Replay your lost causes** | Same, from positions where you were lost and resigned or collapsed. |
| Endgame accuracy | **Drill endgames** | Endgame-tagged puzzles, plus the endgame positions from your own games. |
| Time / flagging | *(no drill)* | Show the games, and the move where the clock ran out on you. There is no honest drill for this, so don't fake one. |

The two replay drills are the ones nobody else has. They're built from the leak
map, which we're computing anyway, and they're the most convincing thing on the
page: not a generic puzzle, but the position *you* were winning last Tuesday, to
play again.

### Build, cost, throttling

A report request is a background job. The user gets a notification when it's
done, same as any other notification — they don't sit on a spinner.

The game sample rule, which fixes their bias problem:

> Analyze **every** game in the window up to a cap. Over the cap, take a
> **uniform random sample** across the window, never the most recent N and never
> the ones the user already looked at. Record the sample size and the cap hit in
> the report so the page can say "based on 140 of your 380 blitz games."

Sizing needs measuring before the cap is fixed. Rough shape: a cap of 150 games
at ~40 moves is ~6,000 positions per report, and we own the engine, so a short
per-position budget is fine — but measure real wall-clock on a real account
before committing, and set the cap from that measurement, not from this
paragraph. Cache per-position evals; a popular opening position gets analyzed
once for everybody.

Throttling, in this order:

- **3 reports per user per 24h.**
- The request button is **disabled when nothing has changed**, with the reason
  spelled out: "No new games since your last report. Play 5 more and come back."
  Never a bare cooldown timer — that's the complaint they collected.
- A bounded number of builds running at once, and a queue behind it.
- Report generation must never compete with live game analysis for engine
  capacity. Live play wins, always.

### Data

Three tables, singular snake_case, through the model generator — edit the model,
`migrate:generate`, `migrate:apply -y`. JSON payloads live in `?string` TEXT
columns with explicit encode/decode accessors, never an `array`-typed property.

- **`tutor_report`** — user, range start/end, status (queued / building / ready /
  insufficient), games considered, games analyzed, cap-hit flag, the computed
  payload, timestamps. Reports are kept, not overwritten: the trend view is
  reading old rows, and deleting them deletes the feature.
- **`tutor_job`** — the queue: report id, state, attempts, timestamps. Separate
  from the report so a failed build leaves a report row saying so rather than
  vanishing.
- **`tutor_baseline`** — category, rating bucket, metric, sample size, mean,
  computed_at. One row per cell, rebuilt on a schedule. Also the source for the
  absolute-band fallback.

The leak map (positions for the replay drills) rides inside the report payload.
It's a list of position references and eval deltas, not a new corpus.

### iOS

The app has full parity today and a new page system will be conspicuous by its
absence. Web ships first, iOS follows — but the report endpoint returns JSON
from day one, and the web page is a client of it like any other. This is the one
place we should explicitly not copy Lichess: their HTML-only build means Tutor
cannot exist in their app at all.

---

## Not in v1

- **No LLM anywhere.** Lichess's is pure statistics and it works. Natural-language
  narration is a separate task (`game-story-plain-language.md`), and grounding an
  LLM in engine truth is an unsolved problem we don't need to solve to ship this.
- **No other people's reports.** Yours and admin's. Sharing has a privacy
  question attached and nothing depends on it.
- **No coaching content library.** We link to drills we already have. We don't
  write 3,000 opening pages — that's the content bottleneck Lichess named in 2022
  and it's a large part of why this took them three and a half years.
- **No custom date ranges** beyond the four presets.
- **No per-opponent analysis.** Different feature.

---

## How this goes wrong

- **A confident number from twelve games.** The importance formula's √sample term
  helps, but the real defence is the minimum-games gate and printing the sample
  size beside every figure.
- **An empty peer band read as a verdict.** Hence the three-tier fallback and the
  on-page label saying which tier produced the comparison. "Compared to 6 players"
  should never render as though it were "compared to 6,000."
- **The wall of red.** Cap the weaknesses shown, colour only the ranked ones.
- **Blaming the player for the sample.** If someone's blitz is 80% casual games
  against friends, the Performance number is noise. Skip metrics the sample can't
  support instead of printing a bad one.
- **Variants leaking into standard numbers.** They shipped this bug. Filter by
  variant at the query, and test with an account that plays Duck and Crazyhouse.
- **A drill button that opens something generic.** If the tactical-awareness
  button opens the ordinary puzzle page, the whole differentiator evaporates. The
  set must be filtered to that user's themes and it must be visible that it was.
- **Reports competing with live games for the engine.** Queue depth and priority,
  checked under load, not assumed.

---

## Done when

A player with 20+ games in a category opens `/tutor`, presses one button, and
gets a notification a few minutes later. The report opens on a headline like
"Your biggest leak in blitz: you reach winning positions as often as other 1500s
and win far fewer of them." Underneath it is a number, the sample it came from,
and what it's being compared against. Below that is one button, and pressing it
puts them on a board in a position from their own game, winning, with the bot
waiting.

Their second report, weeks later, shows that number moving.

---

## What is left

Honest list, including things verification surfaced that were left alone on
purpose.

- **iOS is uncompiled.** The native client is written and reviewed but never
  built — this repo's app is built on device in Xcode, not here. First things
  to check on device: that a real report payload decodes without emptying
  `categories` (the whole-dictionary decode is the one failure mode the
  resilient wrappers can't narrow), and that the puzzle theme deep-link starts
  a session rather than landing on the setup screen.
- **Clock metrics still come from the annotated corpus.** `bias_check.py`
  proved the annotated subset under-represents clock losses by ~3pp, which was
  fixed for `flagging_loss` by measuring the full population. The same fix is
  not applied to `global_clock`, `clock_when_losing` or `time_pressure`,
  because those need per-move clocks and reconstructing them for ~5M games is a
  much bigger job than reading headers. Their bias is likely in the same
  direction. Measure it before trusting those three as finely as the rest.
- **Baselines are one month (2026-06).** Good enough — the cells that matter
  carry tens of thousands of games — but there is no refresh cadence and no
  job that rebuilds them. Rating distributions drift; decide how often this
  should re-run before it goes stale unnoticed.
- **`TutorThemeProfile::forUser()['attempts']`** counts every theme bucket the
  query returns, including the structural themes hidden from the visible list,
  and double-counts puzzles carrying several tags. Harmless while it is not
  displayed. If it is ever surfaced as "N puzzles considered", fix it first.
- **No peer comparison for puzzle themes**, and there cannot be one from the
  current data: the imported set has puzzle ratings but not other players'
  per-theme results. The payload says so rather than inventing a number. A real
  peer number would need our own solve data at volume.
- **The engine died once under concurrent `/analyze-game` load** during
  calibration (two processes hammering it). It restarted cleanly and has been
  stable since, but report building fans out engine calls and this is worth
  reproducing deliberately before it happens under real traffic.
- **Report build is slow**: ~5 minutes for 68 games when most were already
  analyzed. Fine behind a queue and a notification, but the analysis cap and
  per-position movetime deserve measuring against real usage rather than the
  values picked here.
