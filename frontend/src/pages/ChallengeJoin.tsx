import { useEffect, useRef } from 'react'
import { Box, Button, CircularProgress, Typography } from '@mui/material'
import { useNavigate, useParams } from 'react-router-dom'
import { gameSocket } from '../lib/socket'
import { useGameSocket } from '../lib/useGameSocket'

/** Landing page for a shared invite link (`/challenge/:code`). It joins the
 * friend's private game by code; once the hub pairs us we route into the live
 * game. A bad/expired code surfaces an error with a way back home. */
export default function ChallengeJoin() {
    const { code = '' } = useParams()
    const navigate = useNavigate()
    const s = useGameSocket()
    const joined = useRef(false)

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

    const failed = !!s.error && s.status !== 'matched'

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
