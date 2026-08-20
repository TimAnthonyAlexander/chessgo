import { Box, Dialog, DialogContent, Typography } from '@mui/material'
import { Check, X } from 'lucide-react'
import { useNavigate } from 'react-router-dom'
import { ActionBtn } from './PanelUI'
import { gameSocket, type LiveGameState } from '../lib/socket'

// The result used to live ONLY as a small line in the side panel plus a sound —
// an opponent's resignation was silent unless you happened to be looking at the
// panel instead of the board. This is the unmissable version: a modal centered
// over the page the instant `g.ended` flips, with every post-game action inline
// so dismissing it never costs you a way to act on the result.
//
// Controlled, like ConfirmDialog: LiveGame owns `open` (keyed + latched per game
// id so a dismissal sticks and a rematch's new game opens fresh — see the
// dismissal state next to where this is rendered) and this component just
// renders what `g` says right now.

// Split out of `resultText`/`reasonText` at the bottom of LiveGame.tsx rather
// than reshaping those two — Spectate.tsx and BotGame.tsx carry their own
// copies of that combined-string pair and must not be disturbed. This modal
// wants the headline and the method on separate lines, so it gets its own pair.
function headline(g: LiveGameState): string {
    if (g.reason === 'aborted' || g.status === 'aborted') return 'Game aborted'
    if (g.result === '1/2-1/2') return 'Draw'
    if (g.result === '1-0' || g.result === '0-1') {
        const winner = g.result === '1-0' ? 'w' : 'b'
        return winner === g.color ? 'You won' : 'You lost'
    }
    return 'Game over'
}

// Every reason string the hub/engine actually sends (confirmed against
// gomachine/internal/hub — hub.go, presence.go — and the per-variant terminal
// states in internal/engine + internal/variant). Anything not listed here
// (a variant's own dynamic terminalReason(), a future addition, or simply
// null) falls through to `null` — no method line rather than a raw slug like
// "draw-move-cap" on screen.
function method(reason: string | null): string | null {
    switch (reason) {
        case 'checkmate':
            return 'by checkmate'
        case 'resign':
            return 'by resignation'
        case 'timeout':
            return 'on time'
        // A draw despite the flag falling — "on time" alone would read as a loss.
        case 'timeout-insufficient-material':
            return 'on time · insufficient material'
        case 'abandon':
            return 'by abandonment'
        case 'abandon-insufficient-material':
            return 'by abandonment · insufficient material'
        case 'agreement':
            return 'by agreement'
        case 'stalemate':
            return 'by stalemate'
        case 'draw-insufficient-material':
            return 'insufficient material'
        case 'draw-fivefold':
            return 'by repetition'
        case 'draw-seventyfive':
            return 'by the 75-move rule'
        // Secret Queen's win-by-capturing-the-king condition.
        case 'king-capture':
            return 'by king capture'
        default:
            return null
    }
}

