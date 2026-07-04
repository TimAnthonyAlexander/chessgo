import { useEffect } from 'react'

// Global keyboard shortcuts for stepping through a game's move history:
//   ←  previous ply        →  next ply
//   ↑ / Home  first ply     ↓ / End  latest (live)
// Keystrokes while a text field (chat input, etc.) is focused are ignored so
// typing never scrubs the board. Used by the live and bot game pages, which each
// supply their own prev/next/first/last handlers.
export function useMoveNavKeys(handlers: {
    onPrev: () => void
    onNext: () => void
    onFirst: () => void
    onLast: () => void
    enabled?: boolean
}): void {
    const { onPrev, onNext, onFirst, onLast, enabled = true } = handlers
    useEffect(() => {
        if (!enabled) return
        const onKey = (e: KeyboardEvent) => {
            if (e.defaultPrevented || e.metaKey || e.ctrlKey || e.altKey) return
            const t = e.target as HTMLElement | null
            const tag = t?.tagName
            if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || t?.isContentEditable) {
                return
            }
            switch (e.key) {
                case 'ArrowLeft':
                    onPrev()
                    break
                case 'ArrowRight':
                    onNext()
                    break
                case 'ArrowUp':
                case 'Home':
                    onFirst()
                    break
                case 'ArrowDown':
                case 'End':
                    onLast()
                    break
                default:
                    return
            }
            e.preventDefault()
        }
        window.addEventListener('keydown', onKey)
        return () => window.removeEventListener('keydown', onKey)
    }, [onPrev, onNext, onFirst, onLast, enabled])
}
