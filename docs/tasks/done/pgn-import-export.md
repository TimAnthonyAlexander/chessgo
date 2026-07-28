# PGN import/export and share — 2026-07-28

Uncommitted in the working tree. Typechecks clean.

The app had no PGN support at all — a repo-wide grep for "pgn" came back empty —
and no "copy link to this game" anywhere. Both competitors have the full set.
Import matters most: it's how someone brings an OTB or other-site game to our
analysis board, which is our strongest surface.

## Shipped

`frontend/src/lib/pgn.ts`, backed by chess.js (already a dependency, no new ones):

```ts
toPgn(game: PgnGame, headers?: PgnHeaders): string
fromPgn(text: string): ParsedPgn | ParsedPgnError   // never throws
downloadPgn(text, filename): void
copyText(text): Promise<boolean>
pgnFilename(headers): string
```

`fromPgn` tolerates comments, NAGs, `%clk`/`%eval` annotations, RAV variations
(mainline taken), CRLF and missing headers. `toPgn` emits `[FEN]`/`[SetUp]` only
when the game doesn't start from the initial position.

UI in `components/AnalysisAside.tsx`: import-by-paste, Copy PGN, Download PGN,
Copy link. Wired into `pages/Analysis.tsx`, which supplies the real headers when
reviewing a stored game.

`pages/Editor.tsx` gained a paste-FEN field, matching the aside. No PGN there —
it's a static position editor with no move list to serialize.
