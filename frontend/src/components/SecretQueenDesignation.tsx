import { useEffect, useState } from 'react'
import { Box, CircularProgress, Typography } from '@mui/material'
import { ChevronLeft, Crown, Play } from 'lucide-react'
import { ActionBtn } from './PanelUI'
import type { Square } from '../lib/chess'
import type { Color } from '../lib/socket'

/**
 * Secret Queen's pre-game designation step, shared by `/bot` and live play.
 *
 * The board IS the picker — you click one of your own pawns, not a letter in a
 * dropdown (see docs/tasks/open/secret-queen.md). `Board`'s `pickTargets`/
 * `onPick` props drive the squares; the two pieces here are the surrounding
 * copy: a ribbon over the board and the panel beside it.
 *
 * The two callers differ in exactly two ways, which is why those are props
 * rather than two copies of this file: a live game runs against a server
 * deadline and can't be backed out of, while a bot game has no clock and can.
 */

/** The eight squares `color` may designate on: its own pawns in the starting
 *  array. The server validates the choice too — this is what the board offers. */
export function secretQueenChoices(color: Color): Set<Square> {
    const rank = color === 'w' ? '2' : '7'
    return new Set('abcdefgh'.split('').map((f) => `${f}${rank}` as Square))
}

/** A random one of `color`'s eight — the "Surprise me" pick, and the same thing
 *  the server does for anyone who lets the deadline pass. */
export function randomSecretQueenSquare(color: Color): Square {
    const all = [...secretQueenChoices(color)]
    return all[Math.floor(Math.random() * all.length)]
}

/**
 * The instruction ribbon over the board. Deliberately NOT a modal: the board is
 * the control, so anything covering it would fight the interaction. It's
 * `pointer-events: none` for the same reason — every click belongs to a pawn.
 */
export function DesignationRibbon({ picked }: { picked: Square | null }) {
    return (
        <Box
            sx={{
                position: 'absolute',
                top: 0,
                left: 0,
                right: 0,
                display: 'flex',
                justifyContent: 'center',
                pointerEvents: 'none',
                zIndex: 6,
                p: 1.25,
            }}
        >
            <Box
                sx={{
                    px: 1.75,
                    py: 0.9,
                    borderRadius: 'var(--radius)',
                    bgcolor: 'rgba(16,17,21,0.86)',
                    border: '1px solid rgba(255,255,255,0.14)',
                    boxShadow: 'var(--shadow)',
                    display: 'flex',
                    alignItems: 'center',
                    gap: 0.9,
                }}
            >
                <Crown size={15} style={{ color: 'var(--accent)', flexShrink: 0 }} />
                <Typography
                    sx={{
                        fontFamily: 'var(--font-display)',
                        fontWeight: 600,
                        fontSize: 13.5,
                        color: 'var(--text)',
                        whiteSpace: 'nowrap',
                    }}
                >
                    {picked ? (
                        <>
                            <Box component="span" sx={{ fontFamily: 'var(--font-mono)' }}>
                                {picked}
                            </Box>{' '}
                            is your queen — or pick another
                        </>
                    ) : (
                        'Pick one of your pawns'
                    )}
                </Typography>
            </Box>
        </Box>
    )
}

/** Seconds left until `deadline` (epoch ms), ticking. Null deadline = untimed. */
function useCountdown(deadline: number | null): number | null {
    const [left, setLeft] = useState<number | null>(
        deadline ? Math.max(0, Math.ceil((deadline - Date.now()) / 1000)) : null,
    )
    useEffect(() => {
        if (!deadline) {
            setLeft(null)
            return
        }
        const tick = () => setLeft(Math.max(0, Math.ceil((deadline - Date.now()) / 1000)))
        tick()
        const t = window.setInterval(tick, 250)
        return () => window.clearInterval(t)
    }, [deadline])
    return left
}

/**
 * The side panel during designation. The heading carries the weight because this
 * is the only screen in the variant where you're asked to decide something
 * before a clock exists — it should feel like part of the game, not a settings
 * step.
 */
export function DesignationPanel({
    color,
    picked,
    opponentName,
    busy = false,
    deadline = null,
    onSurprise,
    onConfirm,
    onBack,
}: {
    color: Color
    picked: Square | null
    /** Who is choosing on the other side — "Zugzwang" against the bot, the
     *  opponent's name in a live game. */
    opponentName: string
    busy?: boolean
    /** Epoch ms the server will choose for you at, or null when untimed. */
    deadline?: number | null
    onSurprise: () => void
    onConfirm: () => void
    /** Omitted in live play: once you're paired there is nothing to go back to. */
    onBack?: () => void
}) {
    const left = useCountdown(deadline)
    return (
        <Box
            sx={{
                bgcolor: 'var(--surface)',
                border: '1px solid var(--line-soft)',
                borderRadius: 'var(--radius)',
                p: 2.75,
                display: 'flex',
                flexDirection: 'column',
                gap: 2,
                boxShadow: 'var(--shadow)',
            }}
        >
            <Box>
                <Typography
                    sx={{
                        fontFamily: 'var(--font-display)',
                        fontSize: 24,
                        fontWeight: 700,
                        lineHeight: 1.1,
                    }}
                >
                    Choose your secret queen
                </Typography>
                <Typography sx={{ fontSize: 13.5, color: 'var(--text-dim)', mt: 0.75 }}>
                    Click one of your eight pawns. It moves like a queen, but {opponentName} sees
                    an ordinary pawn until the first move only a queen could make.
                </Typography>
                <Typography sx={{ fontSize: 12.5, color: 'var(--muted)', mt: 1 }}>
                    You&apos;re playing {color === 'w' ? 'White' : 'Black'}. {opponentName} is
                    choosing one too, and you won&apos;t be told which.
                </Typography>
                {left != null && (
                    <Typography
                        sx={{
                            fontFamily: 'var(--font-mono)',
                            fontSize: 12.5,
                            color: left <= 5 ? 'var(--accent)' : 'var(--muted)',
                            mt: 1,
                        }}
                    >
                        {left > 0
                            ? `${left}s — after that one is picked for you`
                            : 'Picking one for you…'}
                    </Typography>
                )}
            </Box>

            <Box sx={{ display: 'flex', flexDirection: 'column', gap: 1 }}>
                <ActionBtn
                    tone="primary"
                    large
                    disabled={!picked || busy}
                    icon={busy ? <CircularProgress size={16} color="inherit" /> : <Play size={16} />}
                    label={
                        busy
                            ? 'Starting…'
                            : picked
                              ? `Confirm ${picked}`
                              : 'Pick a pawn to continue'
                    }
                    onClick={onConfirm}
                />
                <Box sx={{ display: 'flex', gap: 1 }}>
                    <ActionBtn
                        tone="neutral"
                        icon={<Crown size={15} />}
                        label="Surprise me"
                        disabled={busy}
                        onClick={onSurprise}
                    />
                    {onBack && (
                        <ActionBtn
                            tone="neutral"
                            icon={<ChevronLeft size={15} />}
                            label="Back"
                            disabled={busy}
                            onClick={onBack}
                        />
                    )}
                </Box>
            </Box>
        </Box>
    )
}
