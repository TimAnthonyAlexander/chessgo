import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
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
    /**
     * Display-only board to show instead of `fen` (null = use fen). Carries either
     * the optimistic overlay for an in-flight move OR — while it isn't our turn and
     * premoves are queued — the position with the whole premove chain applied, so
     * the queued pieces actually sit on their destinations (Chess.com-style), not
     * just highlighted. Pages already feed this through as `overrideBoard`.
     */
    override: BoardMap | null
    /** The optimistic last move while our submitted move is in flight (null otherwise). */
    optimisticLast: Move | null
    /** The queued premove chain, in play order (empty = none). Each is highlighted. */
    premoves: Move[]
    /** Feed raw move intents from the Board here (played now, or queued as a premove). */
    onMove: (uci: string) => void
    /** Discard the ENTIRE queued premove chain (e.g. the user clicked an empty square). */
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
    // The queued premove chain, in the order they'll be played. Chess.com-style: a
    // move made while it isn't our turn is appended, and the board is shown with the
    // whole chain applied (see premoveBoard) so the next premove picks the piece up
    // from where the chain left it.
    const [premoves, setPremoves] = useState<Array<Move & { uci: string }>>([])

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

    // A board move intent: play it now if it's our turn, else append it to the
    // premove chain (when enabled). Making a real move drops any queued chain.
    const onMove = useCallback(
        (uci: string) => {
            if (myTurn) {
                setPremoves([])
                executeMove(uci)
            } else if (canPremove) {
                setPremoves((prev) => [
                    ...prev,
                    { from: uci.slice(0, 2), to: uci.slice(2, 4), uci },
                ])
            }
        },
        [myTurn, canPremove, executeMove],
    )

    // Cancelling drops the WHOLE chain — matching how Chess.com clears every queued
    // premove at once (a click on an empty square, a right-click, etc.).
    const cancelPremove = useCallback(() => setPremoves([]), [])

    // The board with the entire premove chain applied, so the queued pieces sit on
    // their destinations (and the next premove picks them up there). It folds onto
    // the CURRENTLY DISPLAYED position — the optimistic overlay when our own move is
    // still in flight (e.g. the bot page keeps showing our move through the engine's
    // think window before `fen` advances), else the authoritative `fen`. Null when
    // nothing is queued.
    const premoveBoard = useMemo(() => {
        if (premoves.length === 0) return null
        let b = override ?? parseFen(fen)
        for (const p of premoves) b = applyUciVisually(b, p.uci)
        return b
    }, [override, fen, premoves])

    // Fen of the position we last FIRED a premove into. After we submit our move,
    // `fen`/`legalMoves`/`myTurn` don't update synchronously — they echo back from the
    // game source a beat later — so for a moment we're still `myTurn:true` with the
    // PRE-move legal-move list. Without this guard the effect re-runs the instant we
    // shift the chain and validates the NEXT premove against those stale legal moves
    // (where our piece hasn't moved yet): it never matches, and the whole chain wrongly
    // collapses. Gating on `fen` fires at most one premove per distinct position; each
    // played move changes the position (incl. the move counters), so the next premove
    // only resolves once the board has genuinely advanced.
    const lastFiredFen = useRef<string | null>(null)

    // When it becomes our turn (at a position we haven't already fired into), try the
    // HEAD of the chain against the real legal moves (match from→to, ignoring the
    // promotion piece). If it's legal we play it and keep the rest queued (they resolve
    // on our following turns). If it's illegal the WHOLE chain collapses — a premove is
    // only reachable once every earlier one has been played, so a failed head is a
    // failed prior move.
    useEffect(() => {
        if (!myTurn || premoves.length === 0) return
        if (lastFiredFen.current === fen) return // already fired here; await a real advance
        const [head, ...rest] = premoves
        const match = legalMoves.find((m) => m.slice(0, 4) === head.uci.slice(0, 4))
        if (match) {
            lastFiredFen.current = fen
            setPremoves(rest)
            executeMove(match)
        } else {
            setPremoves([])
        }
    }, [myTurn, premoves, legalMoves, fen, executeMove])

    // Board's `premoves` prop wants plain {from,to} pairs (no `uci`); mapping to
    // that shape inline in the return would allocate a brand-new array on every
    // render regardless of whether the chain changed — memoize it so the prop
    // stays referentially stable across unrelated re-renders.
    const premovesOut = useMemo(
        () => premoves.map((p) => ({ from: p.from, to: p.to })),
        [premoves],
    )

    return {
        // Show the projected premove chain when one is queued (it already folds in
        // the optimistic overlay as its base); otherwise the bare optimistic overlay.
        override: premoveBoard ?? override,
        optimisticLast,
        premoves: premovesOut,
        onMove,
        cancelPremove,
    }
}
