# Wire the new preferences into the pages that should honor them

**Status:** prefs defined and exposed in the settings modal; nothing consumes them.

The settings overhaul added six preferences to `frontend/src/lib/settings.ts` and
gave each a control in `components/ThemeDialog.tsx`. They are storage and UI
only — no page reads them, so every one of them is currently a lie to the user.

## The prefs

| Key | Type | Default | Where it belongs |
|---|---|---|---|
| `clockTenths` | `'never' \| 'lowtime' \| 'always'` | `'lowtime'` | `components/Clock.tsx` |
| `clockBar` | `boolean` | `true` | `components/Clock.tsx` |
| `showCaptured` | `boolean` | `true` | new component, next to the clocks in LiveGame + BotGame |
| `confirmMove` | `'never' \| 'slow' \| 'always'` | `'never'` | move submission in LiveGame + BotGame |
| `rookCastle` | `boolean` | `true` | `lib/useBoardInteraction.ts` |
| `boardContrast` | `number` 70–130 | `100` | already live via the `--board-contrast` CSS var |

`boardContrast` is done. The other five need real wiring.

## Notes per item

- **`confirmMove`**: `'slow'` means classical and correspondence only. The
  confirm step must not eat clock time beyond what the move already costs, and it
  must interact sanely with premoves — a premove is already a deliberate
  commitment, so don't double-confirm it.
- **`rookCastle`**: click your own rook to castle. Today castling is king-moves-two
  only. The engine owns legality; this is purely an input-mapping change in the
  board interaction controller.
- **`showCaptured`**: material captured by each side. Compute from the move list,
  not from a second source of truth. Keep it quiet visually — small piece glyphs
  and a `+N` when one side is up material.

## Also fix here

`prefs.showOpponentRating` is honored in `pages/LiveGame.tsx:497` but ignored in
`pages/BotGame.tsx` — the engine rating chip there (~771-776) is gated only on
`zen`. Same setting, two behaviours.

## Done when

Every switch in the settings modal changes something on a board.
