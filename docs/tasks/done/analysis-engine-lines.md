# Analysis page: engine lines, PGN wiring, shortcuts — 2026-07-28

Uncommitted in the working tree. Typechecks clean. **Least verified of the batch**
— the agent doing this work was stopped before it finished its own verification
pass, so read the diff before trusting it.

## Shipped

**Multi-PV engine lines.** `components/EngineLines.tsx` — a ranked list of engine
lines with evals and PVs, clicking one plays into it. The backend already
supported this (`POST /candidates` takes `multipv`; `OpeningPanel.tsx` was calling
it with 4 for a different purpose) but nothing surfaced it, which meant our own
engine — the whole point of the project — had no showcase on the analysis board.

**PGN wiring.** `AnalysisAside`'s import/export props are now supplied, with real
headers when reviewing a stored game. See `docs/tasks/done/pgn-import-export.md`.

**Shortcuts.** The page's private arrow-key handler was deleted. It was a third
copy of `useMoveNavKeys` and, unlike the shared hook, had no typing-in-an-input
guard, so arrow keys hijacked text fields on this page. Page bindings now go
through `lib/shortcuts.ts`.

**Preferences.** `autoFlip` and `showEvalBar` are honored here now; the page
previously ignored both while the settings modal advertised them.

## Fixed after the fact

Clicking an engine line played the entire PV to the end of the variation.
It now plays one ply — clicking steps into the line, click again to keep walking
it (`onPlayEngineLine` in `pages/Analysis.tsx`).

## Worth checking

Whether the hover-to-draw-an-arrow behaviour and the Duck exclusion gates
(`isDuck`, which must keep engine features off for that variant) both survived.
