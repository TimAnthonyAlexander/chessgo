import { useEffect, useRef, useState } from 'react'
import { Box, Button, CircularProgress, Typography } from '@mui/material'
import { Check, Copy, Crown } from 'lucide-react'
import { useNavigate, useParams } from 'react-router-dom'
import { gameSocket } from '../lib/socket'
import { useGameSocket } from '../lib/useGameSocket'
import { VARIANT_LABEL } from '../lib/variants'

/** Landing page for a shared invite link (`/challenge/:code`) — also where an
 * accepted directed challenge sends its accepter (ChallengeAcceptController
 * returns a code and the caller navigates here with it). It joins by code and
 * the hub tells us which of three things happened:
 *  - `matched` — paired immediately (an ordinary WS invite, or we're the
 *    second of the two named players to arrive); enter the game.
 *  - `challengeWaiting` — a server-registered challenge where the OTHER named
 *    player hasn't shown up yet; park here and show the code/link to share.
 *  - `error` — bad/expired/not-yours code, or a stray double-join; show it
 *    with a way back to the lobby.
 */
export default function ChallengeJoin() {
    const { code = '' } = useParams()
    const navigate = useNavigate()
    const s = useGameSocket()
    const joined = useRef(false)
    const [copied, setCopied] = useState<'code' | 'link' | null>(null)

    // Fire the join exactly once on mount.
    useEffect(() => {
        if (joined.current) return
        joined.current = true
        void gameSocket.joinChallenge(code)
    }, [code])

    // When the hub matches us, enter the game.
    useEffect(() => {
        if (s.status === 'matched' && s.game) navigate(`/game/${s.game.id}`, { replace: true })
    }, [s.status, s.game?.id, navigate])

    const waiting = s.challengeWaiting
    const failed = !!s.error && s.status !== 'matched' && !waiting

    const link = waiting ? `${window.location.origin}/challenge/${waiting.code}` : ''
    const copy = async (kind: 'code' | 'link', text: string) => {
        try {
            await navigator.clipboard.writeText(text)
            setCopied(kind)
            window.setTimeout(() => setCopied(null), 1500)
        } catch {
            /* clipboard unavailable — the text is still visible to select */
        }
    }

    const leaveWaiting = () => {
        gameSocket.cancelChallenge()
        navigate('/')
    }

    return (
        <Box
            sx={{
                flex: 1,
                display: 'flex',
                flexDirection: 'column',
                alignItems: 'center',
                justifyContent: 'center',
                textAlign: 'center',
                p: 4,
                gap: 2,
            }}
        >
            {failed ? (
                <>
                    <Typography
                        sx={{ fontFamily: 'var(--font-display)', fontWeight: 700, fontSize: 22 }}
                    >
                        Couldn’t join this game
                    </Typography>
                    <Typography sx={{ color: 'var(--text-dim)', fontSize: 14, maxWidth: 360 }}>
                        {s.error ??
                            'This invite is no longer available. It may have expired or already started.'}
                    </Typography>
                    <Box sx={{ display: 'flex', gap: 1, mt: 1 }}>
                        <Button variant="contained" onClick={() => navigate('/')}>
                            Back to lobby
                        </Button>
                        <Button
                            color="inherit"
                            onClick={() => navigate('/bot')}
                            sx={{ color: 'var(--text-dim)' }}
                        >
                            Play the computer
                        </Button>
                    </Box>
                </>
            ) : waiting ? (
                <>
                    <Typography
                        sx={{ fontFamily: 'var(--font-display)', fontWeight: 700, fontSize: 22 }}
                    >
                        Waiting for the other player…
                    </Typography>
                    <Typography sx={{ color: 'var(--text-dim)', fontSize: 14, maxWidth: 360 }}>
                        You're in. The game starts the moment they join — share the code or link if
                        they need it again.
                    </Typography>

                    <Box
                        sx={{
                            display: 'flex',
                            alignItems: 'center',
                            justifyContent: 'center',
                            gap: 1,
                            py: 1.5,
                            px: 2,
                            mt: 1,
                            borderRadius: '12px',
                            bgcolor: 'var(--surface-2)',
                            border: '1px solid var(--line)',
                        }}
                    >
                        <Typography
                            sx={{
                                fontFamily: 'var(--font-mono)',
                                fontSize: 28,
                                fontWeight: 700,
                                letterSpacing: '0.14em',
                                pl: '0.14em',
                            }}
                        >
                            {waiting.code}
                        </Typography>
                        <Button
                            onClick={() => copy('code', waiting.code)}
                            size="small"
                            variant="outlined"
                            startIcon={
                                copied === 'code' ? <Check size={14} /> : <Copy size={14} />
                            }
                            sx={{
                                flexShrink: 0,
                                minWidth: 40,
                                px: 1,
                                textTransform: 'none',
                                borderColor: 'var(--line)',
                                color: copied === 'code' ? 'var(--accent)' : 'var(--text-dim)',
                            }}
                        />
                    </Box>

                    <Box
                        sx={{
                            display: 'flex',
                            alignItems: 'center',
                            gap: 1,
                            px: 1.5,
                            py: 1,
                            width: '100%',
                            maxWidth: 360,
                            borderRadius: '12px',
                            bgcolor: 'var(--surface-2)',
                            border: '1px solid var(--line)',
                        }}
                    >
                        <Typography
                            sx={{
                                flex: 1,
                                minWidth: 0,
                                fontSize: 12.5,
                                color: 'var(--text-dim)',
                                textAlign: 'left',
                                overflow: 'hidden',
                                textOverflow: 'ellipsis',
                                whiteSpace: 'nowrap',
                            }}
                        >
                            {link}
                        </Typography>
                        <Button
                            onClick={() => copy('link', link)}
                            size="small"
                            variant="outlined"
                            startIcon={
                                copied === 'link' ? <Check size={14} /> : <Copy size={14} />
                            }
                            sx={{
                                flexShrink: 0,
                                px: 1.25,
                                textTransform: 'none',
                                borderColor: 'var(--line)',
                                color: copied === 'link' ? 'var(--accent)' : 'var(--text-dim)',
                            }}
                        >
                            {copied === 'link' ? 'Copied' : 'Copy'}
                        </Button>
                    </Box>

                    <Box
                        sx={{
                            display: 'flex',
                            alignItems: 'center',
                            justifyContent: 'center',
                            gap: 1.5,
                            color: 'var(--text-dim)',
                            fontSize: 12.5,
                        }}
                    >
                        <Crown size={14} />
                        <span>{waiting.pool}</span>
                        <span>·</span>
                        <span>{waiting.rated ? 'Rated' : 'Casual'}</span>
                        {waiting.variant !== 'standard' && (
                            <>
                                <span>·</span>
                                <span>{VARIANT_LABEL[waiting.variant]}</span>
                            </>
                        )}
                    </Box>

                    <CircularProgress size={22} sx={{ color: 'var(--accent)', mt: 1 }} />

                    <Button
                        color="inherit"
                        onClick={leaveWaiting}
                        sx={{ color: 'var(--text-dim)', textTransform: 'none' }}
                    >
                        Back to lobby
                    </Button>
                </>
            ) : (
                <>
                    <CircularProgress sx={{ color: 'var(--accent)' }} />
                    <Typography
                        sx={{ fontFamily: 'var(--font-display)', fontWeight: 700, fontSize: 20 }}
                    >
                        Joining game…
                    </Typography>
                    <Typography sx={{ color: 'var(--text-dim)', fontSize: 13.5 }}>
                        Connecting you to your friend’s challenge.
                    </Typography>
                </>
            )}
        </Box>
    )
}
