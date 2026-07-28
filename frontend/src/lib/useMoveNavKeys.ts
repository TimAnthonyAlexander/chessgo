import { useShortcuts } from './shortcuts'

// Move-history navigation keys, registered through the global shortcut
// registry (lib/shortcuts.ts) so they show up in the `?` dialog for free:
//   ←  previous ply        →  next ply
//   ↑ / Home  first ply     ↓ / End  latest (live)
// The registry's own guard ignores keystrokes while a text field (chat input,
// etc.) is focused, so typing never scrubs the board. Used by the live and bot
// game pages, GuessTheElo, and EngineVsEngine — each supplies its own
// prev/next/first/last handlers; this hook's public signature is unchanged so
// none of those call sites need to change.
export function useMoveNavKeys(handlers: {
    onPrev: () => void
    onNext: () => void
    onFirst: () => void
    onLast: () => void
    enabled?: boolean
}): void {
    const { onPrev, onNext, onFirst, onLast, enabled = true } = handlers
    useShortcuts(
        'move-nav',
        enabled
            ? [
                  { keys: 'ArrowLeft', label: 'Previous move', group: 'Move navigation', run: onPrev },
                  { keys: 'ArrowRight', label: 'Next move', group: 'Move navigation', run: onNext },
                  { keys: 'ArrowUp', label: 'First move', group: 'Move navigation', run: onFirst },
                  { keys: 'Home', label: 'First move', group: 'Move navigation', run: onFirst },
                  { keys: 'ArrowDown', label: 'Last move', group: 'Move navigation', run: onLast },
                  { keys: 'End', label: 'Last move', group: 'Move navigation', run: onLast },
              ]
            : [],
    )
}
