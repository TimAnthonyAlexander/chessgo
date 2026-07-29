# Wire the new preferences into the pages that should honor them

**Status:** completed — 2026-07-29. Every control in the settings modal is live.

- `rookCastle` — `rookCastleMoves()` in `lib/chess.ts`, derived purely from the
  engine's `legalMoves`. A rook click targets **the king's own square**, not the
  g/c file: a piece can never legally move onto its own king, so that target
  can't collide with a real rook move, whereas targeting g1 would strand `Rg1`
  almost every time kingside castling is legal (f1/g1 must be empty for the
  castle to exist). Shared by pointer, drag and keyboard. Off = byte-identical to
  before. Premoves excluded — premove targets are a geometric guess with no
  `legalMoves` backing, and inferring castling there would put legality in the
  client. Chess960: the engine always emits king-origin → king-destination on the
  g/c file, but a king one file from its destination (f1→g1) is byte-identical to
  an ordinary king step because `move_to_uci` drops the `CASTLING` flag — the
  shortcut isn't offered there; clicking the king still works. Pre-existing gap in
  `applyUciVisually`, not new.
- `clockTenths` / `clockBar` — both in `Clock.tsx` via `useSetting` (single-key,
  no extra tick re-renders). Bar is a 3px strip reusing the existing urgency hue;
  `LiveGame` passes `g.timeControl.base` as an optional prop.
- `showCaptured` — gated the four **existing** displays (LiveGame `CapturedPanel`
  + mobile `CapturedGlyphs`, BotGame's two `MaterialStrip` sites,
  `SpectateInfoCard`, `AnalysisAside`).
- `confirmMove` — `lib/useConfirmMove.ts` + `components/PendingMoveBar.tsx`, no
  `Board.tsx` change: the tentative move shows through Board's existing `arrow`
  prop while Board is forced inert, Enter/Escape via the shortcut registry.
- `showOpponentRating` — BotGame's engine chip now reads it alongside `zen`.

**Doc corrections.** "Build a new component" for `showCaptured` was wrong — four
implementations already existed on `lib/material.ts`, and a fifth would have
broken this task's own "no second source of truth" rule. Bot games are **untimed**
and render no `<Clock>`, so `clockBar` is LiveGame-only and `confirmMove: 'slow'`
has no category to test there. **Correspondence does not exist** in
`lib/timeControl.ts` (Bullet/Blitz/Rapid/Classical only), so `'slow'` means
Classical alone. Cited line numbers had drifted to `LiveGame.tsx:508` and
`BotGame.tsx:802-807`.

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
