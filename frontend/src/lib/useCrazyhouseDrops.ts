import { useCallback, useEffect, useMemo, useState } from 'react'
import type { BoardMap, Square } from './chess'
import { dropTargets as computeDropTargets, type PocketPiece } from './variants'
import { playForMove } from './sounds'

/**
 * Owns the Crazyhouse drop lifecycle, which coexists with the normal piece-move
 * controller (useBoardInteraction). Selecting a pocket piece highlights its legal
 * drop squares; clicking one submits the drop as a plain move string "<P>@<sq>"
 * (e.g. "N@f3") — the engine treats a drop like any other move, so it flows
 * through the SAME submit path as piece moves. There is no drag/premove here.
 */
export interface CrazyhouseDrops {
    /** The pocket piece currently selected for dropping, or null. */
    selected: PocketPiece | null
    /** Empty squares the selected piece may be dropped on, or null when none is selected. */
    dropTargets: Set<Square> | null
    /** Toggle-select a pocket piece (a second click on the same piece deselects). */
    selectPocket: (p: PocketPiece) => void
    /** Drop the selected piece on `sq` (must be a current drop target). */
    drop: (sq: Square) => void
    /** Clear the pocket selection (e.g. the user picked a board piece instead). */
    cancel: () => void
}

export function useCrazyhouseDrops(
    legalMoves: string[],
    myTurn: boolean,
    submit: (uci: string) => void,
): CrazyhouseDrops {
    const [selected, setSelected] = useState<PocketPiece | null>(null)

    // Drop the selection whenever it stops being our turn or the legal-move set
    // changes (a new position) — a stale pocket selection must never linger.
    useEffect(() => {
        if (!myTurn) setSelected(null)
    }, [myTurn, legalMoves])

    const selectPocket = useCallback(
        (p: PocketPiece) => {
            if (!myTurn) return
            setSelected((cur) => (cur === p ? null : p))
        },
        [myTurn],
    )

    const drop = useCallback(
        (sq: Square) => {
            if (!selected) return
            const uci = `${selected}@${sq}`
            // Synchronous, in-gesture: instant feedback + unlocks audio. A drop lands on
            // an empty square, so playForMove resolves to the plain move cue.
            playForMove({} as BoardMap, uci)
            setSelected(null)
            submit(uci)
        },
        [selected, submit],
    )

    const cancel = useCallback(() => setSelected(null), [])

    // Rebuilds the Set only when the selection or the legal-move list actually
    // changes, instead of on every render — Board's `dropTargets` prop stays
    // referentially stable across unrelated re-renders (chat, presence, …).
    const dropTargets = useMemo(
        () => (selected ? computeDropTargets(legalMoves, selected) : null),
        [legalMoves, selected],
    )

    return {
        selected,
        dropTargets,
        selectPocket,
        drop,
        cancel,
    }
}