export default function GameOverModal({
    open,
    g,
    ratingDelta,
    onClose,
}: {
    open: boolean
    g: LiveGameState
    /** Same shape/lifetime as LiveGame's own state: null until the persisted
     *  Game record shows up (up to ~8×600ms after `ended`), keyed by id so a
     *  stale delta from the previous game can never render here. */
    ratingDelta: { id: string; after: number; delta: number } | null
    onClose: () => void
}) {
    const navigate = useNavigate()
    const aborted = g.reason === 'aborted' || g.status === 'aborted'
    const delta = g.rated && ratingDelta && ratingDelta.id === g.id ? ratingDelta : null
    const how = method(g.reason)

    const newGame = () => {
        gameSocket.queue(g.pool)
        navigate('/')
    }

    return (
        <Dialog
            open={open}
            onClose={onClose}
            slotProps={{
                paper: {
                    sx: {
                        bgcolor: 'var(--surface)',
                        border: '1px solid var(--line)',
                        borderRadius: 'var(--radius)',
                        // MUI's Dialog paper ships elevation 24, i.e. a real drop
                        // shadow, which this palette has no language for: surfaces
                        // here are separated by a hairline and a change of colour,
                        // never by floating. Routed through the token like every
                        // other surface (PanelUI's PANEL_SHADOW is the same var)
                        // so it follows --shadow if that ever stops being `none`.
                        boxShadow: 'var(--shadow)',
                        width: '92vw',
                        maxWidth: 420,
                    },
                },
            }}
        >
            <DialogContent sx={{ p: 3, position: 'relative' }}>
                <Box
                    component="button"
                    onClick={onClose}
                    aria-label="Close"
                    sx={{
                        position: 'absolute',
                        top: 12,
                        right: 12,
                        width: 28,
                        height: 28,
                        display: 'flex',
                        alignItems: 'center',
                        justifyContent: 'center',
                        border: 'none',
                        borderRadius: 'var(--radius)',
                        bgcolor: 'transparent',
                        color: 'var(--text-dim)',
                        cursor: 'pointer',
                        transition: 'background-color .15s, color .15s',
                        '&:hover': { bgcolor: 'var(--line)', color: 'var(--text)' },
                    }}
                >
                    <X size={16} />
                </Box>

                <Typography
                    sx={{
                        fontFamily: 'var(--font-display)',
                        fontWeight: 600,
                        fontSize: 26,
                        textAlign: 'center',
                        mt: 0.5,
                    }}
                >
                    {headline(g)}
                </Typography>

                {how && (
                    <Typography
                        sx={{
                            fontFamily: 'var(--font-ui)',
                            fontSize: 14,
                            color: 'var(--text-dim)',
                            textAlign: 'center',
                            mt: 0.5,
                        }}
                    >
                        {how}
                    </Typography>
                )}

                {/* Reserved from the FIRST render, not just once a delta arrives — the
                    delta lands up to ~5s after `ended` (ratedRefresh's poll loop in
                    LiveGame.tsx), and this modal is very likely still open when it does.
                    A height that appears out of nowhere shifts the button row that's
                    sitting right under it — chess.com does exactly this and it's a real,
                    sourced complaint (a button moving under the reader's cursor). Fixed
                    minHeight instead of conditional height keeps the row still either way.
                    Unrated games render nothing here (no reserved gap either — there is
                    never a delta coming). */}
                {g.rated && (
                    <Box
                        sx={{
                            minHeight: 28,
                            mt: 1,
                            display: 'flex',
                            alignItems: 'baseline',
                            justifyContent: 'center',
                            gap: 1,
                        }}
                    >
                        {delta && (
                            <>
                                <Typography
                                    sx={{
                                        fontFamily: 'var(--font-mono)',
                                        fontSize: 16,
                                        fontWeight: 700,
                                        color: 'var(--text)',
                                    }}
                                >
                                    {delta.after}
                                </Typography>
                                <Typography
                                    sx={{
                                        fontFamily: 'var(--font-mono)',
                                        fontSize: 14,
                                        fontWeight: 700,
                                        color:
                                            delta.delta > 0
                                                ? 'var(--good)'
                                                : delta.delta < 0
                                                  ? 'var(--bad)'
                                                  : 'var(--text-dim)',
                                    }}
                                >
                                    {delta.delta > 0 ? '+' : ''}
                                    {delta.delta}
                                </Typography>
                            </>
                        )}
                    </Box>
                )}

                {/* One row, every path forward. A pending rematch offer FROM them is a
                    decision, not an action — it takes the lead cell's place as an inline
                    Accept/Decline pair rather than a separate floating banner stacked on
                    top of this modal (two overlays fighting for attention is worse than
                    one). Wraps on narrow viewports instead of overflowing; ActionBtn
                    itself already ellipsises a label that doesn't fit its cell. */}
                <Box sx={{ display: 'flex', flexWrap: 'wrap', gap: 1, mt: 2.5 }}>
                    {g.rematchOffer === 'theirs' ? (
                        <>
                            <ActionBtn
                                tone="primary"
                                icon={<Check size={15} />}
                                label="Accept"
                                onClick={() => gameSocket.acceptRematch()}
                            />
                            <ActionBtn
                                tone="neutral"
                                icon={<X size={15} />}
                                label="Decline"
                                onClick={() => gameSocket.declineRematch()}
                            />
                        </>
                    ) : (
                        <ActionBtn
                            tone="primary"
                            label={g.rematchOffer === 'mine' ? 'Offered…' : 'Rematch'}
                            onClick={() =>
                                g.rematchOffer === 'mine'
                                    ? gameSocket.cancelRematch()
                                    : gameSocket.offerRematch()
                            }
                        />
                    )}
                    <ActionBtn tone="neutral" label="New game" onClick={newGame} />
                    {/* An abort never produced a game worth replaying. */}
                    {!aborted && (
                        <ActionBtn
                            tone="neutral"
                            label="Analyse"
                            onClick={() => navigate(`/analysis/${g.id}`)}
                        />
                    )}
                </Box>
            </DialogContent>
        </Dialog>
    )
}
