# Settings modal overhaul — 2026-07-28

Uncommitted in the working tree. Typechecks clean.

The global settings modal (`components/ThemeDialog.tsx`, navbar palette icon) had
four real correctness bugs and was missing a way to find anything in it.

## Fixed

- **"Reset to defaults" barely reset anything.** It called `settingsStore.reset()`
  and `siteThemeStore.reset()` only; `themeStore` (board theme, piece set) and
  `soundThemeStore` (material) had no `reset()` at all, and the mute flag was
  untouched. Added `reset()` to both stores; the dialog now resets all four.
- **The sound master toggle lived outside the store** as a module-level variable
  in `lib/sounds.ts` under its own `chessgo.sound` key, so the dialog mirrored it
  in local `useState` — the only non-reactive setting. It's now `soundEnabled` in
  `Prefs`, with a one-time migration off the old key. `soundEnabled()` and
  `setSoundEnabled()` stayed as delegates so no call site changed.
- **"Auto-flip board"** claimed "(bot / review)" but was only read in BotGame.
  Copy corrected.
- **"Show evaluation bar"** scoped itself to bot games. Copy corrected.

## Added

- Search box in the dialog header. A non-empty query hides the tab strip and
  flattens every matching row across all four tabs; `RowShell` is the single
  choke point, so every toggle/segment/slider filters for free.
- Six preferences, defined and exposed but not yet consumed by any page — see
  `docs/tasks/open/wire-new-prefs-into-pages.md`: `clockTenths`, `clockBar`,
  `showCaptured`, `confirmMove`, `rookCastle`, `boardContrast`.
- `boardContrast` is live already, pushed as `--board-contrast` from `applyVars()`
  and applied in `Board.css` next to the existing `--board-dim` scrim.

Files: `lib/settings.ts`, `lib/boardTheme.ts`, `lib/soundTheme.ts`, `lib/sounds.ts`,
`components/ThemeDialog.tsx`, `components/Board.css`.
