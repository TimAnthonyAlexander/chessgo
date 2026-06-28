import { useCallback, useEffect, useState } from 'react'
import { applyUciVisually, type BoardMap, parseFen, type Square } from './chess'
import { playForMove } from './sounds'

export interface Move {
    from: Square
    to: Square
}

/**
 * BoardControl is the seam between "a game in progress" and "a board you play
 * on". Every game source (bot REST, live WebSocket, puzzle, …) can produce one:
 * the authoritative position, whose move it is, what's legal there, and how to
 * submit a move. Board-interaction features — optimistic feedback, premoves, and
 * anything like them — are implemented ONCE against this contract, in
 * useBoardInteraction, instead of being re-wired per page.
 */
export interface BoardControl {
    /** Authoritative current position (FEN). */
    fen: string
    /** May the local player move right now? */
    myTurn: boolean
    /** Legal UCI moves in the current position (typically [] when it isn't your turn). */
    legalMoves: string[]
    /** Submit a move to the game source. May be async (REST) or fire-and-forget (WS). */
    submit: (uci: string) => void | Promise<void>
    /** Allow queuing a move during the opponent's turn; it's played when it's yours. */
    canPremove?: boolean
}

export interface BoardInteraction {
    /** Display-only board to show instead of `fen` for instant optimistic feedback (null = use fen). */
    override: BoardMap | null
    /** The optimistic last move while our submitted move is in flight (null otherwise). */
    optimisticLast: Move | null
    /** A move queued during the opponent's turn, awaiting your turn (null = none). */
    premove: Move | null
    /** Feed raw move intents from the Board here (played now, or queued as a premove). */
    onMove: (uci: string) => void
    /** Discard the queued premove (e.g. the user clicked an empty square). */
    cancelPremove: () => void
}

/**
 * Owns the local player's move lifecycle: optimistic board overlay, the move
 * sound (played synchronously so it lands inside the click gesture and unlocks
 * audio), and handing the move to the game source. The overlay clears as soon as
 * the authoritative position advances.
 *
 * Pages keep their own source-specific concerns (engine replies, clocks, history
 * navigation); they just feed this a BoardControl and render its output onto
 * <Board>.
 */
export function useBoardInteraction(control: BoardControl): BoardInteraction {
    const { fen, myTurn, legalMoves, submit, canPremove = false } = control
    const [override, setOverride] = useState<BoardMap | null>(null)
    const [optimisticLast, setOptimisticLast] = useState<Move | null>(null)
    const [premove, setPremove] = useState<(Move & { uci: string }) | null>(null)

    // The authoritative position advanced (our move landed, or the opponent
    // replied): drop the optimistic overlay. The premove deliberately SURVIVES the
    // opponent's move — that advance is exactly when it gets played.
    useEffect(() => {
        setOverride(null)
        setOptimisticLast(null)
    }, [fen])

    const clearOverlay = useCallback(() => {
        setOverride(null)
        setOptimisticLast(null)
    }, [])

    // Optimistically show + submit a real move. Only ever called when it's our turn.
    const executeMove = useCallback(
        (uci: string) => {
            const before = parseFen(fen)
            setOverride(applyUciVisually(before, uci))
            setOptimisticLast({ from: uci.slice(0, 2), to: uci.slice(2, 4) })
            playForMove(before, uci) // synchronous: instant feedback + unlocks audio in-gesture
            const result = submit(uci)
            // Async sources (REST): also clear once the submit settles, so a rejected or
            // no-op move reverts — the fen-change effect only fires when the position
            // actually advances. Sync sources (WS) return void and rely on that effect.
            if (result && typeof (result as Promise<void>).then === 'function') {
                void (result as Promise<void>).then(clearOverlay, clearOverlay)
            }
        },
        [fen, submit, clearOverlay],
    )

    // A board move intent: play it now if it's our turn, else queue it as a premove
    // (when enabled). Making a real move drops any premove that was queued.
    const onMove = useCallback(
        (uci: string) => {
            if (myTurn) {
                setPremove(null)
                executeMove(uci)
            } else if (canPremove) {
                setPremove({ from: uci.slice(0, 2), to: uci.slice(2, 4), uci })
            }
        },
        [myTurn, canPremove, executeMove],
    )

    const cancelPremove = useCallback(() => setPremove(null), [])

    // When it becomes our turn with a premove queued, play it if it's legal in the
    // new position (match from→to, ignoring the promotion piece) — else discard it.
    useEffect(() => {
        if (!myTurn || !premove) return
        const match = legalMoves.find((m) => m.slice(0, 4) === premove.uci.slice(0, 4))
        setPremove(null)
        if (match) executeMove(match)
    }, [myTurn, premove, legalMoves, executeMove])

    return {
        override,
        optimisticLast,
        premove: premove ? { from: premove.from, to: premove.to } : null,
        onMove,
        cancelPremove,
    }
}
