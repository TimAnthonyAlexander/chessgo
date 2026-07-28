# Keyboard shortcut registry and `?` overlay — 2026-07-28

Uncommitted in the working tree. Typechecks clean.

Keyboard support was thin and completely undiscoverable: three independent copies
of the same arrow-key move-nav handler (`lib/useMoveNavKeys.ts`,
`pages/Analysis.tsx`, `components/DuckFreeBoard.tsx`), a stray Enter binding in
Puzzles, and no help overlay anywhere. Lichess exposes `?` but builds a separate
modal per page, which its own users complain about (lila#18855). One registry
beats that.

## Shipped

`frontend/src/lib/shortcuts.ts`, in the same plain-class-plus-singleton idiom as
the other stores in `lib/`:

```ts
interface Shortcut { keys: string; label: string; group?: string; run?: () => void }
useShortcuts(scope: string, shortcuts: Shortcut[]): void
useRegisteredShortcuts(): ShortcutGroup[]
useGlobalShortcutListener(): void   // Layout only
```

The bindings array can be a fresh inline literal every render — handlers are read
through a ref, so no `useCallback` discipline is imposed on callers. One global
`keydown` listener, with the typing-in-an-input guard lifted from `useMoveNavKeys`,
and it stays out of the way while a dialog is open except for Escape and `?`.
Shortcuts registered without a `run` are documentation entries for keys handled
elsewhere (the board's hold-H, Escape on the promotion picker).

`components/ShortcutsDialog.tsx` lists everything currently registered, grouped,
keys rendered as `<kbd>` chips. Opened with `?`, and from a "Keyboard shortcuts"
entry in the nav so it's discoverable by mouse.

`useMoveNavKeys` now registers through the registry, so its four bindings appear
in the dialog automatically. Its public signature is unchanged, so all four
existing call sites needed no edits.

The duplicate handler in `pages/Analysis.tsx` was deleted with the analysis-page
work; the one in `components/DuckFreeBoard.tsx` is still there.
