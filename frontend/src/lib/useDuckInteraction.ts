import { useCallback, useEffect, useState } from 'react'
import { applyUciVisually, type BoardMap, parseFen, type Square } from './chess'
import { duckTargets as computeDuckTargets } from './variants'
import type { Move } from './useBoardInteraction'
import { playForMove } from './sounds'

/**
 * DuckControl is the duck-chess counterpart of BoardControl: the authoritative
 * position, the duck's current square, whose move it is, the legal PIECE moves,
 * and how to submit a completed turn. A duck turn is a piece move THEN a duck
 * placement, so `submit` takes the composite "<pieceUci>:<duckSquare>" string.
 */
export interface DuckControl {
    /** Authoritative current position (FEN). */
    fen: string
    /** The duck's square, or null before the first placement. */
    duck: Square | null
    /** May the local player move right now? */
    myTurn: boolean
    /** Legal UCI PIECE moves in the current position (the duck isn't in this list). */
    legalMoves: string[]
    /** Submit a completed turn as "<pieceUci>:<duckSquare>". May be async or fire-and-forget. */
    submit: (composite: string) => void | Promise<void>
}

export interface DuckInteraction {
    /** Board AFTER the pending piece move (optimistic), or null to use `fen`. */
    override: BoardMap | null
    /** The pending piece move's from/to (for the last-move highlight), or null. */
    optimisticLast: Move | null
    /** True while awaiting a duck placement (phase 2 of the turn). */
    placing: boolean
    /** Empty squares the duck may be placed on while `placing`, else null. */
    duckTargets: Set<Square> | null
    /** Feed piece-move intents from <Board> here (phase 1). */
    onMove: (uci: string) => void
    /** Feed the chosen duck square from <Board> here (phase 2). */
    onPlaceDuck: (sq: Square) => void
    /** Abort the pending piece move, back to piece selection. */
    cancel: () => void
}

/**
 * Owns the two-phase duck-chess move lifecycle. Phase 1 (`onMove`) records a piece
 * move and shows it optimistically, switching the board into duck-placement mode —
 * nothing is submitted yet, so no sound plays (the turn isn't finished). Phase 2
 * (`onPlaceDuck`) drops the duck on an empty square: only now is the move complete,
 * so it plays the move sound synchronously (in-gesture, to unlock audio) and submits
 * the composite. The overlay clears as soon as the authoritative position advances.
 * There is no premove support — a duck turn has two clicks and no queued equivalent.
 */
export function useDuckInteraction(control: DuckControl): DuckInteraction {
    const { fen, duck, myTurn, submit } = control
    const [override, setOverride] = useState<BoardMap | null>(null)
    const [optimisticLast, setOptimisticLast] = useState<Move | null>(null)
    const [pending, setPending] = useState<{ uci: string; targets: Set<Square> } | null>(null)

    // The authoritative position advanced (our turn landed, or the opponent replied):
    // drop the optimistic overlay and any half-finished placement.
    useEffect(() => {
        setOverride(null)
        setOptimisticLast(null)
        setPending(null)
    }, [fen])

    const clearOverlay = useCallback(() => {
        setOverride(null)
        setOptimisticLast(null)
    }, [])

    // Phase 1: a piece-move intent (only meaningful on our turn). Show the piece
    // already moved and enter duck-placement mode; hold submission until the duck
    // lands — that's the completed move, so no sound plays yet either.
    const onMove = useCallback(
        (uci: string) => {
            if (!myTurn) return
            const before = parseFen(fen)
            setOverride(applyUciVisually(before, uci))
            setOptimisticLast({ from: uci.slice(0, 2), to: uci.slice(2, 4) })
            setPending({ uci, targets: computeDuckTargets(before, uci, duck) })
        },
        [myTurn, fen, duck],
    )

    // Phase 2: the duck lands on an empty target. The turn is now complete — play the
    // move sound synchronously (instant feedback + unlocks audio in-gesture), submit
    // the composite, and keep the overlay until the position advances. Async sources
    // (REST) also clear on settle so a rejected move reverts.
    const onPlaceDuck = useCallback(
        (sq: Square) => {
            if (!pending || !pending.targets.has(sq)) return
            const composite = `${pending.uci}:${sq}`
            playForMove(parseFen(fen), pending.uci) // synchronous: feedback + unlocks audio in-gesture
            setPending(null)
            const result = submit(composite)
            if (result && typeof (result as Promise<void>).then === 'function') {
                void (result as Promise<void>).then(clearOverlay, clearOverlay)
            }
        },
        [pending, fen, submit, clearOverlay],
    )

    // Abort the pending piece move (e.g. the user wants a different piece).
    const cancel = useCallback(() => {
        setOverride(null)
        setOptimisticLast(null)
        setPending(null)
    }, [])

    return {
        override,
        optimisticLast,
        placing: pending != null,
        duckTargets: pending ? pending.targets : null,
        onMove,
        onPlaceDuck,
        cancel,
    }
}
