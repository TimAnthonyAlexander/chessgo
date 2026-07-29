// Optional confirm step before a move actually submits (the `confirmMove`
// preference). Sits between a board's raw move intent and the real submit
// function — callers keep BoardControl.onMove (useBoardInteraction) untouched
// and just wrap it with this for the "on-turn, real move" path.
//
// A premove is already a deliberate commitment (queued while it isn't your
// turn, played automatically the moment it is), so it must never be routed
// through here — callers keep sending premove intents straight to the real
// onMove and only hand this hook moves made while it's genuinely their turn.
import { useCallback, useState } from 'react'
import type { Square } from './chess'
import type { ConfirmMove } from './settings'
import type { Category } from './timeControl'
import { useShortcuts } from './shortcuts'

export interface PendingMove {
    uci: string
    from: Square
    to: Square
}

export interface ConfirmMoveControl {
    /** The move awaiting confirmation, or null when nothing is pending. */
    pending: PendingMove | null
    /** Feed a REAL (on-turn) move intent here. Submits immediately when no
     * confirmation is required for this move; otherwise holds it as `pending`. */
    onMove: (uci: string) => void
    /** Submit the pending move and clear it. */
    confirm: () => void
    /** Discard the pending move without submitting. */
    cancel: () => void
}

/**
 * `category` is the game's time-control category, or null when the game has
 * no time control at all (bot games are untimed) — 'slow' only ever fires for
 * Classical, so passing null just means 'slow' never triggers there and only
 * 'always' does.
 */
export function useConfirmMove(
    confirmMove: ConfirmMove,
    category: Category | null,
    submit: (uci: string) => void,
): ConfirmMoveControl {
    const [pending, setPending] = useState<PendingMove | null>(null)
    const needsConfirm =
        confirmMove === 'always' || (confirmMove === 'slow' && category === 'Classical')

    const onMove = useCallback(
        (uci: string) => {
            if (!needsConfirm) {
                submit(uci)
                return
            }
            setPending({ uci, from: uci.slice(0, 2) as Square, to: uci.slice(2, 4) as Square })
        },
        [needsConfirm, submit],
    )

    const confirm = useCallback(() => {
        setPending((p) => {
            if (p) submit(p.uci)
            return null
        })
    }, [submit])

    const cancel = useCallback(() => setPending(null), [])

    // Enter confirms, Escape cancels — only registered while something is
    // actually pending, so these keys are free the rest of the time.
    useShortcuts(
        'confirm-move',
        pending
            ? [
                  {
                      keys: 'Enter',
                      label: 'Confirm move',
                      group: 'Move confirmation',
                      run: confirm,
                  },
                  {
                      keys: 'Escape',
                      label: 'Cancel move',
                      group: 'Move confirmation',
                      run: cancel,
                  },
              ]
            : [],
    )

    return { pending, onMove, confirm, cancel }
}
